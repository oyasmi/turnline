import asyncio
import unittest
from contextlib import aclosing
from threading import Event
from time import monotonic

from fastapi import FastAPI, Request
import httpx

from server import tts
from pronunciation import spoken_english
from speech import RecognitionQueue
from synthesis import SynthesisBusy, SynthesisQueue
from support import running


class EnglishSpeechTest(unittest.TestCase):
    def test_english_is_casefolded_and_an_unknown_name_is_spelled(self):
        words = set("abcdefghijklmnopqrstuvwxyz") | {"hello", "kubernetes", "world", "thirty", "seven", "percent"}
        text = spoken_english("你好 Hello Kubernetes Zebrix-world", words)
        self.assertEqual(text.split(), ["你好", "hello", "kubernetes", "z", "e", "b", "r", "i", "x", "world"])
        self.assertEqual(spoken_english("37 percent.", words), "thirty seven percent.")


class RecognitionQueueTest(unittest.IsolatedAsyncioTestCase):
    async def test_reset_skips_queued_audio_and_disconnect_keeps_the_native_slot(self):
        started, release = Event(), Event()
        calls = []
        current = True

        class Models:
            def recognize(self, segment):
                calls.append(segment)
                if segment == "running":
                    started.set()
                    if not release.wait(timeout=5):
                        raise TimeoutError("test did not release recognition")
                return segment

        queue = RecognitionQueue(Models())
        running_job = asyncio.create_task(queue.transcribe("running", lambda: True))
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 5))
            stale = asyncio.create_task(queue.transcribe("stale", lambda: current))
            fresh = asyncio.create_task(queue.transcribe("fresh", lambda: True))
            await asyncio.sleep(0)
            current = False
            running_job.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await running_job
            self.assertFalse(fresh.done())
        finally:
            release.set()
        self.assertIsNone(await asyncio.wait_for(stale, 5))
        self.assertEqual(await asyncio.wait_for(fresh, 5), "fresh")
        self.assertEqual(calls, ["running", "fresh"])


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

    async def test_disconnected_http_stream_stops_native_work_before_and_after_first_chunk(self):
        started = Event()
        stopped = Event()
        pcm = b"\x00\x00\x80\x3f"

        class Models:
            voice_choices = ((0, "Matcha"),)

            def synthesize(self, text, speaker, cancelled, publish):
                started.set()
                now = monotonic()
                if text != "before":
                    publish(pcm, 16_000, now, now)
                if text != "new" and cancelled.wait(timeout=5):
                    stopped.set()

        queue = SynthesisQueue(Models())
        app = FastAPI()

        @app.post("/synthesize")
        async def generate(request: Request):
            return await tts(request, queue)

        async with running(app) as origin, httpx.AsyncClient(base_url=origin, timeout=5) as client:
            before = asyncio.create_task(client.post("/synthesize", json={"text": "before", "speaker": 0}))
            self.assertTrue(await asyncio.to_thread(started.wait, 5))
            before.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await before
            self.assertTrue(await asyncio.to_thread(stopped.wait, 5))
            stopped.clear()

            async with client.stream("POST", "/synthesize", json={"text": "old", "speaker": 0}) as old:
                self.assertIn("tts-first-pcm", old.headers["Server-Timing"])
                self.assertEqual(await anext(old.aiter_bytes()), pcm)
            self.assertTrue(await asyncio.to_thread(stopped.wait, 5))
            fresh = await client.post("/synthesize", json={"text": "new", "speaker": 0})
            self.assertEqual(fresh.content, pcm)
