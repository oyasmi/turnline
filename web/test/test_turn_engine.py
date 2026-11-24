import asyncio
import unittest
import wave

import numpy as np

from setup_models import MODELS, SENSE_VOICE, SILERO
from speech import FRAME_SAMPLES, SAMPLE_RATE
from turn_engine import TurnEngine, endpoint_wait


class EndpointTest(unittest.TestCase):
    def test_adapts_to_completion_context_and_settings(self):
        cases = [
            ("明天北京天气怎么样？", 2, "balanced", False, 480),
            ("明天北京天气怎么样", 2, "quick", False, 360),
            ("我想问一下。", 1, "balanced", False, 1900),
            ("我想问一下，然后。", 1.5, "patient", False, 2850),
            ("我想看看", 1.5, "balanced", False, 900),
            ("好", 0.25, "balanced", True, 480),
            ("好", 0.25, "balanced", False, 900),
            ("查", 0.25, "balanced", False, 1800),
            ("please go ahead.", 1, "patient", False, 720),
            ("I want to", 0.8, "balanced", False, 1900),
        ]
        for text, duration, speed, question, expected in cases:
            with self.subTest(text=text, speed=speed, question=question):
                self.assertEqual(endpoint_wait(text, duration, speed, question), expected)


class CaptureTurnTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        fixture = MODELS / SENSE_VOICE / "test_wavs" / "zh.wav"
        if not fixture.is_file() or not (MODELS / SILERO).is_file():
            self.skipTest("Run setup_models.py to install the speech fixtures.")
        with wave.open(str(fixture)) as file:
            self.assertEqual(file.getframerate(), SAMPLE_RATE)
            audio = np.frombuffer(file.readframes(file.getnframes()), dtype="<i2")
        active = np.flatnonzero(np.abs(audio) >= 650)
        self.voice = audio[active[0]:active[-1] + 1]
        self.events = []

    async def run_audio(self, audio, transcripts, force_at=None):
        output = iter(transcripts)

        class Recognition:
            async def transcribe(self, _samples, current, *, final=True):
                if not current():
                    return None
                if not final:
                    return "正在转写"
                return next(output, "一个连续的测试句子。")

        async def emit(event):
            self.events.append(event)

        engine = TurnEngine(Recognition(), emit)
        engine.prepare()
        await engine.set_mode("listen")
        worker = asyncio.create_task(engine.transcribe())
        try:
            for start in range(0, len(audio) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
                await engine.accept(audio[start:start + FRAME_SAMPLES].tobytes())
                await asyncio.sleep(0)
                if force_at and start <= force_at < start + FRAME_SAMPLES:
                    await engine.force_commit()
                    await asyncio.sleep(0)
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)

    @staticmethod
    def silence(seconds):
        return np.zeros(round(seconds * SAMPLE_RATE), dtype="<i2")

    async def test_natural_hesitation_stays_in_one_turn(self):
        audio = np.concatenate([self.voice, self.silence(0.9), self.voice, self.silence(1)])
        await self.run_audio(audio, ["我想问一下。", "明天北京天气怎么样？"])
        kinds = [event["type"] for event in self.events]
        self.assertEqual(kinds.count("speech-start"), 1)
        self.assertIn("resumed", kinds)
        self.assertLess(kinds.index("partial"), kinds.index("tentative"))
        commits = [event for event in self.events if event["type"] == "commit"]
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["text"], "明天北京天气怎么样？")
        self.assertGreaterEqual(commits[0]["silenceWaitMs"], 480)
        self.assertLess(commits[0]["silenceWaitMs"], 512)

    async def test_long_dictation_crosses_internal_chunk_boundaries(self):
        audio = np.concatenate([self.voice] * 6 + [self.silence(2)])
        self.assertGreater(len(audio) / SAMPLE_RATE, 20)
        await self.run_audio(audio, [])
        self.assertEqual(sum(event["type"] == "speech-start" for event in self.events), 1)
        self.assertEqual(sum(event["type"] == "commit" for event in self.events), 1)
        self.assertGreater(sum(event["type"] == "partial" for event in self.events), 2)

    async def test_force_commit_does_not_wait_for_silero_to_close_the_unit(self):
        await self.run_audio(self.voice[:SAMPLE_RATE * 2], ["立即提交"], force_at=SAMPLE_RATE * 2 - 600)
        commits = [event for event in self.events if event["type"] == "commit"]
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["text"], "立即提交")
        self.assertEqual(commits[0]["silenceWaitMs"], 0)
