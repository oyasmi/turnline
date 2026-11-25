import asyncio
from io import StringIO
import os
from pathlib import Path
import stat
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from turnline.auth import (
    LoginRateLimiter,
    PasscodeVerifier,
    WS_AUTH_CLOSE_CODE,
    WS_LIMIT_CLOSE_CODE,
    auth_file,
    save_passcode,
    validate_passcode,
)
from turnline.connection import SessionStore
from turnline.server import create_app, main, run_auth_command
from support import running

CONVERSATION = "conv_" + "b" * 32
PREFIX = "/api/pipiclaw/v1"


class FakeClock:
    def __init__(self, start=1000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class PasscodeStorageTest(unittest.TestCase):
    def test_validate_and_persist_scrypt_passcode(self):
        with self.assertRaises(ValueError):
            validate_passcode("short")
        with self.assertRaises(ValueError):
            validate_passcode("   ")
        with self.assertRaises(ValueError):
            validate_passcode("x" * 129)

        with TemporaryDirectory() as directory:
            state = Path(directory)
            saved = save_passcode(state, "correct-horse-battery")
            self.assertEqual(saved, auth_file(state))
            self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
            self.assertNotIn("correct-horse-battery", saved.read_text(encoding="utf-8"))

            verifier = PasscodeVerifier.load(state)
            self.assertIsNotNone(verifier)
            self.assertTrue(verifier.verify("correct-horse-battery"))
            self.assertFalse(verifier.verify("wrong-passcode"))
            self.assertFalse(verifier.verify(""))

    def test_env_passcode_and_passcode_file_precedence(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            save_passcode(state, "file-passcode-1")
            secret_file = state / "secret.txt"
            secret_file.write_text("env-file-passcode\n", encoding="utf-8")

            with patch.dict(os.environ, {"TURNLINE_PASSCODE": "env-passcode-1"}, clear=False):
                verifier = PasscodeVerifier.load(state)
                self.assertTrue(verifier.verify("env-passcode-1"))
                self.assertFalse(verifier.verify("file-passcode-1"))

            with patch.dict(
                os.environ,
                {"TURNLINE_PASSCODE": "env-passcode-1", "TURNLINE_PASSCODE_FILE": str(secret_file)},
                clear=False,
            ):
                verifier = PasscodeVerifier.load(state)
                self.assertTrue(verifier.verify("env-file-passcode"))
                self.assertFalse(verifier.verify("env-passcode-1"))


class LoginRateLimiterTest(unittest.TestCase):
    def test_progressive_ip_lockout_and_success_reset(self):
        clock = FakeClock()
        limiter = LoginRateLimiter(clock=clock)
        for _ in range(4):
            self.assertEqual(limiter.record_failure("1.2.3.4"), 0)
        self.assertEqual(limiter.record_failure("1.2.3.4"), 60)
        self.assertGreater(limiter.check("1.2.3.4"), 0)
        clock.advance(61)
        self.assertEqual(limiter.check("1.2.3.4"), 0)
        for _ in range(4):
            limiter.record_failure("1.2.3.4")
        self.assertEqual(limiter.record_failure("1.2.3.4"), 900)
        limiter.record_success("1.2.3.4")
        self.assertEqual(limiter.check("1.2.3.4"), 0)

    def test_global_lockout_triggers_across_distinct_ips(self):
        clock = FakeClock()
        limiter = LoginRateLimiter(clock=clock)
        for idx in range(19):
            self.assertEqual(limiter.record_failure(f"10.0.0.{idx}"), 0)
        self.assertEqual(limiter.record_failure("10.0.0.99"), 120)
        self.assertGreater(limiter.check("192.168.1.10"), 0)
        clock.advance(121)
        self.assertEqual(limiter.check("192.168.1.10"), 0)


class SessionStoreAuthTest(unittest.TestCase):
    def test_anonymous_sessions_cannot_satisfy_require_auth(self):
        with TemporaryDirectory() as directory:
            store = SessionStore(Path(directory))
            anon = store.start(None)
            self.assertIsNotNone(store.identity(anon, require_auth=False))
            self.assertIsNone(store.identity(anon, require_auth=True))

            token, identity = store.create_authenticated(30 * 86400)
            self.assertEqual(store.identity(token, require_auth=True), identity)
            self.assertEqual(store.authenticated_count(), 1)

            touched_id, renewed = store.touch_authenticated(token, 30 * 86400)
            self.assertEqual(touched_id, identity)
            self.assertIsNone(renewed)

            self.assertTrue(store.revoke_token(token))
            self.assertIsNone(store.identity(token, require_auth=True))
            self.assertIsNone(store.identity(token, require_auth=False))
            self.assertEqual(store.authenticated_count(), 0)

            token2, _ = store.create_authenticated(30 * 86400)
            token3, _ = store.create_authenticated(30 * 86400)
            self.assertEqual(store.revoke_all_authenticated(), 2)
            self.assertIsNone(store.identity(token2, require_auth=True))
            self.assertIsNone(store.identity(token3, require_auth=True))


class PasscodeEndToEndTest(unittest.IsolatedAsyncioTestCase):
    def _mock_models(self):
        models = MagicMock()
        models.engine = "matcha"
        models.voice_choices = [(0, "默认")]
        models.prepare_recognition.return_value = None
        models.prepare_synthesis.return_value = 1
        return models

    async def test_passcode_gates_http_speech_relay_and_websockets(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            sock = state / "pipiclaw.sock"
            upstream = FastAPI()

            @upstream.get("/v1/models/pipiclaw")
            async def model():
                return {"id": "pipiclaw"}

            @upstream.post("/v1/conversations")
            async def create():
                return {"id": CONVERSATION}

            verifier = PasscodeVerifier.from_plaintext("my-secret-passcode")

            async with running(upstream, uds=sock):
                with patch("turnline.server.SpeechModels", return_value=self._mock_models()):
                    app = create_app(
                        socket_path=sock,
                        state_dir=state / "state",
                        auth_mode="passcode",
                        passcode_verifier=verifier,
                        max_voice_sockets=1,
                        voice_idle_timeout=0.25,
                    )
                    async with running(app) as origin, httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        headers = {"Origin": origin}
                        ws_origin = origin.replace("http://", "ws://", 1)

                        # Unauthenticated requests are locked / rejected.
                        sess = await client.get("/api/session")
                        self.assertEqual(sess.status_code, 200)
                        self.assertEqual(sess.json(), {"connection": "locked", "auth": "passcode"})
                        self.assertNotIn("set-cookie", sess.headers)

                        self.assertEqual((await client.get("/speech/info")).status_code, 401)
                        self.assertEqual((await client.post("/speech/prepare", headers=headers)).status_code, 401)
                        self.assertEqual(
                            (await client.post("/speech/synthesize", headers=headers, json={"text": "你好", "speaker": 0})).status_code,
                            401,
                        )
                        self.assertEqual((await client.get(PREFIX + "/conversations")).status_code, 401)
                        self.assertEqual((await client.post(PREFIX + "/conversations", headers=headers)).status_code, 401)

                        # Unauthenticated WebSockets close with 4401.
                        for ws_path in ("/speech/voice", PREFIX + "/responses"):
                            with self.assertRaises(ConnectionClosed) as ctx:
                                async with ws_connect(ws_origin + ws_path, origin=origin) as ws:
                                    await ws.recv()
                            self.assertEqual(ctx.exception.rcvd.code, WS_AUTH_CLOSE_CODE)

                        # Oversized login payload rejected with 413.
                        huge = await client.post("/api/auth/login", headers=headers, json={"passcode": "a" * 2048})
                        self.assertEqual(huge.status_code, 413)

                        # Wrong passcode returns 401; 5th failure locks with 429 + Retry-After.
                        for _ in range(4):
                            wrong = await client.post("/api/auth/login", headers=headers, json={"passcode": "wrong-pass"})
                            self.assertEqual(wrong.status_code, 401)
                        locked = await client.post("/api/auth/login", headers=headers, json={"passcode": "wrong-pass"})
                        self.assertEqual(locked.status_code, 429)
                        self.assertIn("retry-after", locked.headers)

                        # Separate client IP can still log in and access all endpoints.
                        # Simulate by resetting limiter for loopback test client.
                        # Instead, test login via a fresh app instance with clean limiter.
                    app2 = create_app(
                        socket_path=sock,
                        state_dir=state / "state2",
                        auth_mode="passcode",
                        passcode_verifier=verifier,
                        max_voice_sockets=1,
                        voice_idle_timeout=0.25,
                    )
                    with patch("turnline.server.SpeechModels", return_value=self._mock_models()):
                        async with running(app2) as origin2, httpx.AsyncClient(base_url=origin2, timeout=5) as client2:
                            headers2 = {"Origin": origin2}
                            ws_origin2 = origin2.replace("http://", "ws://", 1)

                            login = await client2.post(
                                "/api/auth/login", headers=headers2, json={"passcode": "my-secret-passcode"}
                            )
                            self.assertEqual(login.status_code, 200)
                            self.assertIn("HttpOnly", login.headers["set-cookie"])
                            self.assertIn("SameSite=strict", login.headers["set-cookie"])

                            sess2 = await client2.get("/api/session")
                            self.assertEqual(sess2.json(), {"connection": "ready", "relay": True, "auth": "passcode"})
                            self.assertEqual((await client2.get("/speech/info")).status_code, 200)
                            created = await client2.post(PREFIX + "/conversations", headers=headers2)
                            self.assertEqual(created.status_code, 200)
                            self.assertEqual(created.json()["id"], CONVERSATION)

                            # Authenticated WS works, 2nd concurrent voice WS hits limit 4429,
                            # and idle timeout closes the first WS.
                            cookie_header = "turnline=" + client2.cookies.get("turnline")
                            with patch("turnline.voice_session.TurnEngine.prepare", return_value=None):
                                async with ws_connect(
                                    ws_origin2 + "/speech/voice",
                                    origin=origin2,
                                    additional_headers={"Cookie": cookie_header},
                                ) as first_ws:
                                    ready_msg = await first_ws.recv()
                                    self.assertIn('"ready"', ready_msg)
                                    with self.assertRaises(ConnectionClosed) as limit_ctx:
                                        async with ws_connect(
                                            ws_origin2 + "/speech/voice",
                                            origin=origin2,
                                            additional_headers={"Cookie": cookie_header},
                                        ) as second_ws:
                                            await second_ws.recv()
                                    self.assertEqual(limit_ctx.exception.rcvd.code, WS_LIMIT_CLOSE_CODE)
                                    # Wait for idle timeout to close first_ws cleanly.
                                    with self.assertRaises(ConnectionClosed):
                                        await asyncio.wait_for(first_ws.recv(), timeout=2)

                            # Logout immediately revokes session.
                            logout = await client2.post("/api/auth/logout", headers=headers2)
                            self.assertEqual(logout.status_code, 200)
                            self.assertEqual((await client2.get("/speech/info")).status_code, 401)
                            self.assertEqual((await client2.get("/api/session")).json()["connection"], "locked")

    async def test_direct_only_with_passcode_and_hsts_header(self):
        with TemporaryDirectory() as directory, patch("turnline.server.SpeechModels", return_value=self._mock_models()):
            verifier = PasscodeVerifier.from_plaintext("direct-passcode-123")
            app = create_app(
                state_dir=Path(directory),
                direct_only=True,
                auth_mode="passcode",
                passcode_verifier=verifier,
                hsts=True,
            )
            transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 4321))
            async with httpx.AsyncClient(base_url="https://voice.example", transport=transport) as client:
                headers = {"origin": "https://voice.example"}
                page = await client.get("/direct")
                self.assertEqual(page.headers.get("strict-transport-security"), "max-age=31536000")
                self.assertEqual((await client.get("/speech/info")).status_code, 401)
                self.assertEqual((await client.get("/api/session")).json(), {"connection": "locked", "auth": "passcode"})

                login = await client.post("/api/auth/login", headers=headers, json={"passcode": "direct-passcode-123"})
                self.assertEqual(login.status_code, 200)
                self.assertIn("__Host-turnline=", login.headers["set-cookie"])
                self.assertIn("Secure", login.headers["set-cookie"])

                self.assertEqual((await client.get("/speech/info")).status_code, 200)
                self.assertEqual(
                    (await client.get("/api/session")).json(),
                    {"connection": "direct", "relay": False, "auth": "passcode"},
                )


class CliAuthValidationTest(unittest.TestCase):
    def test_non_loopback_requires_explicit_auth_mode(self):
        with TemporaryDirectory() as directory:
            stderr = StringIO()
            with patch("sys.stderr", stderr), self.assertRaises(SystemExit) as ctx:
                main(["--host", "0.0.0.0", "--self-signed", "--public-url", "https://192.168.1.5:8686",
                      "--state-dir", directory])
            self.assertEqual(ctx.exception.code, 2)
            self.assertIn("--auth", stderr.getvalue())

    def test_passcode_mode_requires_configured_passcode(self):
        with TemporaryDirectory() as directory:
            stderr = StringIO()
            with patch.dict(os.environ, {}, clear=False), patch("sys.stderr", stderr), self.assertRaises(SystemExit):
                os.environ.pop("TURNLINE_PASSCODE", None)
                os.environ.pop("TURNLINE_PASSCODE_FILE", None)
                main(["--auth", "passcode", "--state-dir", directory])
            self.assertIn("auth set-passcode", stderr.getvalue())

    def test_auth_cli_status_and_revoke(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            save_passcode(state, "cli-test-passcode")
            store = SessionStore(state)
            store.create_authenticated(86400)

            out = StringIO()
            with patch("sys.stdout", out):
                run_auth_command(["status", "--state-dir", str(state)])
            self.assertIn("已配置", out.getvalue())
            self.assertIn("已认证会话数: 1", out.getvalue())

            out2 = StringIO()
            with patch("sys.stdout", out2):
                run_auth_command(["revoke", "--state-dir", str(state)])
            self.assertIn("已吊销 1 个已认证会话", out2.getvalue())
            self.assertEqual(store.authenticated_count(), 0)


if __name__ == "__main__":
    unittest.main()
