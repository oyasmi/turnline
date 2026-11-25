"""Browser conversation ownership and the bridge to the local Pipiclaw socket."""

import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager, closing
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
from secrets import token_urlsafe
import sqlite3
from time import time
from urllib.parse import urlsplit

from anyio import CancelScope
from fastapi import WebSocketDisconnect
import httpx
from starlette.responses import JSONResponse, StreamingResponse
from websockets.asyncio.client import unix_connect
from websockets.exceptions import ConnectionClosed

from .http_support import ClientStream, error, read_json

SESSION_SECONDS = 365 * 24 * 3600
RENEW_WINDOW = 30 * 24 * 3600
CONVERSATION_ID = re.compile(r"conv_[a-f0-9]{32}")
RESPONSE_ID = re.compile(r"resp_[a-f0-9]{32}")
STREAM_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
CONVERSATION_PAGE_SIZE = 12
MAX_TRACKED_RESPONSES = 512
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
                CREATE INDEX IF NOT EXISTS conversations_by_device ON conversations (device);
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

    def forget(self, conversation, device):
        if not isinstance(conversation, str) or not CONVERSATION_ID.fullmatch(conversation):
            return False
        with closing(self.open()) as db, db:
            result = db.execute("DELETE FROM conversations WHERE id = ? AND device = ?", (conversation, device))
            return bool(result.rowcount)

    def list_conversations(self, device, after=None):
        with closing(self.open()) as db:
            rows = db.execute("""
                SELECT id FROM conversations
                WHERE device = ? AND (
                    ? IS NULL OR rowid < (SELECT rowid FROM conversations WHERE id = ? AND device = ?)
                )
                ORDER BY rowid DESC LIMIT ?
            """, (device, after, after, device, CONVERSATION_PAGE_SIZE + 1)).fetchall()
        return {"data": [row[0] for row in rows[:CONVERSATION_PAGE_SIZE]],
                "has_more": len(rows) > CONVERSATION_PAGE_SIZE}


def session_cookie(request):
    secure = request.scope["turnline.origin"].startswith("https:")
    return ("__Host-turnline" if secure else "turnline"), secure


def _clean_metadata(value):
    if not isinstance(value, dict) or len(value) > 16:
        return None
    cleaned = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not 0 < len(key) <= 64 or not isinstance(entry, str) or len(entry) > 512:
            return None
        cleaned[key] = entry
    return cleaned


def _ws_error(code, message, status=400, stream_id=None):
    payload = {
        "type": "error",
        "status": status,
        "error": {"type": "invalid_request_error" if status < 500 else "server_error",
                  "code": code, "message": message, "param": None},
    }
    if stream_id:
        payload["stream_id"] = stream_id
    return json.dumps(payload, ensure_ascii=False)


class Pipiclaw:
    def __init__(self, socket_path, sessions):
        self.socket_path = Path(socket_path)
        self.sessions = sessions
        self._responses = OrderedDict()
        self.client = httpx.AsyncClient(
            base_url="http://localhost/v1",
            transport=httpx.AsyncHTTPTransport(uds=str(socket_path), limits=httpx.Limits(max_connections=24)),
            timeout=httpx.Timeout(90, connect=5, pool=5),
            trust_env=False,
        )

    def _track_response(self, response_id, device):
        if not isinstance(response_id, str) or not RESPONSE_ID.fullmatch(response_id):
            return
        self._responses[response_id] = device
        self._responses.move_to_end(response_id)
        while len(self._responses) > MAX_TRACKED_RESPONSES:
            self._responses.popitem(last=False)

    def _owns_response(self, response_id, device):
        return isinstance(response_id, str) and RESPONSE_ID.fullmatch(response_id) and self._responses.get(response_id) == device

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
        if upstream.status_code == 409:
            return error("该会话仍有任务在进行中，请先停止或稍候重试。", 409)
        if upstream.status_code == 429:
            response = error("Pipiclaw 正忙，请稍候重试。", 429)
            if "retry-after" in upstream.headers:
                response.headers["Retry-After"] = upstream.headers["retry-after"]
            return response
        return error(UNAVAILABLE, 503)

    async def create_conversation(self, device, request=None):
        payload_in = {}
        if request is not None:
            candidate = await read_json(request, allow_empty=True)
            if isinstance(candidate, dict) and candidate.get("metadata") is not None:
                cleaned = _clean_metadata(candidate.get("metadata"))
                if cleaned is None:
                    return error("会话 metadata 格式无效。")
                payload_in["metadata"] = cleaned
        try:
            upstream = await self.client.post("/conversations", json=payload_in)
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
        result = {"id": conversation}
        if isinstance(payload.get("metadata"), dict):
            result["metadata"] = payload["metadata"]
        return JSONResponse(result)

    async def get_conversation(self, conversation, device):
        if not await asyncio.to_thread(self.sessions.owns, conversation, device):
            return error("找不到此设备的会话。请开始新对话。", 404)
        try:
            upstream = await self.client.get(f"/conversations/{conversation}")
            return self.failure(upstream) or JSONResponse(upstream.json())
        except (httpx.RequestError, ValueError):
            return error(UNAVAILABLE, 503)

    async def update_conversation(self, request, conversation, device):
        if not await asyncio.to_thread(self.sessions.owns, conversation, device):
            return error("找不到此设备的会话。请开始新对话。", 404)
        candidate = await read_json(request)
        cleaned = _clean_metadata(candidate.get("metadata")) if isinstance(candidate, dict) else None
        if cleaned is None:
            return error("请提供有效的会话 metadata。")
        try:
            upstream = await self.client.post(f"/conversations/{conversation}", json={"metadata": cleaned})
            return self.failure(upstream) or JSONResponse(upstream.json())
        except (httpx.RequestError, ValueError):
            return error(UNAVAILABLE, 503)

    async def delete_conversation(self, conversation, device):
        if not await asyncio.to_thread(self.sessions.owns, conversation, device):
            return error("找不到此设备的会话。", 404)
        try:
            upstream = await self.client.delete(f"/conversations/{conversation}")
        except httpx.RequestError:
            return error(UNAVAILABLE, 503)
        if upstream.status_code == 409:
            return self.failure(upstream)
        if not upstream.is_success and upstream.status_code != 404:
            return self.failure(upstream)
        await asyncio.to_thread(self.sessions.forget, conversation, device)
        return JSONResponse({"id": conversation, "object": "conversation.deleted", "deleted": True})

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
        if candidate.get("background") is True:
            body["background"] = True
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
                    async def stream_bytes():
                        tracked = False
                        buf = ""
                        async for chunk in upstream.aiter_bytes():
                            if not tracked:
                                buf += chunk.decode("utf-8", errors="ignore")
                                match = RESPONSE_ID.search(buf)
                                if match:
                                    self._track_response(match.group(0), device)
                                    tracked = True
                                elif len(buf) > 4096:
                                    tracked = True
                            yield chunk
                    yield StreamingResponse(stream_bytes(), media_type="text/event-stream",
                                            headers={"X-Accel-Buffering": "no"})
            finally:
                with CancelScope(shield=True):
                    await upstream.aclose()

        return ClientStream(prepare)

    async def retrieve_response(self, request, response_id, device):
        if not self._owns_response(response_id, device):
            return error("找不到此响应。", 404)
        params = {}
        stream = request.query_params.get("stream") == "true"
        if stream:
            params["stream"] = "true"
        starting_after = request.query_params.get("starting_after")
        if starting_after is not None:
            if not starting_after.isdigit():
                return error("无效的 starting_after 参数。")
            params["starting_after"] = starting_after
        if not stream:
            try:
                upstream = await self.client.get(f"/responses/{response_id}", params=params)
                return self.failure(upstream) or JSONResponse(upstream.json())
            except (httpx.RequestError, ValueError):
                return error(UNAVAILABLE, 503)

        @asynccontextmanager
        async def prepare():
            try:
                upstream = await self.client.send(
                    self.client.build_request("GET", f"/responses/{response_id}", params=params), stream=True
                )
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

    async def cancel_response(self, response_id, device):
        if not self._owns_response(response_id, device):
            return error("找不到此响应。", 404)
        try:
            upstream = await self.client.post(f"/responses/{response_id}/cancel")
            return self.failure(upstream) or JSONResponse(upstream.json())
        except (httpx.RequestError, ValueError):
            return error(UNAVAILABLE, 503)

    async def responses_ws(self, ws, device):
        await ws.accept()
        try:
            upstream = await unix_connect(str(self.socket_path), uri="ws://localhost/v1/responses",
                                          max_size=2 * 1024 * 1024, open_timeout=5)
        except OSError:
            await ws.send_text(_ws_error("upstream_unavailable", UNAVAILABLE, 503))
            await ws.close(code=1011)
            return

        async def from_browser():
            while True:
                raw = await ws.receive_text()
                try:
                    event = json.loads(raw)
                except ValueError:
                    await ws.send_text(_ws_error("invalid_json", "消息必须是 JSON 对象。"))
                    continue
                if not isinstance(event, dict):
                    await ws.send_text(_ws_error("invalid_json", "消息必须是 JSON 对象。"))
                    continue
                kind = event.get("type")
                stream_id = event.get("stream_id")
                if stream_id is not None and (not isinstance(stream_id, str) or not STREAM_ID.fullmatch(stream_id)):
                    await ws.send_text(_ws_error("invalid_stream_id", "无效的 stream_id。"))
                    continue
                if kind == "response.create":
                    conversation = event.get("conversation")
                    message = event.get("input")
                    if not await asyncio.to_thread(self.sessions.owns, conversation, device):
                        await ws.send_text(_ws_error("not_found", "找不到此设备的会话。", 404, stream_id))
                        continue
                    if not isinstance(message, str) or not 0 < len(message.strip()) <= 12_000:
                        await ws.send_text(_ws_error("invalid_value", "请发送 1 至 12000 字的消息。", 400, stream_id))
                        continue
                    forwarded = {
                        "type": "response.create",
                        "model": "pipiclaw",
                        "conversation": conversation,
                        "input": message,
                    }
                    instructions = event.get("instructions")
                    if isinstance(instructions, str) and len(instructions) <= 8_000:
                        forwarded["instructions"] = instructions
                    if stream_id:
                        forwarded["stream_id"] = stream_id
                    await upstream.send(json.dumps(forwarded, ensure_ascii=False))
                elif kind == "response.steer":
                    target = event.get("previous_response_id")
                    message = event.get("input")
                    if not isinstance(target, str) or not RESPONSE_ID.fullmatch(target):
                        await ws.send_text(_ws_error("invalid_value", "无效的 previous_response_id。", 400, stream_id))
                        continue
                    if not isinstance(message, str) or not 0 < len(message.strip()) <= 12_000:
                        await ws.send_text(_ws_error("invalid_value", "请发送 1 至 12000 字的消息。", 400, stream_id))
                        continue
                    forwarded = {"type": "response.steer", "previous_response_id": target, "input": message}
                    if stream_id:
                        forwarded["stream_id"] = stream_id
                    await upstream.send(json.dumps(forwarded, ensure_ascii=False))
                elif kind == "response.cancel":
                    forwarded = {"type": "response.cancel"}
                    target = event.get("response_id")
                    if target is not None:
                        if not isinstance(target, str) or not RESPONSE_ID.fullmatch(target):
                            await ws.send_text(_ws_error("invalid_value", "无效的 response_id。", 400, stream_id))
                            continue
                        forwarded["response_id"] = target
                    await upstream.send(json.dumps(forwarded, ensure_ascii=False))
                else:
                    await ws.send_text(_ws_error("invalid_value", "不支持的 WebSocket 事件类型。", 400, stream_id))

        async def from_upstream():
            async for message in upstream:
                if isinstance(message, str):
                    await ws.send_text(message)
                else:
                    await ws.send_bytes(message)

        try:
            async with upstream:
                tasks = [asyncio.create_task(from_browser()), asyncio.create_task(from_upstream())]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                for task in done:
                    exc = task.exception()
                    if exc and not isinstance(exc, (WebSocketDisconnect, ConnectionClosed, asyncio.CancelledError)):
                        raise exc
        finally:
            try:
                await ws.close()
            except Exception:
                pass
