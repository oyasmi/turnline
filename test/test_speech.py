import asyncio
import string
import unittest
from contextlib import aclosing
from threading import Event
from time import monotonic

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import tts
from speech import spell_unknown_words
from synthesis import SynthesisBusy, SynthesisQueue


class EnglishSpeechTest(unittest.TestCase):
    def setUp(self):
        self.words = set(string.ascii_lowercase) | {"hello", "kubernetes", "world"}

    def test_known_words_keep_their_reading_and_unknown_words_are_spelled(self):
        self.assertEqual(spell_unknown_words("hello Kubernetes", self.words), "hello Kubernetes")
        self.assertEqual(
            spell_unknown_words("Zebrix-world", self.words).split(),
            ["z", "e", "b", "r", "i", "x", "world"],
        )

    def test_missing_letter_reading_identifies_the_unspoken_word(self):
        with self.assertRaisesRegex(ValueError, "Zebrix"):
            spell_unknown_words("Zebrix", self.words - {"z"})


class SynthesisQueueTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_skips_stale_batches_and_releases_a_waiter(self):
        release_batch = Event()
        ran = []

        class Models:
            def synthesize(self, text, speaker, cancelled, publish):
                ran.append(text)
                publish(text.encode(), 16_000, 0, 1)
                if text == "old":
                    if not release_batch.wait(timeout=5):
                        raise TimeoutError("test did not release the native batch")
                    if not cancelled.is_set():
                        ran.append("stale batch")
                        publish(b"stale", 16_000, 0, 2)

        queue = SynthesisQueue(Models())

        async def collect(text):
            return [pcm async for pcm, *_ in queue.stream(text, 0)]

        async with aclosing(queue.stream("old", 0)) as old:
            try:
                self.assertEqual((await asyncio.wait_for(anext(old), 5))[0], b"old")
                dropped = asyncio.create_task(collect("dropped"))
                next_turn = asyncio.create_task(collect("next"))
                # Both tasks start before this continuation on the same loop.
                tick = asyncio.get_running_loop().create_future()
                asyncio.get_running_loop().call_soon(tick.set_result, None)
                await tick
                with self.assertRaises(SynthesisBusy):
                    await collect("over capacity")
                dropped.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await dropped
                await old.aclose()
                self.assertFalse(next_turn.done())
            finally:
                release_batch.set()
        self.assertEqual(await asyncio.wait_for(next_turn, 5), [b"next"])
        self.assertEqual(ran, ["old", "next"])

    async def test_disconnected_http_stream_stops_native_work(self):
        stopped = Event()
        pcm = b"\x00\x00\x80\x3f"

        class Models:
            def synthesize(self, text, speaker, cancelled, publish):
                now = monotonic()
                publish(pcm, 16_000, now, now)
                if text == "old" and cancelled.wait(timeout=5):
                    stopped.set()

        queue = SynthesisQueue(Models())
        app = web.Application()

        async def generate(request):
            return await tts(request, queue)

        app.router.add_post("/synthesize", generate)
        async with TestClient(TestServer(app, handler_cancellation=True)) as client:
            old = await asyncio.wait_for(client.post("/synthesize", json={"text": "old", "speaker": 0}), 5)
            self.assertIn("tts-first-pcm", old.headers["Server-Timing"])
            self.assertEqual(await asyncio.wait_for(old.content.readexactly(4), 5), pcm)
            old.close()
            self.assertTrue(await asyncio.to_thread(stopped.wait, 5))
            fresh = await asyncio.wait_for(client.post("/synthesize", json={"text": "new", "speaker": 0}), 5)
            self.assertEqual(await asyncio.wait_for(fresh.read(), 5), pcm)
