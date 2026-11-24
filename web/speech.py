"""Local SenseVoice recognition and Matcha speech synthesis."""

import asyncio
from functools import cached_property
from threading import Event, Lock
from time import monotonic

import numpy as np
import sherpa_onnx

from phonemizer import MatchaFrontend
from setup_models import MATCHA, MATCHA_MODEL, MATCHA_VOCODER, MODELS, SENSE_VOICE, SILERO

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
MIN_SPEECH_SECONDS = 0.32
DEFAULT_SILENCE_SECONDS = 2.2
SILENCE_OPTIONS = {1.0, 1.5, DEFAULT_SILENCE_SECONDS, 3.0}
LEGACY_SILENCE_OPTIONS = {0.35: 1.0, 0.5: 1.5, 0.8: DEFAULT_SILENCE_SECONDS, 1.2: 3.0}
VAD_BUFFER_SECONDS = 30
PRE_ROLL_SAMPLES = 2 * FRAME_SAMPLES
HISTORY_CAPACITY = VAD_BUFFER_SECONDS * SAMPLE_RATE + PRE_ROLL_SAMPLES
SETUP_HINT = "请在 Turnline 的 web/ 目录运行 uv run python setup_models.py。"

def require(*paths):
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"语音模型缺少 {path.name}。{SETUP_HINT}")


class SpeechModels:
    engine = "matcha"
    voice_choices = ((0, "Matcha · 中英双语"),)

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
        self.synthesize("你好，hello。", 0, Event(), lambda *_: True)

    def recognize(self, samples):
        with self.recognition_lock:
            recognizer = self.recognizer
            stream = recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            recognizer.decode_stream(stream)
            return stream.result.text.strip()

    def synthesize(self, text, speaker, cancelled, publish):
        with self.synthesis_lock:
            if cancelled.is_set():
                return
            started = monotonic()
            voice, frontend = self.matcha
            if speaker != 0:
                raise ValueError("请选择有效的音色。")
            config = sherpa_onnx.GenerationConfig()
            config.sid = speaker
            config.speed = 1.07
            tokens = frontend.tokens(text)
            if not tokens:
                raise ValueError("找不到可播报的文字。")
            config.tokens = [tokens]
            has_audio = False

            def on_pcm(samples, _progress):
                nonlocal has_audio
                if cancelled.is_set():
                    return 0
                pcm = np.asarray(samples, dtype="<f4")
                if not np.isfinite(pcm).all():
                    raise RuntimeError("语音模型返回了无效音频。请重试或改用文字。")
                if pcm.size and (has_audio or np.abs(pcm).max() > 1e-6):
                    has_audio = True
                    return int(publish(pcm.tobytes(), voice.sample_rate, started, monotonic()))
                return 1

            if cancelled.is_set():
                return
            voice.generate("", config, callback=on_pcm)
            if not has_audio and not cancelled.is_set():
                raise RuntimeError("语音模型未生成可播放音频。请重试或改用文字。")


class RecognitionQueue:
    def __init__(self, models):
        self.models = models
        self.slot = asyncio.Lock()
        self.waiting = 0

    async def transcribe(self, samples, is_current):
        if self.waiting >= 2:
            raise ValueError("语音识别繁忙，请稍后重新开始通话。")
        self.waiting += 1
        try:
            await self.slot.acquire()
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


class ListeningTurn:
    def __init__(self):
        self.silence = None
        self.epoch = 0
        self.detecting = False
        self.detector = None
        self.history = sherpa_onnx.CircularBuffer(HISTORY_CAPACITY)
        self.last_segment_end = 0

    def reset(self, epoch, silence):
        self.epoch = epoch
        self.detecting = False
        self.history.reset()
        self.last_segment_end = 0
        if self.detector is not None and silence == self.silence:
            self.detector.reset()
            return
        model = MODELS / SILERO
        require(model)
        config = sherpa_onnx.VadModelConfig()
        config.sample_rate = SAMPLE_RATE
        config.silero_vad.model = str(model)
        config.silero_vad.threshold = 0.55
        config.silero_vad.min_speech_duration = MIN_SPEECH_SECONDS
        config.silero_vad.min_silence_duration = silence
        config.silero_vad.max_speech_duration = 20.0
        config.silero_vad.window_size = FRAME_SAMPLES
        self.detector = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=VAD_BUFFER_SECONDS)
        self.silence = silence

    def accept(self, payload):
        if len(payload) != FRAME_SAMPLES * 4:
            raise ValueError("需要 512 个 16 kHz 单声道浮点样本。")
        samples = np.frombuffer(payload, dtype="<f4")
        if not np.isfinite(samples).all():
            raise ValueError("收到无效的音频样本。")
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
            prefix_start = max(self.history.head, self.last_segment_end, segment.start - PRE_ROLL_SAMPLES)
            self.last_segment_end = segment.start + len(samples)
            if prefix_start < segment.start:
                samples = self.history.get(prefix_start, segment.start - prefix_start) + samples
            segments.append(samples)
            self.detector.pop()
        return started, segments
