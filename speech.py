"""Local SenseVoice recognition and speech synthesis."""

from functools import cached_property
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic

import numpy as np
import sherpa_onnx

from pronunciation import ENGLISH_LEXICON, build_lexicon, spoken_english
from setup_models import MATCHA, MATCHA_MODEL, MATCHA_VOCODER, MODELS, SENSE_VOICE, SILERO

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
VAD_BUFFER_SECONDS = 30
PRE_ROLL_SAMPLES = 2 * FRAME_SAMPLES
HISTORY_CAPACITY = VAD_BUFFER_SECONDS * SAMPLE_RATE + PRE_ROLL_SAMPLES
SETUP_HINT = "请在 Turnline 项目目录运行 uv run python setup_models.py。"

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
        lexicon = folder / "lexicon.txt"
        tokens = folder / "tokens.txt"
        english = MODELS / ENGLISH_LEXICON
        rules = [folder / name for name in ("phone-zh.fst", "date-zh.fst", "number-zh.fst")]
        require(acoustic, vocoder, lexicon, tokens, english, *rules)
        with TemporaryDirectory(prefix="turnline-matcha-") as directory:
            bilingual = Path(directory) / "lexicon.txt"
            words = build_lexicon(bilingual, lexicon, english, tokens)
            model = sherpa_onnx.OfflineTtsModelConfig(
                matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
                    acoustic_model=str(acoustic), vocoder=str(vocoder), tokens=str(tokens),
                    lexicon=str(bilingual),
                ),
                num_threads=self.tts_threads,
            )
            config = sherpa_onnx.OfflineTtsConfig(
                model=model,
                rule_fsts=",".join(map(str, rules)),
                max_num_sentences=1,
            )
            if not config.validate():
                raise RuntimeError("语音模型配置无效。请检查模型文件。")
            return sherpa_onnx.OfflineTts(config), words

    def prepare_recognition(self):
        with self.recognition_lock:
            return self.recognizer

    def prepare_synthesis(self):
        with self.synthesis_lock:
            return self.matcha[0].num_speakers

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
            voice, words = self.matcha
            if speaker != 0:
                raise ValueError("请选择有效的音色。")
            config = sherpa_onnx.GenerationConfig()
            config.sid = speaker
            config.speed = 1.07
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
            voice.generate(spoken_english(text, words), config, callback=on_pcm)
            if not has_audio and not cancelled.is_set():
                raise RuntimeError("语音模型未生成可播放音频。请重试或改用文字。")


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
        config.silero_vad.min_speech_duration = 0.18
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
