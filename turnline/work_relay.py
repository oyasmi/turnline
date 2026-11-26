"""Keep a Pipiclaw Responses WebSocket alive for the lifetime of a turn."""

import asyncio
from collections import OrderedDict, deque
import json
import logging
import re
from time import monotonic
from uuid import uuid4

import httpx
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import unix_connect
from websockets.exceptions import WebSocketException

from .http_support import BODY_LIMIT, WS_AUTH_CLOSE_CODE

LOG = logging.getLogger(__name__)
EVENT_BYTES = 4 * 1024 * 1024
EVENT_COUNT = 2048
MAX_ACTIVE = 16
MAX_RECENT = 8
RECENT_SECONDS = 60
RESPONSE_ID = re.compile(r"resp_[a-f0-9]{32}")
COMMAND_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
TERMINAL = {"response.completed", "response.failed", "response.incomplete", "response.cancelled"}


def encode(event):
    return json.dumps(event, ensure_ascii=False, separators=(",", ":"))


def failure(code, message, status=400, stream_id=None):
    event = {"type": "error", "status": status, "error": {"code": code, "message": message}}
    if stream_id:
        event["stream_id"] = stream_id
    return event


def valid_message(message):
    return isinstance(message, str) and len(message) <= 12_000 and bool(message.strip())


class WorkTurn:
    def __init__(self, hub, conversation):
        self.hub = hub
        self.conversation = conversation
        self.id = uuid4().hex
        self.started = monotonic()
        self.events = deque()
        self.size = self.cursor = 0
        self.changed = asyncio.Event()
        self.upstream = self.response_id = self.response_status = self.cancel_check = None
        self.steer_pending = False
        self.steer_request = self.steer_target = self.held_terminal = None
        self.finished = None
        self.between_responses = False

    def elapsed_ms(self):
        return round(((self.finished or monotonic()) - self.started) * 1000)

    def publish(self, event, *, terminal=False):
        if self.finished is not None:
            return
        self.cursor += 1
        wire = encode({
            **event, "turnline_turn": self.id, "turnline_cursor": self.cursor,
            "turnline_elapsed_ms": self.elapsed_ms(),
        })
        size = len(wire.encode())
        self.events.append((wire, size))
        self.size += size
        while self.size > EVENT_BYTES or len(self.events) > EVENT_COUNT:
            _, removed = self.events.popleft()
            self.size -= removed
        if terminal:
            self.finished = monotonic()
        self.changed.set()
        self.changed = asyncio.Event()

    async def follow(self, after):
        while True:
            first = self.cursor - len(self.events)
            if after > self.cursor:
                yield encode(failure("invalid_cursor", "无效的回合游标。"))
                return
            if after < first:
                # Skip deltas whose item-start event was evicted. A terminal snapshot can
                # still restore the final text and any tools from the last response.
                after = self.cursor - int(self.finished is not None)
                yield encode({
                    "type": "turnline.snapshot", "turnline_turn": self.id, "turnline_cursor": after,
                    "response_id": self.response_id, "status": self.response_status,
                })
                continue
            if after < self.cursor:
                wire, _ = self.events[after - first]
                after += 1
                yield wire
            elif self.finished is not None:
                return
            else:
                await self.changed.wait()

    async def run(self, payload):
        submitted = False
        try:
            async with unix_connect(
                str(self.hub.path), uri="ws://localhost/v1/responses", max_size=2 * 1024 * 1024,
                open_timeout=5, close_timeout=2,
            ) as upstream:
                self.upstream = upstream
                # A send failure can leave the request's delivery ambiguous.
                submitted = True
                await upstream.send(encode(payload))
                async for raw in upstream:
                    event = json.loads(raw)
                    if not isinstance(event, dict):
                        continue
                    self.receive(event)
                    if self.finished is not None:
                        return
        except (OSError, TimeoutError, WebSocketException, ValueError):
            pass
        except Exception:
            LOG.exception("Unexpected error while relaying Pipiclaw work")
        finally:
            self.upstream = None
            if self.cancel_check:
                self.cancel_check.cancel()
                await asyncio.gather(self.cancel_check, return_exceptions=True)
            if submitted:
                event = failure("upstream_disconnected", "Pipiclaw 工作连接已断开。请在会话记录中确认结果。", 502)
            else:
                event = failure("upstream_unavailable", self.hub.unavailable, 503)
            self.publish(event, terminal=True)

    def receive(self, event):
        kind = event.get("type")
        response = event.get("response") or {}
        if kind == "response.created":
            self.response_id = response.get("id")
            self.response_status = response.get("status")
            self.between_responses = False
            if self.response_id != self.steer_target:
                self.steer_target = None
        if kind in {"response.queued", "response.in_progress"}:
            self.response_status = kind.removeprefix("response.")
        steered = (kind == "response.incomplete"
                   and (response.get("incomplete_details") or {}).get("reason") == "steered")
        if steered:
            self.between_responses = True
            self.response_status = None

        if kind in {"response.steer.accepted", "response.steer.failed"}:
            event["turnline_request_id"] = self.steer_request
            self.steer_pending = False
            self.steer_request = None
            if kind == "response.steer.failed":
                self.steer_target = None
            self.publish(event)
            if self.held_terminal:
                previous, self.held_terminal = self.held_terminal, None
                self.receive(previous)
            return

        terminal = ((kind in TERMINAL and not steered)
                    or (kind == "error" and "sequence_number" not in event))
        if (self.steer_target and kind in {"response.completed", "response.failed"}
                and response.get("id") == self.steer_target):
            # A steer that races completion can be accepted for a follow-up by Pipiclaw.
            if self.steer_pending:
                self.held_terminal = event
                return
            self.between_responses = True
            self.response_status = None
            self.publish({**event, "turnline_continues": True})
            return
        self.publish(event, terminal=terminal)

    async def steer(self, target, message, request_id):
        if (self.finished is not None or not self.upstream or self.between_responses
                or not target or target != self.response_id or self.steer_target or self.steer_pending or self.cancel_check):
            return False
        self.steer_pending = True
        self.steer_request = request_id
        self.steer_target = target
        try:
            await self.upstream.send(encode({
                "type": "response.steer", "previous_response_id": target, "input": message,
            }))
            return True
        except (OSError, WebSocketException):
            self.steer_pending = False
            self.steer_request = self.steer_target = None
            return False

    def stop(self):
        if self.finished is None and self.cancel_check is None:
            self.cancel_check = asyncio.create_task(self.confirm_stop())

    async def confirm_stop(self):
        # Pipiclaw's WS emits no terminal event when it accepts response.cancel.
        # Verify cancellation via its response record, including across a steer.
        sent_to = None
        try:
            async with asyncio.timeout(10):
                while self.finished is None:
                    target = self.response_id
                    if self.upstream and isinstance(target, str) and RESPONSE_ID.fullmatch(target) and not self.between_responses:
                        if target != sent_to:
                            await self.upstream.send(encode({"type": "response.cancel", "response_id": target}))
                            sent_to = target
                        try:
                            response = await self.hub.client.get(f"/responses/{target}", timeout=2)
                            snapshot = response.json() if response.is_success else None
                        except (httpx.RequestError, ValueError):
                            snapshot = None
                        if (isinstance(snapshot, dict) and snapshot.get("status") == "cancelled"
                                and target == self.response_id and not self.between_responses):
                            self.publish({"type": "response.cancelled", "response": snapshot}, terminal=True)
                            await self.upstream.close()
                            return
                    await asyncio.sleep(0.2)
        except (TimeoutError, OSError, WebSocketException):
            self.publish({"type": "turnline.cancel_failed", "message": "未能确认停工，请稍后重试。"})
        finally:
            self.cancel_check = None


class WorkHub:
    def __init__(self, path, client, unavailable):
        self.path = path
        self.client = client
        self.unavailable = unavailable
        self.active = {}
        self.recent = OrderedDict()
        self.tasks = set()

    def start(self, payload):
        conversation = payload["conversation"]
        if len(self.active) >= MAX_ACTIVE or self.find(conversation):
            return None
        turn = WorkTurn(self, conversation)
        self.active[conversation] = turn

        async def run():
            try:
                await turn.run(payload)
            finally:
                if self.active.get(conversation) is turn:
                    del self.active[conversation]
                self.recent[turn.id] = turn
                while len(self.recent) > MAX_RECENT:
                    self.recent.popitem(last=False)

        task = asyncio.create_task(run())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return turn

    def find(self, conversation, turn_id=None):
        active = self.active.get(conversation)
        if active and (active.id == turn_id or turn_id is None and active.finished is None):
            return active
        recent = self.recent.get(turn_id)
        if (recent and recent.finished is not None and recent.conversation == conversation
                and monotonic() - recent.finished < RECENT_SECONDS):
            return recent
        return None

    async def close(self):
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def relay_socket(ws, hub, owns, authorize):
    await ws.accept()
    lock = asyncio.Lock()
    follow = work = None

    async def send(wire):
        async with lock:
            await ws.send_text(wire)

    async def forward(turn, after):
        try:
            async for wire in turn.follow(after):
                await send(wire)
        except (WebSocketDisconnect, OSError, RuntimeError):
            # A downstream failure only detaches this viewer.
            pass

    async def reply(event):
        await send(encode(event))

    try:
        while True:
            try:
                message = await asyncio.wait_for(ws.receive(), timeout=15)
            except TimeoutError:
                if not await authorize():
                    async with lock:
                        await ws.close(code=WS_AUTH_CLOSE_CODE)
                    return
                continue
            if message["type"] == "websocket.disconnect":
                return
            if not await authorize():
                async with lock:
                    await ws.close(code=WS_AUTH_CLOSE_CODE)
                return
            raw = message.get("text")
            try:
                event = json.loads(raw) if raw is not None and len(raw.encode()) <= BODY_LIMIT else None
            except ValueError:
                event = None
            if not isinstance(event, dict):
                await reply(failure("invalid_json", "消息必须是有效的 JSON 对象。"))
                continue
            kind = event.get("type")
            stream = event.get("stream_id")
            if stream is not None and (not isinstance(stream, str) or not COMMAND_ID.fullmatch(stream)):
                await reply(failure("invalid_stream_id", "无效的 stream_id。"))
                continue
            if kind in {"response.create", "response.subscribe"}:
                conversation = event.get("conversation")
                if not await owns(conversation):
                    await reply(failure("not_found", "找不到此会话。", 404, stream))
                    continue
                if work and work.finished is None:
                    await reply(failure("already_attached", "此连接正在接收一个回合。", 409, stream))
                    continue
                if follow:
                    follow.cancel()
                    await asyncio.gather(follow, return_exceptions=True)
                after = 0
                if kind == "response.create":
                    message = event.get("input")
                    if not valid_message(message):
                        await reply(failure("invalid_value", "请发送 1 至 12000 字的消息。", stream_id=stream))
                        continue
                    payload = {"type": kind, "model": "pipiclaw", "conversation": conversation, "input": message}
                    instructions = event.get("instructions")
                    if isinstance(instructions, str) and len(instructions) <= 8_000:
                        payload["instructions"] = instructions
                    if stream:
                        payload["stream_id"] = stream
                    work = hub.start(payload)
                    if not work:
                        code = "work_active" if hub.find(conversation) else "work_limit"
                        await reply(failure(code, "会话已有工作或服务正忙，请稍后重试。", 409, stream))
                        continue
                else:
                    turn_id, after = event.get("turn_id"), event.get("after", 0)
                    if (turn_id is not None and (not isinstance(turn_id, str) or not COMMAND_ID.fullmatch(turn_id))
                            or type(after) is not int or after < 0):
                        await reply(failure("invalid_cursor", "无效的回合游标。", stream_id=stream))
                        continue
                    work = hub.find(conversation, turn_id)
                    if not work:
                        await reply({"type": "turnline.idle"})
                        continue
                    await reply({"type": "turnline.attached", "elapsed_ms": work.elapsed_ms()})
                follow = asyncio.create_task(forward(work, after))
            elif kind == "response.steer":
                request_id = event.get("request_id")
                if not isinstance(request_id, str) or not COMMAND_ID.fullmatch(request_id):
                    request_id = None
                message = event.get("input")
                if not valid_message(message) or not work or not await work.steer(
                    event.get("previous_response_id"), message, request_id,
                ):
                    await reply({"type": "response.steer.failed", "turnline_request_id": request_id,
                                 "error": {"code": "steer_unavailable", "message": "这条补充未能插入当前回合。"}})
            elif kind == "response.cancel":
                target = event.get("response_id")
                if work and (target is None or target == work.response_id):
                    if work.finished is None:
                        work.stop()
                    else:
                        await reply({"type": "turnline.cancel_failed", "message": "工作已经结束。"})
                else:
                    await reply({"type": "turnline.cancel_failed", "message": "找不到要停止的工作。"})
            else:
                await reply(failure("invalid_value", "不支持的 WebSocket 事件类型。", stream_id=stream))
    except (WebSocketDisconnect, OSError):
        pass
    finally:
        if follow:
            follow.cancel()
            await asyncio.gather(follow, return_exceptions=True)
