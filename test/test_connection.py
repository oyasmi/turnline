import asyncio
from contextlib import closing
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
import httpx
from starlette.responses import JSONResponse, StreamingResponse
from websockets.asyncio.client import connect as ws_connect

from turnline.auth import PasscodeVerifier
from turnline.connection import SessionStore, digest, normalize_origin
from turnline.server import create_app
from support import running

CONVERSATION = "conv_" + "c" * 32
OTHER = "conv_" + "d" * 32
RESPONSE = "resp_" + "a" * 32
PREFIX = "/api/pipiclaw/v1"


class SessionStoreTest(unittest.TestCase):
    def test_reopen_session_and_claim_only_own_conversations(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            first = SessionStore(state)
            session = first.start(None)
            reopened = SessionStore(state)
            identity = reopened.identity(session)
            self.assertIsNotNone(identity)
            self.assertIsNone(reopened.start(session))
            second = reopened.identity(reopened.start(None))
            reopened.own(CONVERSATION, identity)
            self.assertTrue(reopened.owns(CONVERSATION, identity))
            self.assertFalse(reopened.owns(CONVERSATION, second))

    def test_legacy_session_is_renewed_with_its_existing_conversation(self):
        with TemporaryDirectory() as directory:
            store = SessionStore(Path(directory))
            token = "w" * 43
            identity = digest(token)
            db = sqlite3.connect(store.path)
            try:
                with db:
                    db.execute("INSERT INTO devices VALUES (?, 1)", (identity,))
                    db.execute("INSERT INTO conversations (id, owner) VALUES (?, ?)", (CONVERSATION, identity))
            finally:
                db.close()
            self.assertIsNone(store.identity(token))
            self.assertEqual(store.start(token), token)
            self.assertEqual(store.identity(token), identity)
            self.assertTrue(store.owns(CONVERSATION, identity))
            self.assertEqual(store.list_conversations(identity), {"data": [CONVERSATION], "has_more": False})

    def test_history_paginates_only_the_current_device_without_repeating_new_entries(self):
        with TemporaryDirectory() as directory:
            store = SessionStore(Path(directory))
            first = store.identity(store.start(None))
            second = store.identity(store.start(None))
            ids = ["conv_" + format(index, "032x") for index in range(14)]
            for conversation in ids:
                store.own(conversation, first)
            store.own(OTHER, second)
            page = store.list_conversations(first)
            self.assertEqual(page["data"], ids[:1:-1])
            self.assertTrue(page["has_more"])
            store.own(CONVERSATION, first)
            self.assertEqual(store.list_conversations(first, page["data"][-1]),
                             {"data": ids[1::-1], "has_more": False})
            self.assertEqual(store.list_conversations(second), {"data": [OTHER], "has_more": False})
            self.assertEqual(store.list_conversations(first, OTHER), {"data": [], "has_more": False})

    def test_legacy_owner_migration_keeps_anonymous_history_private(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            store = SessionStore(state)
            authenticated, first = store.create_authenticated(3_600)
            anonymous = store.identity(store.start(None))
            revoked_token, revoked = store.create_authenticated(3_600)
            store.revoke_token(revoked_token)
            previous = "conv_" + "e" * 32
            with closing(sqlite3.connect(store.path)) as db, db:
                db.executescript("""
                    DROP TABLE conversations;
                    CREATE TABLE conversations (
                        id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE
                    );
                    CREATE INDEX conversations_by_device ON conversations (device);
                """)
                db.executemany("INSERT INTO conversations VALUES (?, ?)", (
                    (previous, revoked), (CONVERSATION, first), (OTHER, anonymous),
                ))

            store = SessionStore(state, share_authenticated=True)
            store.revoke_token(authenticated)
            replacement, new_device = store.create_authenticated(3_600)
            self.assertIsNone(store.identity(authenticated, require_auth=True))
            self.assertEqual(store.identity(replacement, require_auth=True), new_device)
            self.assertEqual(store.list_conversations(new_device)["data"], [CONVERSATION, previous])
            self.assertEqual(store.list_conversations(anonymous)["data"], [OTHER])
            self.assertFalse(store.owns(OTHER, new_device))
            self.assertFalse(store.owns(CONVERSATION, anonymous))
            self.assertEqual(SessionStore(state).list_conversations(new_device)["data"], [])

    def test_public_url_requires_tls_for_a_nonloopback_browser(self):
        self.assertEqual(normalize_origin("https://192.168.1.5:443/"), "https://192.168.1.5")
        self.assertEqual(normalize_origin("http://[::1]:8686"), "http://[::1]:8686")
        with self.assertRaises(ValueError):
            normalize_origin("http://192.168.1.5:8686")


class TunnelTest(unittest.IsolatedAsyncioTestCase):
    async def test_two_https_aliases_open_on_the_default_app(self):
        with TemporaryDirectory() as directory, patch("turnline.server.SpeechModels"):
            state = Path(directory)
            app = create_app(state_dir=state, direct_only=True)
            transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 4321))
            async with httpx.AsyncClient(base_url="https://first.example", transport=transport) as client:
                forwarded = {"host": "localhost:8686", "x-forwarded-host": "first.example",
                             "x-forwarded-proto": "https", "origin": "https://first.example"}
                self.assertEqual((await client.head("/", headers=forwarded)).headers["location"], "/direct")
                page = await client.get("/direct", headers=forwarded)
                self.assertIn("wss://first.example", page.headers["content-security-policy"])
                self.assertEqual((await client.get("/assets/audio.js", headers=forwarded)).status_code, 200)
                self.assertEqual((await client.get("/speech/info", headers=forwarded)).status_code, 200)
                self.assertEqual((await client.get("/api/session", headers=forwarded)).json(), {
                    "connection": "direct", "relay": False,
                })
                wrong = {**forwarded, "origin": "https://another.example"}
                self.assertEqual((await client.post("/speech/prepare", headers=wrong)).status_code, 403)
                self.assertEqual((await client.post(PREFIX + "/conversations", headers=forwarded)).status_code, 404)
                preserved = await client.get("http://second.example/direct")
                self.assertIn("wss://second.example", preserved.headers["content-security-policy"])
                fresh = await client.get("https://second.example/api/session")
                self.assertEqual(fresh.json()["connection"], "direct")
                self.assertNotIn("set-cookie", fresh.headers)

    async def test_forwarded_headers_require_a_loopback_peer(self):
        with TemporaryDirectory() as directory, patch("turnline.server.SpeechModels"):
            state = Path(directory)
            app = create_app(state_dir=state, direct_only=True)
            headers = {"host": "external.example", "x-forwarded-proto": "https"}
            for address, status in [("192.168.0.2", 403), ("127.0.0.1", 307)]:
                transport = httpx.ASGITransport(app=app, client=(address, 4321))
                async with httpx.AsyncClient(base_url="http://127.0.0.1:8686", transport=transport) as client:
                    self.assertEqual((await client.get("/", headers=headers)).status_code, status)


class ConnectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_device_can_relay_and_cancel_a_turn_on_the_local_socket(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "pipiclaw.sock"
            upstream_cancelled = asyncio.Event()
            requests = []
            upstream = FastAPI()

            @upstream.get("/v1/models/pipiclaw")
            async def model():
                return {"id": "pipiclaw"}

            @upstream.post("/v1/conversations")
            async def create():
                return {"id": CONVERSATION}

            @upstream.get("/v1/conversations/{conversation}/items")
            async def items(conversation: str):
                return {"data": [], "has_more": False}

            @upstream.post("/v1/responses")
            async def respond(request: Request):
                requests.append(await request.json())

                async def events():
                    try:
                        yield b"data: {}\n\n"
                        await asyncio.Future()
                    finally:
                        upstream_cancelled.set()
                return StreamingResponse(events(), media_type="text/event-stream")

            async with running(upstream, uds=path):
                with patch("turnline.server.SpeechModels"):
                    app = create_app(socket_path=path, state_dir=state / "state")
                    async with running(app) as origin, httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        headers = {"Origin": origin}
                        self.assertEqual((await client.post(PREFIX + "/conversations", headers=headers)).status_code, 401)
                        self.assertEqual((await client.get(PREFIX + "/conversations")).status_code, 401)
                        self.assertEqual((await client.get("/speech/info")).status_code, 200)
                        rejected = await client.post(PREFIX + "/conversations", headers={"Origin": "https://other.test"})
                        self.assertEqual(rejected.status_code, 403)
                        session = await client.get("/api/session")
                        self.assertEqual(session.json(), {"connection": "ready", "relay": True})
                        self.assertIn("HttpOnly", session.headers["set-cookie"])
                        self.assertIn("SameSite=strict", session.headers["set-cookie"])
                        self.assertNotIn("set-cookie", (await client.get("/api/session")).headers)
                        created = await client.post(PREFIX + "/conversations", headers=headers)
                        self.assertEqual(created.json()["id"], CONVERSATION)
                        self.assertEqual((await client.get(PREFIX + "/conversations")).json(),
                                         {"data": [CONVERSATION], "has_more": False})
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status_code, 200)
                        async with httpx.AsyncClient(base_url=origin, timeout=5) as other:
                            self.assertEqual((await other.get("/api/session")).json()["connection"], "ready")
                            self.assertEqual((await other.get(PREFIX + "/conversations")).json(),
                                             {"data": [], "has_more": False})
                            self.assertEqual(
                                (await other.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status_code, 404,
                            )
                        self.assertEqual((await client.post("/demo/v1/responses", json={}, headers=headers)).status_code, 404)
                        async with client.stream(
                            "POST", PREFIX + "/responses", headers=headers,
                            json={"input": "你好", "conversation": CONVERSATION,
                                  "model": "invalid", "tools": ["unused"], "instructions": "短答",
                                  "reasoning": {"effort": "low", "summary": "auto"},
                                  "text": {"verbosity": "low", "format": {"type": "unused"}}},
                        ) as response:
                            async with asyncio.timeout(3):
                                self.assertEqual(await anext(response.aiter_bytes()), b"data: {}\n\n")
                        await asyncio.wait_for(upstream_cancelled.wait(), 3)
                        self.assertEqual(requests, [{"model": "pipiclaw", "stream": True, "input": "你好",
                                                     "conversation": CONVERSATION, "instructions": "短答"}])

    async def test_relay_supports_conversation_metadata_delete_and_background_resume(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "pipiclaw.sock"
            busy = {"value": True}
            meta_store = {}
            cancelled = []
            upstream = FastAPI()

            @upstream.get("/v1/models/pipiclaw")
            async def model():
                return {"id": "pipiclaw"}

            @upstream.post("/v1/conversations")
            async def create(request: Request):
                body = await request.json()
                meta_store[CONVERSATION] = body.get("metadata", {})
                return {"id": CONVERSATION, "metadata": meta_store[CONVERSATION]}

            @upstream.get("/v1/conversations/{conversation}")
            async def get_conv(conversation: str):
                return {"id": conversation, "metadata": meta_store.get(conversation, {})}

            @upstream.post("/v1/conversations/{conversation}")
            async def update_conv(conversation: str, request: Request):
                body = await request.json()
                meta_store[conversation] = body["metadata"]
                return {"id": conversation, "metadata": meta_store[conversation]}

            @upstream.delete("/v1/conversations/{conversation}")
            async def delete_conv(conversation: str):
                if busy["value"]:
                    return JSONResponse({"error": {"code": "conversation_busy", "message": "busy"}}, status_code=409)
                meta_store.pop(conversation, None)
                return {"id": conversation, "object": "conversation.deleted", "deleted": True}

            @upstream.post("/v1/responses")
            async def respond(request: Request):
                body = await request.json()
                assert body["background"] is True

                async def events():
                    ev = {"type": "response.created", "sequence_number": 0,
                          "response": {"id": RESPONSE, "status": "in_progress"}}
                    yield f"data: {json.dumps(ev)}\n\n".encode()
                return StreamingResponse(events(), media_type="text/event-stream")

            @upstream.get("/v1/responses/{response_id}")
            async def retrieve(response_id: str, stream: str | None = None, starting_after: int | None = None):
                assert response_id == RESPONSE and stream == "true" and starting_after == 0

                async def events():
                    ev = {"type": "response.completed", "sequence_number": 1,
                          "response": {"id": RESPONSE, "status": "completed", "output": []}}
                    yield f"data: {json.dumps(ev)}\n\n".encode()
                return StreamingResponse(events(), media_type="text/event-stream")

            @upstream.post("/v1/responses/{response_id}/cancel")
            async def cancel(response_id: str):
                cancelled.append(response_id)
                return {"id": response_id, "status": "cancelled"}

            async with running(upstream, uds=path):
                with patch("turnline.server.SpeechModels"):
                    app = create_app(socket_path=path, state_dir=state / "state")
                    async with running(app) as origin, httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        headers = {"Origin": origin}
                        await client.get("/api/session")
                        created = await client.post(
                            PREFIX + "/conversations", headers=headers, json={"metadata": {"source": "turnline"}}
                        )
                        self.assertEqual(created.json(), {"id": CONVERSATION, "metadata": {"source": "turnline"}})
                        updated = await client.post(
                            f"{PREFIX}/conversations/{CONVERSATION}", headers=headers,
                            json={"metadata": {"source": "turnline", "title": "测试标题"}},
                        )
                        self.assertEqual(updated.json()["metadata"]["title"], "测试标题")
                        fetched = await client.get(f"{PREFIX}/conversations/{CONVERSATION}")
                        self.assertEqual(fetched.json()["metadata"]["title"], "测试标题")

                        async with client.stream(
                            "POST", PREFIX + "/responses", headers=headers,
                            json={"input": "查一下", "conversation": CONVERSATION, "background": True},
                        ) as resp:
                            body = b"".join([chunk async for chunk in resp.aiter_bytes()])
                            self.assertIn(RESPONSE.encode(), body)

                        async with client.stream(
                            "GET", f"{PREFIX}/responses/{RESPONSE}?stream=true&starting_after=0",
                        ) as resumed:
                            body = b"".join([chunk async for chunk in resumed.aiter_bytes()])
                            self.assertIn(b"response.completed", body)

                        cancel_resp = await client.post(f"{PREFIX}/responses/{RESPONSE}/cancel", headers=headers)
                        self.assertEqual(cancel_resp.status_code, 200)
                        self.assertEqual(cancelled, [RESPONSE])

                        async with httpx.AsyncClient(base_url=origin, timeout=5) as other:
                            await other.get("/api/session")
                            self.assertEqual(
                                (await other.post(f"{PREFIX}/responses/{RESPONSE}/cancel", headers=headers)).status_code, 404,
                            )

                        self.assertEqual(
                            (await client.delete(f"{PREFIX}/conversations/{CONVERSATION}", headers=headers)).status_code, 409,
                        )
                        busy["value"] = False
                        deleted = await client.delete(f"{PREFIX}/conversations/{CONVERSATION}", headers=headers)
                        self.assertEqual(deleted.status_code, 200)
                        self.assertEqual((await client.get(PREFIX + "/conversations")).json(),
                                         {"data": [], "has_more": False})

    async def test_relay_websocket_survives_detach_and_confirms_stop_across_devices(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "pipiclaw.sock"
            received = []
            allow_completion = asyncio.Event()
            disconnections = asyncio.Queue()
            status = {}
            upstream = FastAPI()
            successor = "resp_" + "b" * 32

            @upstream.get("/v1/models/pipiclaw")
            async def model():
                return {"id": "pipiclaw"}

            @upstream.post("/v1/conversations")
            async def create():
                return {"id": CONVERSATION}

            @upstream.get("/v1/responses/{response_id}")
            async def retrieve(response_id: str):
                return {"id": response_id, "status": status[response_id]}

            @upstream.websocket("/v1/responses")
            async def ws_upstream(ws: WebSocket):
                await ws.accept()
                completing = None

                async def emit(kind, **fields):
                    await ws.send_text(json.dumps({"type": kind, **fields}))

                async def complete():
                    await allow_completion.wait()
                    await emit("response.completed", response={
                        "id": successor, "status": "completed", "output": [],
                    })

                try:
                    while True:
                        event = await ws.receive_json()
                        received.append(event)
                        if event["type"] == "response.create":
                            status[RESPONSE] = "in_progress"
                            await emit("response.created", response={"id": RESPONSE, "status": "in_progress"})
                        elif event["type"] == "response.steer":
                            # The original can complete before the steer acknowledgment.
                            # An accepted steer in this case runs as a follow-up.
                            await emit("response.completed", response={"id": RESPONSE, "status": "completed"})
                            await emit("response.steer.accepted", steer={"previous_response_id": RESPONSE})
                            status[successor] = "in_progress"
                            await emit("response.created", response={"id": successor, "status": "in_progress"})
                            completing = asyncio.create_task(complete())
                        elif event["type"] == "response.cancel":
                            status[event["response_id"]] = "cancelled"
                            # PipiClaw sends no cancellation event.
                except WebSocketDisconnect:
                    disconnections.put_nowait(True)
                finally:
                    if completing:
                        completing.cancel()
                        await asyncio.gather(completing, return_exceptions=True)

            async def receive(ws):
                return json.loads(await asyncio.wait_for(ws.recv(), 3))

            async with running(upstream, uds=path):
                passcode = "shared-test-passcode"
                with patch("turnline.server.SpeechModels"):
                    app = create_app(
                        socket_path=path, state_dir=state / "state", auth_mode="passcode",
                        passcode_verifier=PasscodeVerifier.from_plaintext(passcode),
                    )
                async with (
                    running(app) as origin,
                    httpx.AsyncClient(base_url=origin, timeout=5) as first,
                    httpx.AsyncClient(base_url=origin, timeout=5) as second,
                ):
                    headers = {"Origin": origin}
                    url = origin.replace("http://", "ws://", 1) + PREFIX + "/responses"

                    async def login(client):
                        response = await client.post("/api/auth/login", headers=headers, json={"passcode": passcode})
                        self.assertEqual(response.status_code, 200)
                        return response.headers["set-cookie"].split(";", 1)[0]

                    def connect(cookie):
                        return ws_connect(url, additional_headers={**headers, "Cookie": cookie})

                    first_cookie, second_cookie = await login(first), await login(second)
                    await first.post(PREFIX + "/conversations", headers=headers)
                    self.assertEqual((await second.get(PREFIX + "/conversations")).json()["data"], [CONVERSATION])
                    payload = {"type": "response.create", "conversation": CONVERSATION,
                               "input": "查日志", "instructions": "先看今天"}
                    async with connect(first_cookie) as ws:
                        await ws.send(json.dumps({**payload, "conversation": OTHER}))
                        self.assertEqual((await receive(ws))["status"], 404)
                        await ws.send(json.dumps(payload))
                        created = await receive(ws)
                        self.assertEqual(created["type"], "response.created")

                    self.assertTrue(disconnections.empty(), "Closing the first browser must leave upstream connected")
                    async with connect(second_cookie) as ws:
                        await ws.send(json.dumps({"type": "response.subscribe", "conversation": CONVERSATION}))
                        attachment = await receive(ws)
                        self.assertEqual(attachment["type"], "turnline.attached")
                        self.assertGreaterEqual(attachment["elapsed_ms"], created["turnline_elapsed_ms"])
                        self.assertEqual(await receive(ws), created)
                        await ws.send(json.dumps({
                            "type": "response.steer", "previous_response_id": RESPONSE,
                            "input": "只看今天", "request_id": "steer-1",
                        }))
                        self.assertEqual((await receive(ws))["turnline_request_id"], "steer-1")
                        self.assertTrue((await receive(ws))["turnline_continues"])
                        next_response = await receive(ws)
                        self.assertEqual(next_response["response"]["id"], successor)

                    self.assertTrue(disconnections.empty())
                    allow_completion.set()
                    await asyncio.wait_for(disconnections.get(), 3)
                    async with connect(second_cookie) as ws:
                        await ws.send(json.dumps({
                            "type": "response.subscribe", "conversation": CONVERSATION,
                            "turn_id": created["turnline_turn"], "after": next_response["turnline_cursor"],
                        }))
                        self.assertEqual((await receive(ws))["type"], "turnline.attached")
                        complete = await receive(ws)
                        self.assertEqual(complete["type"], "response.completed")
                        self.assertEqual(complete["response"]["id"], successor)

                    await first.post("/api/auth/logout", headers=headers)
                    async with connect(second_cookie) as ws:
                        await ws.send(json.dumps(payload))
                        self.assertEqual((await receive(ws))["type"], "response.created")
                        await ws.send(json.dumps({"type": "response.cancel"}))
                        cancelled = await receive(ws)
                        self.assertEqual(cancelled["type"], "response.cancelled")
                        self.assertEqual(cancelled["response"]["status"], "cancelled")

                    self.assertEqual([item["type"] for item in received],
                                     ["response.create", "response.steer", "response.create", "response.cancel"])
                    self.assertEqual(received[0]["model"], "pipiclaw")
                    self.assertEqual(received[0]["instructions"], "先看今天")
