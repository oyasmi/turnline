import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Request
import httpx
from starlette.responses import StreamingResponse

from connection import SessionStore, digest, normalize_origin
from server import create_app
from support import running

CONVERSATION = "conv_" + "c" * 32
OTHER = "conv_" + "d" * 32
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

    def test_public_url_requires_tls_for_a_nonloopback_browser(self):
        self.assertEqual(normalize_origin("https://192.168.1.5:443/"), "https://192.168.1.5")
        self.assertEqual(normalize_origin("http://[::1]:8686"), "http://[::1]:8686")
        with self.assertRaises(ValueError):
            normalize_origin("http://192.168.1.5:8686")


class TunnelTest(unittest.IsolatedAsyncioTestCase):
    async def test_two_https_aliases_open_on_the_default_app(self):
        with TemporaryDirectory() as directory, patch("server.SpeechModels"):
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
        with TemporaryDirectory() as directory, patch("server.SpeechModels"):
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
                with patch("server.SpeechModels"):
                    app = create_app(socket_path=path, state_dir=state / "state")
                    async with running(app) as origin, httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        headers = {"Origin": origin}
                        self.assertEqual((await client.post(PREFIX + "/conversations", headers=headers)).status_code, 401)
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
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status_code, 200)
                        async with httpx.AsyncClient(base_url=origin, timeout=5) as other:
                            self.assertEqual((await other.get("/api/session")).json()["connection"], "ready")
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
                                                     "conversation": CONVERSATION, "instructions": "短答",
                                                     "reasoning": {"effort": "low"}, "text": {"verbosity": "low"}}])
