import asyncio
import unittest
from contextlib import aclosing
from threading import Event
from time import monotonic
import wave

from fastapi import FastAPI, Request
import httpx
import numpy as np

from server import tts
from phonemizer import MatchaFrontend, speech_text
from setup_models import MATCHA, MODELS, SENSE_VOICE, SILERO
from speech import FRAME_SAMPLES, SAMPLE_RATE, RecognitionQueue, SpeechModels, VoiceActivity
from synthesis import AUDIBLE_THRESHOLD, SpeechSlot, SynthesisBusy, SynthesisQueue, shape_audio
from support import running


class BilingualSpeechTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = MODELS / MATCHA
        if not (folder / "tokens.txt").is_file():
            raise unittest.SkipTest("Run setup_models.py to install the Matcha frontend resources.")
        rules = [folder / filename for filename in ("phone-zh.fst", "date-zh.fst", "number-zh.fst")]
        cls.frontend = MatchaFrontend(folder / "tokens.txt", rules)

    def test_mixed_sentence_preserves_context_and_punctuation(self):
        tokens = self.frontend.tokens
        mixed = tokens("国内：MiniMax 发布 H3 Family，包含 H3-Highspeed、H3-Lite。")
        self.assertEqual(mixed[:3], ["guo2", "nei4", ":"])
        for phrase in ("MiniMax", "H3 Family", "H3-Highspeed", "H3-Lite"):
            english = tokens(phrase)
            self.assertTrue(english)
            self.assertIn(" ".join(english), " ".join(mixed))
        self.assertEqual(mixed.count(","), 2)
        self.assertEqual(mixed[-1], ".")

    def test_new_names_use_word_pronunciation_and_versions_are_general(self):
        tokens = self.frontend.tokens
        name = tokens("Zebrix")
        self.assertTrue(name)
        self.assertNotEqual(name, tokens("Z E B R I X"))
        self.assertIn(" ".join(name), " ".join(tokens("今天发布 Zebrix X7-Pro 语音模型。")))
        self.assertEqual(tokens("Ｖ４.２"), tokens("V four point two"))
        self.assertEqual(tokens("X7-Pro"), tokens("X seven Pro"))

    def test_preserves_chinese_number_rules_and_contextual_pinyin(self):
        tokens = self.frontend.tokens
        self.assertEqual(tokens("下载量超过1.48亿次"), tokens("下载量超过一点四八亿次"))
        self.assertIn(" ".join(tokens("拨打幺幺零")), " ".join(tokens("请拨打110")))
        self.assertEqual(tokens("重庆银行行长"), ["chong2", "qing4", "yin2", "hang2", "hang2", "zhang3"])


    def test_shared_speech_normalizer_expands_percentages_units_and_paths(self):
        self.assertEqual(speech_text("《红楼梦》。占用 37%，\x60~/.cache\x60 约 6.5GB。"),
                         "红楼梦。占用 百分之37，家目录的点 cache 约 6.5吉字节。")
        self.assertEqual(speech_text("Disk is at 37%. Cache takes 6.5GB."),
                         "Disk is at 37 percent. Cache takes 6.5 gigabytes.")

    def test_matcha_to_sensevoice_preserves_percentage_and_capacity(self):
        if not (MODELS / SENSE_VOICE / "model.int8.onnx").is_file():
            self.skipTest("Run setup_models.py to install SenseVoice.")
        models = SpeechModels()
        heard = []

        def read_back(pcm, rate, *_):
            audio = np.frombuffer(pcm, dtype="<f4")
            indices = np.arange(0, len(audio) - 1, rate / SAMPLE_RATE)
            audio = np.interp(indices, np.arange(len(audio)), audio).astype(np.float32)
            heard.append(models.recognize(audio))

        models.synthesize("磁盘已经使用37%，还剩6.5GB。", 0, Event(), read_back)
        self.assertEqual(len(heard), 1)
        self.assertIn("37%", heard[0])
        self.assertIn("6.5", heard[0])
        self.assertIn("字节", heard[0])


class AudioShapingTest(unittest.TestCase):
    def test_trims_edges_and_adds_pause_for_punctuation(self):
        rate = 16_000
        audio = np.pad(np.full(1600, 0.25, dtype="<f4"), (2560, 1728))
        for text, pause in (("继续，", 0.12), ("结束。", 0.26), ("换一段。\n\n", 0.4)):
            with self.subTest(text=text):
                shaped = shape_audio(audio, rate, text, text.strip())
                first = np.flatnonzero(np.abs(shaped) >= AUDIBLE_THRESHOLD)[0]
                self.assertEqual(first, 320)
                self.assertEqual(len(shaped), 320 + 1600 + round(rate * pause))
                self.assertEqual(shaped[320 + 1599], 0)


class VoiceActivityTest(unittest.TestCase):
    def test_rejects_a_short_clip_and_keeps_speech_across_a_normal_pause(self):
        fixture = MODELS / SENSE_VOICE / "test_wavs" / "zh.wav"
        if not fixture.is_file() or not (MODELS / SILERO).is_file():
            self.skipTest("Run setup_models.py to install the speech fixtures.")
        with wave.open(str(fixture)) as recording:
            self.assertEqual(recording.getframerate(), SAMPLE_RATE)
            signal = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2").astype("<f4") / 32768
        active = np.flatnonzero(np.abs(signal) > 0.02)
        voice = signal[active[0]:active[-1] + 1]
        silence = np.zeros(3 * SAMPLE_RATE, dtype="<f4")
        listener = VoiceActivity(minimum=0.32, silence=2.2, maximum=20)

        def detect(samples):
            listener.reset()
            audio = np.concatenate((samples, silence))
            segments = []
            starts = 0
            for i in range(0, len(audio) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
                started, available = listener.accept(audio[i:i + FRAME_SAMPLES])
                starts += started
                segments.extend(available)
            return starts, segments

        self.assertEqual(detect(voice[:int(0.22 * SAMPLE_RATE)]), (0, []))
        gap = np.zeros(int(1.7 * SAMPLE_RATE), dtype="<f4")
        starts, segments = detect(np.concatenate((voice, gap, voice)))
        self.assertEqual(starts, 1)
        self.assertEqual(len(segments), 1)


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


class SpeechPriorityTest(unittest.IsolatedAsyncioTestCase):
    async def test_pending_synthesis_precedes_final_asr_and_partial_skips_busy_slot(self):
        class Models:
            def recognize(self, _samples):
                order.append("recognition")

        order = []
        slot = SpeechSlot()
        recognition = RecognitionQueue(Models(), slot)
        await slot.acquire(0)

        async def synthesize():
            await slot.acquire(0)
            order.append("synthesis")
            slot.release()

        final = asyncio.create_task(recognition.transcribe("audio", lambda: True))
        await asyncio.sleep(0)
        synthesis = asyncio.create_task(synthesize())
        await asyncio.sleep(0)
        self.assertIsNone(await recognition.transcribe("preview", lambda: True, final=False))
        slot.release()
        await asyncio.gather(synthesis, final)
        self.assertEqual(order, ["synthesis", "recognition"])


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
