"""Browser conversation ownership and the bridge to the local Pipiclaw socket."""

import asyncio
from contextlib import asynccontextmanager, closing
import hashlib
import ipaddress
import os
from pathlib import Path
import re
from secrets import token_urlsafe
import sqlite3
from time import time
from urllib.parse import urlsplit

from anyio import CancelScope
import httpx
from starlette.responses import JSONResponse, StreamingResponse

from http_support import ClientStream, error, read_json

SESSION_SECONDS = 365 * 24 * 3600
RENEW_WINDOW = 30 * 24 * 3600
CONVERSATION_ID = re.compile(r"conv_[a-f0-9]{32}")
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
UNAVAILABLE = "Turnline 无法连接 Pipiclaw，请检查服务端连接。"


def digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def default_socket():
    return Path(os.environ.get("PIPICLAW_HOME", Path.home() / ".pipiclaw")) / "state/webapi/api.sock"


def default_state():
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "turnline"


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except (ValueError, TypeError):
        return False


def normalize_origin(value):
    if any(char.isspace() or char in "\\%?#" for char in value):
        raise ValueError("Use an HTTP(S) origin without a path or credentials.")
    url = urlsplit(value)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username is not None
            or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("Use an HTTP(S) origin without a path or credentials.")
    if url.scheme == "http" and not loopback(url.hostname):
        raise ValueError("Use HTTPS for a non-loopback public origin.")
    if ":" in url.hostname:
        host = f"[{ipaddress.IPv6Address(url.hostname).compressed}]"
    else:
        host = url.hostname.encode("idna").decode("ascii").lower()
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9.])?", host):
            raise ValueError("Invalid host.")
    port = url.port
    if port not in {None, 443 if url.scheme == "https" else 80}:
        host += f":{port}"
    return f"{url.scheme}://{host}"


class SessionStore:
    def __init__(self, directory):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "devices.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        with closing(self.open()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, expires INTEGER);
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE
                );
            """)

    def open(self):
        db = sqlite3.connect(self.path, timeout=2)
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def start(self, token):
        """Return a cookie to set, or None if the browser's cookie is current."""
        now = int(time())
        with closing(self.open()) as db, db:
            if token and TOKEN.fullmatch(token):
                identity = digest(token)
                row = db.execute("SELECT expires FROM devices WHERE id = ?", (identity,)).fetchone()
                if row:
                    if row[0] > now + RENEW_WINDOW:
                        return None
                    db.execute("UPDATE devices SET expires = ? WHERE id = ?", (now + SESSION_SECONDS, identity))
                    return token
            token = token_urlsafe(32)
            db.execute("INSERT INTO devices VALUES (?, ?)", (digest(token), now + SESSION_SECONDS))
            return token

    def identity(self, token):
        if not token or not TOKEN.fullmatch(token):
            return None
        identity = digest(token)
        with closing(self.open()) as db:
            row = db.execute("SELECT 1 FROM devices WHERE id = ? AND expires > ?", (identity, int(time()))).fetchone()
        return identity if row else None

    def own(self, conversation, device):
        with closing(self.open()) as db, db:
            result = db.execute(
                "INSERT INTO conversations SELECT ?, id FROM devices WHERE id = ? AND expires > ?",
                (conversation, device, int(time())),
            )
            return bool(result.rowcount)

    def owns(self, conversation, device):
        if not isinstance(conversation, str) or not CONVERSATION_ID.fullmatch(conversation):
            return False
        with closing(self.open()) as db:
            return db.execute("SELECT 1 FROM conversations WHERE id = ? AND device = ?",
                              (conversation, device)).fetchone() is not None


def session_cookie(request):
    secure = request.scope["turnline.origin"].startswith("https:")
    return ("__Host-turnline" if secure else "turnline"), secure


class Pipiclaw:
    def __init__(self, socket_path, sessions):
        self.sessions = sessions
        self.client = httpx.AsyncClient(
            base_url="http://localhost/v1",
            transport=httpx.AsyncHTTPTransport(uds=str(socket_path), limits=httpx.Limits(max_connections=24)),
            timeout=httpx.Timeout(90, connect=5, pool=5),
            trust_env=False,
        )

    async def status(self):
        try:
            upstream = await self.client.get("/models/pipiclaw", timeout=3)
            return "ready" if upstream.status_code == 200 else "offline"
        except httpx.RequestError:
            return "offline"

    @staticmethod
    def failure(upstream):
        if upstream.is_success:
            return None
        if upstream.status_code == 404:
            return error("Pipiclaw 找不到此会话。请开始新对话。", 404)
        if upstream.status_code in {409, 429}:
            response = error("Pipiclaw 正忙，请稍候重试。", upstream.status_code)
            if "retry-after" in upstream.headers:
                response.headers["Retry-After"] = upstream.headers["retry-after"]
            return response
        return error(UNAVAILABLE, 503)

    async def create_conversation(self, device):
        try:
            upstream = await self.client.post("/conversations", json={})
            if failed := self.failure(upstream):
                return failed
            payload = upstream.json()
        except (httpx.RequestError, ValueError):
            return error(UNAVAILABLE, 503)
        conversation = payload.get("id") if isinstance(payload, dict) else None
        if not isinstance(conversation, str) or not CONVERSATION_ID.fullmatch(conversation):
            return error("Pipiclaw 未返回有效的会话。请重试。", 502)
        if not await asyncio.to_thread(self.sessions.own, conversation, device):
            return error("浏览器会话已过期，请刷新页面后重试。", 401)
        return JSONResponse({"id": conversation})

    async def conversation_items(self, request, conversation, device):
        if not await asyncio.to_thread(self.sessions.owns, conversation, device):
            return error("找不到此设备的会话。请开始新对话。", 404)
        params = {key: request.query_params[key] for key in ("after", "limit", "order") if key in request.query_params}
        try:
            upstream = await self.client.get(f"/conversations/{conversation}/items", params=params)
            return self.failure(upstream) or JSONResponse(upstream.json())
        except (httpx.RequestError, ValueError):
            return error(UNAVAILABLE, 503)

    async def responses(self, request, device):
        candidate = await read_json(request)
        if not isinstance(candidate, dict):
            return error("请发送有效的对话内容。")
        conversation, message = candidate.get("conversation"), candidate.get("input")
        if not await asyncio.to_thread(self.sessions.owns, conversation, device):
            return error("找不到此设备的会话。请开始新对话。", 404)
        if not isinstance(message, str) or not 0 < len(message.strip()) <= 12_000:
            return error("请发送 1 至 12000 字的消息。")
        body = {"conversation": conversation, "model": "pipiclaw", "input": message, "stream": True}
        instructions = candidate.get("instructions")
        if isinstance(instructions, str) and len(instructions) <= 8_000:
            body["instructions"] = instructions

        @asynccontextmanager
        async def prepare():
            try:
                upstream = await self.client.send(self.client.build_request("POST", "/responses", json=body), stream=True)
            except httpx.RequestError:
                yield error(UNAVAILABLE, 503)
                return
            try:
                if failed := self.failure(upstream):
                    yield failed
                elif upstream.headers.get("content-type", "").partition(";")[0].lower() != "text/event-stream":
                    yield error("Pipiclaw 未返回流式响应。请重试。", 502)
                else:
                    yield StreamingResponse(upstream.aiter_bytes(), media_type="text/event-stream",
                                            headers={"X-Accel-Buffering": "no"})
            finally:
                with CancelScope(shield=True):
                    await upstream.aclose()

        return ClientStream(prepare)
