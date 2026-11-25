"""Group Silero pause units into one user turn on the capture sample clock."""

import asyncio
from collections import deque
from dataclasses import dataclass, field
import logging
import re
from time import monotonic

import numpy as np

from .speech import FRAME_SAMPLES, SAMPLE_RATE, VoiceActivity

LOG = logging.getLogger("turnline")
RESPONSE_SPEEDS = {"quick": 0.75, "balanced": 1, "patient": 1.5}
MIN_VOICE_SECONDS = (0, 1, 2, 3, 5)
DEFAULT_MIN_VOICE_SECONDS = 2
OPEN_END_SECONDS = 1.9
OPEN_END = re.compile(
    r"(?:然后|就是|就是说|也就是说|比如|那个|因为|如果|还有|以及|或者|但是|现在|"
    r"我想问(?:一|一?下)?|帮我(?:看|查)(?:一?下)?|和|的|把|给|"
    r"\b(?:and|or|because|if|then|like|the|to))[。．.!！？?…\s]*$",
    re.I,
)
COMPLETE_END = re.compile(r"(?:[。！？.!?]|吗|呢|吧|啊|了|怎么样|怎么做|多少|是不是|有没有)$")
SHORT_ANSWER = re.compile(r"^(?:好|好的|对|是|不是|不|不要|不用|可以|不行|第[一二三四五两\d]+个|yes|no|okay|sure)$", re.I)


def endpoint_wait(text, voiced_seconds, speed, expecting_answer=False):
    text = text.strip().rstrip("”’」』\"")
    short_answer = bool(SHORT_ANSWER.fullmatch(text.rstrip("。！？.!?")))
    if OPEN_END.search(text) or text.endswith(("，", "、", ",", "…", "：", ":")):
        seconds = OPEN_END_SECONDS
    elif voiced_seconds < 0.6 and not short_answer:
        seconds = 1.8
    elif expecting_answer and short_answer or COMPLETE_END.search(text):
        seconds = 0.48
    else:
        seconds = 0.9
    return round(min(3, seconds * RESPONSE_SPEEDS[speed]) * 1000)


def joined(prefix, text):
    if not prefix or not text:
        return prefix or text
    if prefix[-1].isascii() and text[0].isascii():
        return prefix + " " + text
    return prefix + text


@dataclass
class InputTurn:
    id: int
    start: int
    active_start: int
    minimum_voice_samples: int
    last_end: int | None = None
    units: list = field(default_factory=list)
    stable: str = ""
    text: str = ""
    revision: int = 0
    last_preview: int = 0
    voiced: int = 0
    asr_ms: int = 0
    wait_ms: int | None = None
    closed: bool = False
    final_ready: bool = False
    force: bool = False


class TurnEngine:
    def __init__(self, recognition, emit):
        self.recognition = recognition
        self.emit = emit
        self.normal_vad = VoiceActivity()
        self.barge_vad = VoiceActivity(minimum=0.256, threshold=0.7, preroll=16 * FRAME_SAMPLES)
        self.vad = self.normal_vad
        self.monitor = VoiceActivity(minimum=0.256, threshold=0.7)
        self.overlap_until = 0
        self.monitored_onset = None
        self.mode = "off"
        self.manual = False
        self.speed = "balanced"
        self.min_voice_seconds = DEFAULT_MIN_VOICE_SECONDS
        self.expecting_answer = False
        self.epoch = 0
        self.cursor = 0
        self.base = 0
        self.count = 0
        self.turn = None
        self.preroll = deque(maxlen=32)
        self.wakeup = asyncio.Event()
        self.job = None

    def prepare(self):
        self.normal_vad.reset()
        self.barge_vad.reset()
        self.monitor.reset()

    def reset_vad(self):
        self.vad = self.barge_vad if self.mode == "barge" else self.normal_vad
        self.vad.reset()

    def reset(self, epoch):
        self.epoch = epoch
        self.cursor = self.base = self.overlap_until = 0
        self.turn = self.job = None
        self.preroll.clear()
        self.monitored_onset = None
        self.reset_vad()

    async def set_mode(self, mode, tail_sample=None):
        previous = self.mode
        if previous == mode:
            return
        self.mode = mode
        if mode == "monitor":
            self.monitored_onset = None
            self.monitor.reset()
        if mode == "off":
            self.turn = self.job = None
            self.preroll.clear()
            self.base = self.cursor
            self.reset_vad()
        elif previous == "monitor" and self.turn is not None:
            self.preroll.clear()
        elif previous in {"off", "monitor"}:
            history = list(self.preroll) if previous == "monitor" else []
            self.preroll.clear()
            if tail_sample is None:
                cutoff = self.cursor - int(0.384 * SAMPLE_RATE)
            else:
                cutoff = tail_sample - int(0.42 * SAMPLE_RATE)
                if self.monitored_onset is not None and abs(self.monitored_onset - tail_sample) < 6400:
                    cutoff = min(cutoff, self.monitored_onset - 1024)
                cutoff = max(self.cursor - SAMPLE_RATE, cutoff)
            history = [(at, frame) for at, frame in history if at > cutoff]
            self.base = history[0][0] - FRAME_SAMPLES if history else self.cursor
            self.overlap_until = self.cursor if history else 0
            self.reset_vad()
            for at, frame in history:
                await self.detect(frame, at)
        elif not self.turn:
            self.base = self.cursor
            self.reset_vad()

    async def event(self, kind, turn, **fields):
        await self.emit({"type": kind, "epoch": self.epoch, "input": turn.id, **fields})

    async def accept(self, payload):
        if len(payload) != FRAME_SAMPLES * 2:
            raise ValueError("需要 512 个 16 kHz 单声道 PCM 样本。")
        frame = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768
        self.cursor += FRAME_SAMPLES
        if self.mode in {"monitor", "barge"}:
            self.preroll.append((self.cursor, frame))
        if self.mode == "monitor":
            started, _ = self.monitor.accept(frame)
            if started:
                self.monitored_onset = self.cursor - int(0.288 * SAMPLE_RATE)
        if self.mode in {"listen", "barge"} or (self.mode == "monitor" and self.turn):
            await self.detect(frame, self.cursor)

    async def detect(self, frame, at):
        started, segments = self.vad.accept(frame)
        if started:
            if self.turn is None:
                self.count += 1
                history = self.vad.history
                local_end = at - self.base
                local_start = max(self.vad.last_segment_end, history.head, local_end - max(7168, self.vad.preroll))
                frames = np.asarray(history.get(local_start, local_end - local_start))
                active = np.flatnonzero(np.abs(frames) >= 0.012)
                onset = local_start + (int(active[0]) if active.size else 0)
                onset += self.base
                overlap = bool(self.overlap_until and onset < self.overlap_until)
                self.turn = InputTurn(self.count, onset, self.base + local_start,
                                      minimum_voice_samples=self.min_voice_seconds * SAMPLE_RATE)
                await self.event("speech-start", self.turn, startSample=onset, overlap=overlap,
                                 duringPlayback=self.mode == "barge")
            elif self.turn.closed:
                turn = self.turn
                turn.revision += 1
                turn.closed = turn.final_ready = False
                turn.wait_ms = None
                turn.active_start = turn.last_end
                turn.last_preview = at - SAMPLE_RATE // 2
                self.job = None
                await self.event("resumed", turn)
        turn = self.turn
        if turn is None:
            return
        for _, end, samples, voiced in segments:
            self.close_unit(turn, self.base + end, samples, voiced)
        if self.vad.detecting and not turn.closed and at - max(turn.start, turn.last_preview) >= 10240:
            remaining = turn.minimum_voice_samples - turn.voiced
            # The latest frames can still be removed by Silero's end-of-speech detection.
            confirmed = at - self.base - round(self.vad.silence * SAMPLE_RATE) - FRAME_SAMPLES
            if remaining <= 0 or self.vad.active_voiced(confirmed, remaining) >= remaining:
                history = self.vad.history
                start = max(history.head, turn.active_start - self.base, at - self.base - 8 * SAMPLE_RATE)
                samples = np.asarray(history.get(start, at - self.base - start), dtype=np.float32)
                turn.last_preview = at
                self.schedule(turn, samples=samples, final=False)
        await self.maybe_commit(turn, at, frame)

    def close_unit(self, turn, end, samples, voiced):
        turn.voiced += voiced
        turn.last_end = end
        turn.units.append(samples)
        turn.revision += 1
        turn.closed = True
        turn.final_ready = turn.voiced < turn.minimum_voice_samples
        if turn.final_ready:
            # Allow another phrase to join this turn before dropping it.
            turn.wait_ms = round(1000 * OPEN_END_SECONDS * RESPONSE_SPEEDS[self.speed])
            self.job = None
        else:
            turn.wait_ms = None
            self.schedule(turn, samples=None, final=True)

    def schedule(self, turn, samples, final):
        self.job = (turn, turn.revision, tuple(turn.units), samples, final)
        self.wakeup.set()

    async def transcribe(self):
        while True:
            await self.wakeup.wait()
            self.wakeup.clear()
            if self.job is None:
                continue
            turn, revision, units, active, final = self.job
            self.job = None

            def current():
                return self.turn is turn and turn.revision == revision

            try:
                stamp = monotonic()
                parts = (*units, active) if active is not None else units
                # Freeze a stable prefix in bounded chunks so a long dictation
                # never requires decoding the entire turn on every pause.
                frozen = 0
                stable = turn.stable
                if final:
                    size = sum(len(part) for part in parts)
                    while size > 10 * SAMPLE_RATE and frozen < len(units) - 1:
                        prefix = await self.recognition.transcribe(parts[frozen], current)
                        if prefix is None:
                            break
                        stable = joined(stable, prefix)
                        size -= len(parts[frozen])
                        frozen += 1
                if not current():
                    continue
                pieces = parts[frozen:]
                if not pieces:
                    continue
                reference = pieces[0]
                if len(pieces) > 1:
                    silence = np.zeros(2048, dtype=np.float32)
                    reference = np.concatenate([piece for audio in pieces for piece in (audio, silence)][:-1])
                result = await self.recognition.transcribe(reference, current, final=final)
                if result is None or not current():
                    continue
            except Exception:
                LOG.exception("SenseVoice turn failed")
                if final and current():
                    self.discard(turn.id)
                    await self.event("input-error", turn, message="这轮语音识别失败，请再说一遍。")
                continue

            if frozen:
                turn.stable = stable
                del turn.units[:frozen]
            turn.asr_ms += round((monotonic() - stamp) * 1000)
            turn.text = joined(stable, result)
            if turn.text:
                await self.event("partial", turn, text=turn.text, startSample=turn.start)
            if final and current():
                turn.final_ready = True
                turn.wait_ms = endpoint_wait(turn.text, turn.voiced / SAMPLE_RATE, self.speed,
                                             self.expecting_answer) if turn.text else 0
                if not self.manual:
                    await self.event("tentative", turn, text=turn.text, voiceEndSample=turn.last_end,
                                     waitMs=turn.wait_ms, voicedMs=round(turn.voiced / 16))
                await self.maybe_commit(turn, self.cursor)

    async def maybe_commit(self, turn, at, frame=None):
        if self.turn is not turn or not turn.final_ready:
            return
        silence_ms = round((at - turn.last_end) / 16)
        # Give Silero time to confirm a new onset detected near the deadline.
        if not turn.force:
            if self.manual or silence_ms < turn.wait_ms or self.vad.detecting:
                return
            if frame is not None and silence_ms < turn.wait_ms + 160 and np.sqrt(np.mean(frame**2)) > 0.012:
                return
        self.turn = self.job = None
        text = turn.text if turn.voiced >= turn.minimum_voice_samples else ""
        await self.event("commit", turn, text=text, startSample=turn.start, voiceEndSample=turn.last_end,
                         silenceWaitMs=silence_ms, asrMs=turn.asr_ms, voicedMs=round(turn.voiced / 16))
        if self.mode == "monitor" or (self.mode == "listen" and self.vad is not self.normal_vad):
            # The previous turn may have started before playback or a mode
            # change. Put the next turn on its own capture profile.
            if self.turn is None:
                self.base = self.cursor
                self.reset_vad()

    async def force_commit(self):
        turn = self.turn
        if turn is None:
            return
        turn.force = True
        if turn.closed:
            await self.maybe_commit(turn, self.cursor)
            return
        history = self.vad.history
        start = max(history.head, turn.active_start - self.base)
        end = self.cursor - self.base
        if end <= start:
            return
        samples = np.asarray(history.get(start, end - start), dtype=np.float32)
        self.close_unit(turn, self.cursor, samples, self.vad.active_voiced(end))
        self.base = self.cursor
        self.reset_vad()
        await self.maybe_commit(turn, self.cursor)

    def discard(self, input_id):
        if self.turn and self.turn.id == input_id:
            self.turn = self.job = None
            self.base = self.cursor
            self.reset_vad()
