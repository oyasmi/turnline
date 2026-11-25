import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Request, WebSocket
import httpx
from starlette.responses import JSONResponse, StreamingResponse
from websockets.asyncio.client import connect as ws_connect

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
                    db.execute("INSERT INTO conversations VALUES (?, ?)", (CONVERSATION, identity))
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

    async def test_relay_websocket_forwards_create_steer_cancel_and_enforces_ownership(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "pipiclaw.sock"
            received = []
            upstream = FastAPI()

            @upstream.get("/v1/models/pipiclaw")
            async def model():
                return {"id": "pipiclaw"}

            @upstream.post("/v1/conversations")
            async def create():
                return {"id": CONVERSATION}

            @upstream.websocket("/v1/responses")
            async def ws_upstream(ws: WebSocket):
                await ws.accept()
                try:
                    while True:
                        event = json.loads(await ws.receive_text())
                        received.append(event)
                        if event["type"] == "response.create":
                            await ws.send_text(json.dumps({
                                "type": "response.created", "sequence_number": 0,
                                "response": {"id": RESPONSE, "status": "in_progress"},
                            }))
                        elif event["type"] == "response.steer":
                            await ws.send_text(json.dumps({
                                "type": "response.steer.accepted", "sequence_number": 1,
                                "steer": {"id": "steer_1", "previous_response_id": RESPONSE},
                            }))
                            await ws.send_text(json.dumps({
                                "type": "response.incomplete", "sequence_number": 2,
                                "response": {"id": RESPONSE, "status": "incomplete",
                                             "incomplete_details": {"reason": "steered"}},
                            }))
                        elif event["type"] == "response.cancel":
                            await ws.send_text(json.dumps({
                                "type": "response.cancelled", "sequence_number": 3,
                                "response": {"id": RESPONSE, "status": "cancelled"},
                            }))
                except Exception:
                    pass

            async with running(upstream, uds=path):
                with patch("turnline.server.SpeechModels"):
                    app = create_app(socket_path=path, state_dir=state / "state")
                    async with running(app) as origin, httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        headers = {"Origin": origin}
                        session = await client.get("/api/session")
                        cookie = session.headers["set-cookie"].split(";", 1)[0]
                        await client.post(PREFIX + "/conversations", headers=headers)

                        ws_origin = origin.replace("http://", "ws://", 1) + PREFIX + "/responses"
                        async with ws_connect(ws_origin, additional_headers={"Origin": origin, "Cookie": cookie}) as ws:
                            # Rejects conversation not owned by this device.
                            await ws.send(json.dumps({
                                "type": "response.create", "conversation": OTHER, "input": "越权",
                            }))
                            err = json.loads(await ws.recv())
                            self.assertEqual(err["type"], "error")
                            self.assertEqual(err["status"], 404)

                            # Valid create -> steer -> cancel flow.
                            await ws.send(json.dumps({
                                "type": "response.create", "conversation": CONVERSATION, "input": "查日志",
                                "instructions": "简短回答",
                            }))
                            created_ev = json.loads(await ws.recv())
                            self.assertEqual(created_ev["type"], "response.created")

                            await ws.send(json.dumps({
                                "type": "response.steer", "previous_response_id": RESPONSE, "input": "只看今天",
                            }))
                            self.assertEqual(json.loads(await ws.recv())["type"], "response.steer.accepted")
                            self.assertEqual(json.loads(await ws.recv())["type"], "response.incomplete")

                            await ws.send(json.dumps({"type": "response.cancel", "response_id": RESPONSE}))
                            self.assertEqual(json.loads(await ws.recv())["type"], "response.cancelled")

                        self.assertEqual([item["type"] for item in received],
                                         ["response.create", "response.steer", "response.cancel"])
                        self.assertEqual(received[0]["model"], "pipiclaw")
                        self.assertEqual(received[0]["instructions"], "简短回答")
