import asyncio
import unittest
import wave

import numpy as np

from turnline.setup_models import MODELS, SENSE_VOICE, SILERO
from turnline.speech import FRAME_SAMPLES, SAMPLE_RATE
from turnline.turn_engine import TurnEngine, endpoint_wait


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
        self.recognition_calls = []

    async def run_audio(self, audio, transcripts, *, force_at=None, minimum=None, manual=False):
        output = iter(transcripts)
        calls = self.recognition_calls

        class Recognition:
            async def transcribe(self, _samples, current, *, final=True):
                if not current():
                    return None
                calls.append(final)
                if not final:
                    return "正在转写"
                return next(output, "一个连续的测试句子。")

        async def emit(event):
            self.events.append(event)

        engine = TurnEngine(Recognition(), emit)
        if minimum is not None:
            engine.min_voice_seconds = minimum
        engine.manual = manual
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

    async def test_short_voice_is_dropped_before_recognition_even_with_a_pause(self):
        clip = self.voice[:round(0.92 * SAMPLE_RATE)]
        audio = np.concatenate([clip, self.silence(0.9), clip, self.silence(3)])
        await self.run_audio(audio, [])
        self.assertIn("resumed", [event["type"] for event in self.events])
        commits = [event for event in self.events if event["type"] == "commit"]
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["text"], "")
        self.assertGreater(commits[0]["voiceEndSample"] - commits[0]["startSample"], 2 * SAMPLE_RATE)
        self.assertLess(commits[0]["voicedMs"], 2000)
        self.assertEqual(self.recognition_calls, [])

    async def test_voice_across_two_short_phrases_reaches_the_threshold(self):
        clip = self.voice[:round(1.4 * SAMPLE_RATE)]
        audio = np.concatenate([clip, self.silence(0.9), clip, self.silence(3)])
        await self.run_audio(audio, ["继续说完了。"])
        resumed = next(i for i, event in enumerate(self.events) if event["type"] == "resumed")
        self.assertEqual([event["type"] for event in self.events[:resumed]], ["speech-start"])
        commits = [event for event in self.events if event["type"] == "commit"]
        self.assertEqual([event["text"] for event in commits], ["继续说完了。"])
        self.assertGreaterEqual(commits[0]["voicedMs"], 2000)

    async def test_disabling_filter_allows_short_voice(self):
        clip = self.voice[:SAMPLE_RATE]
        await self.run_audio(np.concatenate([clip, self.silence(3)]), ["现在几点？"], minimum=0)
        self.assertTrue(self.recognition_calls)
        self.assertEqual([event["text"] for event in self.events if event["type"] == "commit"], ["现在几点？"])

    async def test_manual_release_drops_short_voice_after_a_long_hold(self):
        clip = self.voice[:SAMPLE_RATE]
        audio = np.concatenate([clip, self.silence(4)])
        await self.run_audio(audio, [], force_at=4 * SAMPLE_RATE, manual=True)
        self.assertEqual(self.recognition_calls, [])
        self.assertEqual([event["text"] for event in self.events if event["type"] == "commit"], [""])

    async def test_long_dictation_crosses_internal_chunk_boundaries(self):
        audio = np.concatenate([self.voice] * 6 + [self.silence(2)])
        self.assertGreater(len(audio) / SAMPLE_RATE, 20)
        await self.run_audio(audio, [])
        self.assertEqual(sum(event["type"] == "speech-start" for event in self.events), 1)
        self.assertEqual(sum(event["type"] == "commit" for event in self.events), 1)
        self.assertGreater(sum(event["type"] == "partial" for event in self.events), 2)

    async def test_force_commit_does_not_wait_for_silero_to_close_the_unit(self):
        await self.run_audio(self.voice[:SAMPLE_RATE * 2], ["立即提交"], force_at=SAMPLE_RATE * 2 - 600, minimum=1)
        commits = [event for event in self.events if event["type"] == "commit"]
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["text"], "立即提交")
        self.assertEqual(commits[0]["silenceWaitMs"], 0)

    async def test_force_commit_drops_short_active_voice(self):
        await self.run_audio(self.voice[:SAMPLE_RATE], [], force_at=SAMPLE_RATE - 600)
        self.assertEqual(self.recognition_calls, [])
        self.assertEqual([event["text"] for event in self.events if event["type"] == "commit"], [""])
