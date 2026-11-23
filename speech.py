"""Local SenseVoice recognition and speech synthesis."""

import re
from functools import cached_property
from pathlib import Path
from threading import Lock
from time import monotonic

import numpy as np
import sherpa_onnx

from setup_models import KOKORO, MATCHA, MATCHA_MODEL, MATCHA_VOCODER, MODELS, SENSE_VOICE, SILERO

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
VAD_BUFFER_SECONDS = 30
PRE_ROLL_SAMPLES = 2 * FRAME_SAMPLES
HISTORY_CAPACITY = VAD_BUFFER_SECONDS * SAMPLE_RATE + PRE_ROLL_SAMPLES
SETUP_HINT = "请在 Turnline 项目目录运行 uv run python setup_models.py。"
ENGLISH_WORD = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
ENGLISH_LEXICON = MODELS / KOKORO / "lexicon-us-en.txt"
TECH_LEXICON = Path(__file__).resolve().with_name("kokoro-lexicon.txt")


def load_english_words(*paths):
    words = set()
    for path in paths:
        with path.open(encoding="utf-8") as source:
            for line in source:
                fields = line.split(maxsplit=1)
                if len(fields) == 2:
                    words.add(fields[0].lower())
    return words


def spell_unknown_words(text, known_words):
    def pronunciation(match):
        original = match.group()
        word = original.lower().replace("’", "'")
        if word in known_words:
            return original
        parts = word.split("-")
        for index, part in enumerate(parts):
            if part in known_words:
                continue
            letters = part.replace("'", "")
            if not all(letter in known_words for letter in letters):
                raise ValueError(f"无法播报英文词「{original}」。请改用文字查看。")
            parts[index] = " ".join(letters)
        # Separate expanded letters from adjacent digits or punctuation.
        return " " + " ".join(parts) + " "

    return ENGLISH_WORD.sub(pronunciation, text)


def require(*paths):
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"语音模型缺少 {path.name}。{SETUP_HINT}")


class SpeechModels:
    def __init__(self, tts_engine="auto", tts_threads=2):
        self.tts_threads = tts_threads
        if tts_engine == "auto":
            has_matcha = (MODELS / MATCHA / MATCHA_MODEL).is_file() and (MODELS / MATCHA_VOCODER).is_file()
            has_kokoro = (MODELS / KOKORO / "model.int8.onnx").is_file()
            if has_matcha and has_kokoro:
                tts_engine = "hybrid"
            else:
                tts_engine = "matcha" if has_matcha or not has_kokoro else "kokoro"
        self.engine = tts_engine
        self.recognition_lock = Lock()
        self.synthesis_lock = Lock()

    @property
    def voice_choices(self):
        kokoro = [(3, "女声 · Kokoro"), (58, "男声 · Kokoro")]
        if self.engine == "matcha":
            return [(0, "女声 · Matcha")]
        if self.engine == "hybrid":
            return [(0, "自动 · 优先使用 Matcha"), *kokoro]
        return kokoro

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
    def english_words(self):
        return load_english_words(ENGLISH_LEXICON, TECH_LEXICON)

    @cached_property
    def matcha(self):
        return self.load_voice("matcha")

    @cached_property
    def kokoro(self):
        return self.load_voice("kokoro")

    def load_voice(self, engine):
        folder = MODELS / (MATCHA if engine == "matcha" else KOKORO)
        tokens = folder / "tokens.txt"
        rules = [folder / name for name in ["date-zh.fst", "number-zh.fst", "phone-zh.fst"]]
        require(tokens, *rules)
        if engine == "matcha":
            acoustic = folder / MATCHA_MODEL
            vocoder = MODELS / MATCHA_VOCODER
            lexicon = folder / "lexicon.txt"
            require(acoustic, vocoder, lexicon)
            model = sherpa_onnx.OfflineTtsModelConfig(
                matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
                    acoustic_model=str(acoustic), vocoder=str(vocoder), tokens=str(tokens),
                    lexicon=str(lexicon),
                ),
                num_threads=self.tts_threads,
            )
        else:
            onnx = folder / "model.int8.onnx"
            voices = folder / "voices.bin"
            lexicons = [ENGLISH_LEXICON, folder / "lexicon-zh.txt", TECH_LEXICON]
            require(onnx, voices, *lexicons)
            model = sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(onnx), voices=str(voices), tokens=str(tokens),
                    lexicon=",".join(map(str, lexicons)),
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
        return sherpa_onnx.OfflineTts(config)

    def prepare_recognition(self):
        with self.recognition_lock:
            return self.recognizer

    def prepare_synthesis(self):
        with self.synthesis_lock:
            voice = self.kokoro if self.engine == "kokoro" else self.matcha
            return voice.num_speakers

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
            has_english = ENGLISH_WORD.search(text) is not None
            use_matcha = self.engine != "kokoro" and speaker == 0 and not has_english
            if self.engine == "matcha" and not use_matcha:
                if speaker != 0:
                    raise ValueError("请选择有效的音色。")
                raise ValueError("这段话含英文。请安装 Kokoro 后重启 Turnline，或查看文字。")
            voice = self.matcha if use_matcha else self.kokoro
            if self.engine == "hybrid" and not use_matcha and speaker == 0:
                speaker = 3
            if not 0 <= speaker < voice.num_speakers:
                raise ValueError("请选择有效的音色。")
            spoken = text if use_matcha else spell_unknown_words(text, self.english_words)
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
            voice.generate(spoken, config, callback=on_pcm)
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
