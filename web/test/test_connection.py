import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Request
import httpx
from starlette.responses import StreamingResponse

from connection import DeviceStore, normalize_origin
from server import create_app
from support import running

CONVERSATION = "conv_" + "c" * 32
OTHER = "conv_" + "d" * 32
PREFIX = "/api/pipiclaw/v1"


class DeviceStoreTest(unittest.TestCase):
    def test_reopen_session_and_claim_only_own_conversations(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            first = DeviceStore(state)
            pairing = first.issue()
            session = first.redeem(pairing)
            reopened = DeviceStore(state)
            identity = reopened.device(session)
            self.assertIsNotNone(identity)
            self.assertIsNone(reopened.redeem(pairing))
            second = reopened.device(reopened.redeem(reopened.issue()))
            reopened.own(CONVERSATION, identity)
            self.assertTrue(reopened.owns(CONVERSATION, identity))
            self.assertFalse(reopened.owns(CONVERSATION, second))
            self.assertEqual(reopened.redeem(first.issue(), session), session)
            self.assertTrue(reopened.owns(CONVERSATION, identity))
            reopened.revoke(identity)
            self.assertIsNone(first.device(session))
            self.assertFalse(first.owns(CONVERSATION, identity))
            self.assertFalse(first.own(OTHER, identity))

    def test_public_url_requires_tls_for_a_nonloopback_browser(self):
        self.assertEqual(normalize_origin("https://192.168.1.5:443/"), "https://192.168.1.5")
        self.assertEqual(normalize_origin("http://[::1]:8686"), "http://[::1]:8686")
        with self.assertRaises(ValueError):
            normalize_origin("http://192.168.1.5:8686")


class TunnelTest(unittest.IsolatedAsyncioTestCase):
    async def test_two_tunnel_aliases_share_one_listener_and_use_secure_pairing(self):
        with TemporaryDirectory() as directory, patch("server.SpeechModels"):
            state = Path(directory)
            app = create_app(state_dir=state, direct_only=True, tunnel=True)
            transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 4321))
            async with httpx.AsyncClient(base_url="https://first.example", transport=transport) as client:
                forwarded = {"host": "localhost:8686", "x-forwarded-host": "first.example",
                             "x-forwarded-proto": "https", "origin": "https://first.example"}
                self.assertEqual((await client.head("/", headers=forwarded)).headers["location"], "/direct")
                page = await client.get("/direct", headers=forwarded)
                self.assertIn("wss://first.example", page.headers["content-security-policy"])
                self.assertEqual((await client.get("/assets/audio.js", headers=forwarded)).status_code, 200)
                self.assertEqual((await client.get("/speech/info", headers=forwarded)).status_code, 401)
                self.assertEqual((await client.get("/api/session", headers=forwarded)).json(), {
                    "connection": "pair", "relay": False,
                })
                code = DeviceStore(state).issue()
                wrong = {**forwarded, "origin": "https://another.example"}
                self.assertEqual((await client.post("/api/pair", json={"token": code}, headers=wrong)).status_code, 403)
                pair = await client.post("/api/pair", json={"token": code}, headers=forwarded)
                self.assertEqual(pair.status_code, 204)
                self.assertIn("__Host-turnline=", pair.headers["set-cookie"])
                self.assertIn("Secure", pair.headers["set-cookie"])
                self.assertEqual((await client.get("/api/session?mode=direct", headers=forwarded)).json(), {
                    "connection": "direct", "relay": False,
                })
                self.assertEqual((await client.post(PREFIX + "/conversations", headers=forwarded)).status_code, 404)
                self.assertEqual((await client.get("/speech/info", headers=forwarded)).status_code, 200)
                preserved = await client.get("http://second.example/direct")
                self.assertIn("wss://second.example", preserved.headers["content-security-policy"])
                other = "https://second.example"
                self.assertEqual((await client.get(other + "/api/session")).json()["connection"], "pair")
                old = await client.post(other + "/api/pair", headers={"origin": other}, json={"token": code})
                self.assertEqual(old.status_code, 401)
                second = DeviceStore(state).issue()
                new = await client.post(other + "/api/pair", headers={"origin": other}, json={"token": second})
                self.assertEqual(new.status_code, 204)
                self.assertEqual((await client.get(other + "/speech/info")).status_code, 200)

    async def test_forwarding_requires_a_loopback_peer_and_tunnel_mode(self):
        with TemporaryDirectory() as directory, patch("server.SpeechModels"):
            state = Path(directory)
            remote = create_app(state_dir=state, direct_only=True, tunnel=True)
            local = create_app(state_dir=state, direct_only=True)
            headers = {"host": "external.example", "x-forwarded-proto": "https"}
            for app, address in [(remote, "192.168.0.2"), (local, "127.0.0.1")]:
                transport = httpx.ASGITransport(app=app, client=(address, 4321))
                async with httpx.AsyncClient(base_url="http://127.0.0.1:8686", transport=transport) as client:
                    self.assertEqual((await client.get("/", headers=headers)).status_code, 403)


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
                        self.assertEqual((await client.get("/speech/info")).status_code, 401)
                        pairing = DeviceStore(state / "state").issue()
                        payload = {"token": pairing}
                        rejected = await client.post("/api/pair", json=payload, headers={"Origin": "https://other.test"})
                        self.assertEqual(rejected.status_code, 403)
                        paired = await client.post("/api/pair", json=payload, headers=headers)
                        self.assertEqual(paired.status_code, 204)
                        self.assertIn("HttpOnly", paired.headers["set-cookie"])
                        self.assertIn("SameSite=strict", paired.headers["set-cookie"])
                        self.assertEqual((await client.post("/api/pair", json=payload, headers=headers)).status_code, 401)
                        self.assertEqual((await client.get("/api/session")).json(), {"connection": "ready", "relay": True})
                        created = await client.post(PREFIX + "/conversations", headers=headers)
                        self.assertEqual(created.json()["id"], CONVERSATION)
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status_code, 200)
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{OTHER}/items")).status_code, 404)
                        self.assertEqual((await client.post("/demo/v1/responses", json={}, headers=headers)).status_code, 404)
                        async with client.stream(
                            "POST", PREFIX + "/responses", headers=headers,
                            json={"input": "你好", "conversation": CONVERSATION,
                                  "model": "invalid", "tools": ["unused"], "instructions": "短答"},
                        ) as response:
                            async with asyncio.timeout(3):
                                self.assertEqual(await anext(response.aiter_bytes()), b"data: {}\n\n")
                        await asyncio.wait_for(upstream_cancelled.wait(), 3)
                        self.assertEqual(requests, [{"model": "pipiclaw", "stream": True, "input": "你好",
                                                     "conversation": CONVERSATION, "instructions": "短答"}])
                        self.assertEqual((await client.post("/api/sign-out", headers=headers)).status_code, 204)
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status_code, 401)
