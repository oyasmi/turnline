"""Device pairing and the same-origin bridge to the local Pipiclaw socket."""

import hashlib
import ipaddress
import os
from contextlib import closing
from pathlib import Path
import re
from secrets import token_urlsafe
import sqlite3
from time import time
from urllib.parse import urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, UnixConnector, web

PAIR_SECONDS = 15 * 60
DEVICE_SECONDS = 7 * 24 * 3600
CONVERSATION_ID = re.compile(r"conv_[a-f0-9]{32}")
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
UNAVAILABLE = "本机 Pipiclaw 暂不可用。请在服务器启动 Pipiclaw，然后重试。"


def error(message, status):
    return web.json_response({"error": {"message": message}}, status=status)


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
    except ValueError:
        return False


def normalize_origin(value):
    url = urlsplit(value)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username is not None
            or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("Use an HTTP(S) origin without a path or credentials.")
    if url.scheme == "http" and not loopback(url.hostname):
        raise ValueError("Use HTTPS for a non-loopback public origin.")
    host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
    port = url.port
    if port not in {None, 443 if url.scheme == "https" else 80}:
        host += f":{port}"
    return f"{url.scheme}://{host}"


class DeviceStore:
    def __init__(self, directory):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "devices.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        with closing(self.open()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS pairing (token TEXT PRIMARY KEY, expires INTEGER);
                CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, expires INTEGER);
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE
                );
            """)

    def open(self):
        db = sqlite3.connect(self.path, timeout=2)
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def issue(self):
        token = token_urlsafe(32)
        now = int(time())
        with closing(self.open()) as db, db:
            db.execute("DELETE FROM pairing WHERE expires <= ?", (now,))
            db.execute("DELETE FROM devices WHERE expires <= ?", (now,))
            db.execute("INSERT INTO pairing VALUES (?, ?)", (digest(token), now + PAIR_SECONDS))
        return token

    def redeem(self, token, previous=None):
        if not isinstance(token, str) or not TOKEN.fullmatch(token):
            return None
        session = token_urlsafe(32)
        now = int(time())
        with closing(self.open()) as db, db:
            deleted = db.execute("DELETE FROM pairing WHERE token = ? AND expires > ?", (digest(token), now))
            if not deleted.rowcount:
                return None
            if previous and TOKEN.fullmatch(previous):
                renewed = db.execute("UPDATE devices SET expires = ? WHERE id = ? AND expires > ?",
                                     (now + DEVICE_SECONDS, digest(previous), now))
                if renewed.rowcount:
                    return previous
            db.execute("INSERT INTO devices VALUES (?, ?)", (digest(session), now + DEVICE_SECONDS))
        return session

    def device(self, token):
        if not token or not TOKEN.fullmatch(token):
            return None
        identity = digest(token)
        with closing(self.open()) as db:
            row = db.execute("SELECT 1 FROM devices WHERE id = ? AND expires > ?", (identity, int(time()))).fetchone()
        return identity if row else None

    def revoke(self, device):
        with closing(self.open()) as db, db:
            db.execute("DELETE FROM devices WHERE id = ?", (device,))

    def own(self, conversation, device):
        with closing(self.open()) as db, db:
            db.execute("INSERT INTO conversations VALUES (?, ?)", (conversation, device))

    def owns(self, conversation, device):
        if not isinstance(conversation, str) or not CONVERSATION_ID.fullmatch(conversation):
            return False
        with closing(self.open()) as db:
            return db.execute("SELECT 1 FROM conversations WHERE id = ? AND device = ?",
                              (conversation, device)).fetchone() is not None


class Pipiclaw:
    def __init__(self, socket_path, devices, origin):
        self.socket_path = socket_path
        self.devices = devices
        self.secure = origin.startswith("https:")
        self.cookie = "__Host-turnline" if self.secure else "turnline"

    async def connect(self, _app):
        async with ClientSession(
            connector=UnixConnector(path=str(self.socket_path), limit=24),
            timeout=ClientTimeout(total=None, connect=5, sock_read=90),
            trust_env=False,
        ) as self.client:
            yield

    def device(self, request):
        return self.devices.device(request.cookies.get(self.cookie))

    async def status(self, request):
        if not self.device(request):
            return web.json_response({"connection": "pair"})
        try:
            async with self.client.get("http://localhost/v1/models/pipiclaw",
                                       timeout=ClientTimeout(total=3), allow_redirects=False) as upstream:
                return web.json_response({"connection": "ready" if upstream.status == 200 else "offline"})
        except (ClientError, TimeoutError):
            return web.json_response({"connection": "offline"})

    async def pair(self, request):
        try:
            body = await request.json()
            token = body.get("token") if isinstance(body, dict) else None
            session = self.devices.redeem(token, request.cookies.get(self.cookie))
        except ValueError:
            session = None
        if session is None:
            return error("配对链接已使用或失效。请在 Turnline 服务器生成新的配对链接。", 401)
        response = web.Response(status=204)
        response.set_cookie(self.cookie, session, path="/", max_age=DEVICE_SECONDS,
                            secure=self.secure, httponly=True, samesite="Strict")
        return response

    async def sign_out(self, request):
        device = self.device(request)
        if device:
            self.devices.revoke(device)
        response = web.Response(status=204)
        response.del_cookie(self.cookie, path="/", secure=self.secure, httponly=True, samesite="Strict")
        return response

    async def relay(self, request):
        device = self.device(request)
        if not device:
            return error("请用服务器生成的配对链接连接此浏览器。", 401)

        route = request.match_info.route.name
        body = None
        params = None
        if route == "create-conversation":
            endpoint = "/v1/conversations"
            body = {}
        elif route == "conversation-items":
            conversation = request.match_info["conversation"]
            if not self.devices.owns(conversation, device):
                return error("找不到此设备的会话。请开始新对话。", 404)
            endpoint = f"/v1/conversations/{conversation}/items"
            params = {key: request.query[key] for key in ("after", "limit", "order") if key in request.query}
        else:
            try:
                candidate = await request.json()
            except ValueError:
                return error("请发送有效的对话内容。", 400)
            if not isinstance(candidate, dict):
                return error("请发送有效的对话内容。", 400)
            conversation, message = candidate.get("conversation"), candidate.get("input")
            if not self.devices.owns(conversation, device):
                return error("找不到此设备的会话。请开始新对话。", 404)
            if not isinstance(message, str) or not 0 < len(message.strip()) <= 12_000:
                return error("请发送 1 至 12000 字的消息。", 400)
            endpoint = "/v1/responses"
            body = {"conversation": conversation, "model": "pipiclaw", "input": message, "stream": True}
            instructions = candidate.get("instructions")
            if isinstance(instructions, str) and len(instructions) <= 8_000:
                body["instructions"] = instructions

        stream = None
        try:
            async with self.client.request(request.method, "http://localhost" + endpoint, json=body,
                                           params=params, allow_redirects=False) as upstream:
                if 300 <= upstream.status < 400:
                    return error(UNAVAILABLE, 503)
                if upstream.status >= 400:
                    if upstream.status == 404:
                        return error("Pipiclaw 找不到此会话。请开始新对话。", 404)
                    if upstream.status in {409, 429}:
                        return error("Pipiclaw 正忙，请稍候重试。", upstream.status)
                    return error(UNAVAILABLE, 503)
                if route == "create-conversation":
                    payload = await upstream.json()
                    conversation = payload.get("id") if isinstance(payload, dict) else None
                    if not isinstance(conversation, str) or not CONVERSATION_ID.fullmatch(conversation):
                        return error("Pipiclaw 未返回有效的会话。请重试。", 502)
                    self.devices.own(conversation, device)
                    return web.json_response({"id": conversation})
                if route == "conversation-items":
                    return web.json_response(await upstream.json())
                if upstream.content_type != "text/event-stream":
                    return error("Pipiclaw 未返回语音通话需要的响应流。请重试。", 502)
                stream = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                await stream.prepare(request)
                async for chunk in upstream.content.iter_any():
                    await stream.write(chunk)
                await stream.write_eof()
                return stream
        except (ClientError, TimeoutError, ValueError):
            if stream is not None and stream.prepared:
                if request.transport:
                    request.transport.close()
                raise ConnectionResetError("Pipiclaw SSE disconnected") from None
            return error(UNAVAILABLE, 503)
