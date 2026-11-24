import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer

from connection import DeviceStore, normalize_origin
from server import create_app

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

    def test_public_url_requires_tls_for_a_nonloopback_browser(self):
        self.assertEqual(normalize_origin("https://192.168.1.5:443/"), "https://192.168.1.5")
        self.assertEqual(normalize_origin("http://[::1]:4173"), "http://[::1]:4173")
        with self.assertRaises(ValueError):
            normalize_origin("http://192.168.1.5:4173")


class ConnectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_device_can_relay_and_cancel_a_turn_on_the_local_socket(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "pipiclaw.sock"
            upstream_cancelled = asyncio.Event()
            requests = []

            async def model(_request):
                return web.json_response({"id": "pipiclaw"})

            async def create(_request):
                return web.json_response({"id": CONVERSATION})

            async def items(_request):
                return web.json_response({"data": [], "has_more": False})

            async def respond(request):
                requests.append(await request.json())
                response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                await response.prepare(request)
                try:
                    await response.write(b"data: {}\n\n")
                    await asyncio.Future()
                finally:
                    upstream_cancelled.set()
                return response

            upstream = web.Application()
            upstream.router.add_get("/v1/models/pipiclaw", model)
            upstream.router.add_post("/v1/conversations", create)
            upstream.router.add_get("/v1/conversations/{conversation}/items", items)
            upstream.router.add_post("/v1/responses", respond)
            runner = web.AppRunner(upstream, handler_cancellation=True)
            await runner.setup()
            await web.UnixSite(runner, path).start()
            try:
                with patch("server.SpeechModels") as models:
                    app = create_app(socket_path=path, state_dir=state / "state")
                    models.return_value.voice_choices = ((0, "Matcha"),)
                    async with TestClient(TestServer(app, handler_cancellation=True),
                                          cookie_jar=CookieJar(unsafe=True)) as client:
                        origin = str(client.make_url("/")).rstrip("/")
                        headers = {"Origin": origin}
                        self.assertEqual((await client.post(PREFIX + "/conversations", headers=headers)).status, 401)
                        self.assertEqual((await client.get("/speech/info")).status, 401)
                        pairing = DeviceStore(state / "state").issue()
                        payload = {"token": pairing}
                        rejected = await client.post("/api/pair", json=payload, headers={"Origin": "https://other.test"})
                        self.assertEqual(rejected.status, 403)
                        paired = await client.post("/api/pair", json=payload, headers=headers)
                        self.assertEqual(paired.status, 204)
                        self.assertTrue(paired.cookies["turnline"]["httponly"])
                        self.assertEqual(paired.cookies["turnline"]["samesite"], "Strict")
                        self.assertEqual((await client.post("/api/pair", json=payload, headers=headers)).status, 401)
                        self.assertEqual(await (await client.get("/api/session")).json(), {"connection": "ready"})
                        created = await client.post(PREFIX + "/conversations", headers=headers)
                        self.assertEqual((await created.json())["id"], CONVERSATION)
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status, 200)
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{OTHER}/items")).status, 404)
                        self.assertEqual((await client.post("/demo/v1/responses", json={}, headers=headers)).status, 404)
                        response = await client.post(
                            PREFIX + "/responses",
                            headers=headers,
                            json={"input": "你好", "conversation": CONVERSATION,
                                  "model": "invalid", "tools": ["unused"], "instructions": "短答"},
                        )
                        self.assertEqual(await asyncio.wait_for(response.content.readexactly(10), 3), b"data: {}\n\n")
                        response.close()
                        await asyncio.wait_for(upstream_cancelled.wait(), 3)
                        self.assertEqual(requests, [{"model": "pipiclaw", "stream": True, "input": "你好",
                                                     "conversation": CONVERSATION, "instructions": "短答"}])
                        self.assertEqual((await client.post("/api/sign-out", headers=headers)).status, 204)
                        self.assertEqual((await client.get(f"{PREFIX}/conversations/{CONVERSATION}/items")).status, 401)
            finally:
                await runner.cleanup()
