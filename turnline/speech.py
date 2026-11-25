"""Local SenseVoice recognition and Matcha speech synthesis."""

import asyncio
from functools import cached_property, lru_cache
from threading import Event, Lock
from time import monotonic

import numpy as np
import sherpa_onnx

from .phonemizer import MatchaFrontend, speech_text
from .setup_models import MATCHA, MATCHA_MODEL, MATCHA_VOCODER, MODELS, SENSE_VOICE, SILERO
from .synthesis import SpeechSlot, shape_audio

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
VAD_BUFFER_SECONDS = 30
PRE_ROLL_SAMPLES = 6 * FRAME_SAMPLES
HISTORY_CAPACITY = VAD_BUFFER_SECONDS * SAMPLE_RATE + PRE_ROLL_SAMPLES
SETUP_HINT = "请在 Turnline 仓库根目录运行 uv run python setup_models.py。"

def require(*paths):
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"语音模型缺少 {path.name}。{SETUP_HINT}")


class SpeechModels:
    engine = "matcha"
    voice_choices = ((0, "Matcha · 中英双语"),)
    common_phrases = ("我在查，稍等一下。", "I’m checking. One moment.")

    def __init__(self, tts_threads=2):
        self.tts_threads = tts_threads
        self.recognition_lock = Lock()
        self.synthesis_lock = Lock()

    @cached_property
    def recognizer(self):
        model = MODELS / SENSE_VOICE / "model.int8.onnx"
        tokens = MODELS / SENSE_VOICE / "tokens.txt"
        require(model, tokens)
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model),
            tokens=str(tokens),
            language="auto",
            use_itn=True,
            num_threads=2,
        )

    @cached_property
    def matcha(self):
        folder = MODELS / MATCHA
        acoustic = folder / MATCHA_MODEL
        vocoder = MODELS / MATCHA_VOCODER
        tokens = folder / "tokens.txt"
        rules = [folder / name for name in ("phone-zh.fst", "date-zh.fst", "number-zh.fst")]
        require(acoustic, vocoder, tokens, *rules)
        frontend = MatchaFrontend(tokens, rules)
        model = sherpa_onnx.OfflineTtsModelConfig(
            matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
                acoustic_model=str(acoustic), vocoder=str(vocoder), tokens=str(tokens),
            ),
            num_threads=self.tts_threads,
        )
        config = sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1)
        if not config.validate():
            raise RuntimeError("语音模型配置无效。请检查模型文件。")
        return sherpa_onnx.OfflineTts(config), frontend

    def prepare_recognition(self):
        with self.recognition_lock:
            return self.recognizer

    def prepare_synthesis(self):
        with self.synthesis_lock:
            return self.matcha[0].num_speakers

    def warm_recognition(self):
        self.recognize(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))

    def warm_synthesis(self):
        for text in ("你好，hello。", *self.common_phrases):
            self.synthesize(text, 0, Event(), lambda *_: True)

    def recognize(self, samples):
        with self.recognition_lock:
            recognizer = self.recognizer
            stream = recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            recognizer.decode_stream(stream)
            return stream.result.text.strip()

    @lru_cache(maxsize=8)
    def cached_phrase(self, text, speed):
        return self.generate(text, speed, Event())

    def generate(self, text, speed, cancelled):
        voice, frontend = self.matcha
        config = sherpa_onnx.GenerationConfig()
        config.speed = speed
        normalized = speech_text(text)
        tokens = frontend.tokens(normalized)
        if not tokens:
            raise ValueError("找不到可播报的文字。")
        config.tokens = [tokens]
        audio = voice.generate("", config, callback=lambda *_: int(not cancelled.is_set()))
        if cancelled.is_set():
            return None
        pcm = np.asarray(audio.samples, dtype="<f4")
        if not pcm.size or not np.isfinite(pcm).all():
            raise RuntimeError("语音模型未生成可播放音频。")
        pcm = shape_audio(pcm, voice.sample_rate, text, normalized)
        return pcm.tobytes(), voice.sample_rate

    def synthesize(self, text, speaker, cancelled, publish, speed=1.0):
        with self.synthesis_lock:
            if cancelled.is_set():
                return
            started = monotonic()
            if speaker != 0:
                raise ValueError("请选择有效的音色。")
            audio = (self.cached_phrase(text, speed) if text in self.common_phrases
                     else self.generate(text, speed, cancelled))
            if audio is not None and not cancelled.is_set():
                publish(*audio, started, monotonic())


class RecognitionQueue:
    def __init__(self, models, slot=None):
        self.models = models
        self.slot = slot or SpeechSlot()
        self.waiting = 0

    async def transcribe(self, samples, is_current, *, final=True):
        if not final and self.slot.busy:
            return None
        if self.waiting >= 4:
            raise ValueError("语音识别繁忙，请再说一遍。")
        self.waiting += 1
        try:
            await self.slot.acquire(1 if final else 2)
        finally:
            self.waiting -= 1
        if not is_current():
            self.slot.release()
            return None

        loop = asyncio.get_running_loop()
        try:
            worker = loop.run_in_executor(None, self.models.recognize, samples)
        except BaseException:
            self.slot.release()
            raise

        def finished(result):
            self.slot.release()
            if not result.cancelled():
                result.exception()

        worker.add_done_callback(finished)
        return await asyncio.shield(worker)


class VoiceActivity:
    def __init__(self, *, minimum=0.128, threshold=0.55, silence=0.256, maximum=8, preroll=PRE_ROLL_SAMPLES):
        self.minimum = minimum
        self.threshold = threshold
        self.silence = silence
        self.maximum = maximum
        self.preroll = preroll
        self.detecting = False
        self.detector = None
        self.history = sherpa_onnx.CircularBuffer(HISTORY_CAPACITY)
        self.last_segment_end = 0

    def reset(self):
        self.detecting = False
        self.history.reset()
        self.last_segment_end = 0
        if self.detector is not None:
            self.detector.reset()
            return
        model = MODELS / SILERO
        require(model)
        config = sherpa_onnx.VadModelConfig()
        config.sample_rate = SAMPLE_RATE
        config.silero_vad.model = str(model)
        config.silero_vad.threshold = self.threshold
        config.silero_vad.min_speech_duration = self.minimum
        config.silero_vad.min_silence_duration = self.silence
        config.silero_vad.max_speech_duration = self.maximum
        config.silero_vad.window_size = FRAME_SAMPLES
        self.detector = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=VAD_BUFFER_SECONDS)

    def accept(self, samples):
        excess = self.history.size + FRAME_SAMPLES - HISTORY_CAPACITY
        if excess > 0:
            self.history.pop(excess)
        self.history.push(samples)
        self.detector.accept_waveform(samples)
        detected = self.detector.is_speech_detected()
        started = detected and not self.detecting
        self.detecting = detected
        segments = []
        while not self.detector.empty():
            segment = self.detector.front
            samples = segment.samples
            # Silero can start after the first phoneme. Restore only audio from
            # this epoch and leave samples from previously delivered turns out.
            prefix_start = max(self.history.head, self.last_segment_end, segment.start - self.preroll)
            self.last_segment_end = segment.start + len(samples)
            if prefix_start < segment.start:
                samples = self.history.get(prefix_start, segment.start - prefix_start) + samples
            segments.append((prefix_start, self.last_segment_end, np.asarray(samples, dtype=np.float32)))
            self.detector.pop()
        return started, segments
