"""Serialize synthesis while letting disconnected clients release queued work."""

import asyncio
from threading import Event

import numpy as np


class SpeechSlot:
    """Run one native speech job at a time, in priority order."""

    def __init__(self):
        self.busy = False
        self.waiters = []

    async def acquire(self, priority):
        if not self.busy:
            self.busy = True
            return
        waiter = asyncio.get_running_loop().create_future()
        entry = (priority, waiter)
        self.waiters.append(entry)
        try:
            await waiter
        except asyncio.CancelledError:
            if not waiter.cancelled():
                self.release()
            raise
        finally:
            self.waiters.remove(entry)

    def release(self):
        waiting = [entry for entry in self.waiters if not entry[1].done()]
        if waiting:
            min(waiting, key=lambda entry: entry[0])[1].set_result(None)
        else:
            self.busy = False


AUDIBLE_THRESHOLD = 0.005


def shape_audio(samples, rate, raw_text, text):
    active = np.flatnonzero(np.abs(samples) >= AUDIBLE_THRESHOLD)
    if not active.size:
        raise ValueError("语音模型未生成可闻音频。")
    start, end = int(active[0]), int(active[-1]) + 1
    voice = samples[max(0, start - round(rate * 0.020)):end].copy()
    fade = min(round(rate * 0.005), len(voice) // 2)
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        voice[:fade] *= ramp
        voice[-fade:] *= ramp[::-1]
    pause = 0.4 if raw_text.endswith("\n\n") else (
        0.12 if text.endswith((",", "，", "、", ":", "：")) else
        0.26 if text.endswith((".", "。", "?", "？", "!", "！", ";", "；")) else 0.06
    )
    return np.pad(voice, (0, round(rate * pause))).astype("<f4", copy=False)


class SynthesisBusy(Exception):
    pass


class SynthesisQueue:
    def __init__(self, models, slot=None):
        self.models = models
        self.slot = slot or SpeechSlot()
        self.waiting = 0

    async def stream(self, text, speaker, speed=None):
        if self.waiting >= 2:
            raise SynthesisBusy("语音合成队列已满。请稍后重试。")
        self.waiting += 1
        try:
            await self.slot.acquire(0)
        finally:
            self.waiting -= 1

        loop = asyncio.get_running_loop()
        cancelled = Event()
        chunks = asyncio.Queue(maxsize=1)

        def send(chunk):
            if cancelled.is_set():
                return False
            future = asyncio.run_coroutine_threadsafe(chunks.put(chunk), loop)
            while not cancelled.is_set():
                try:
                    future.result(timeout=0.05)
                    return True
                except TimeoutError:
                    continue
            future.cancel()
            return False

        def run():
            try:
                args = () if speed is None else (speed,)
                self.models.synthesize(text, speaker, cancelled, lambda *chunk: send(chunk), *args)
            except Exception as exc:
                send(exc)
            else:
                send(None)

        def finished(worker):
            self.slot.release()
            # Surface any unexpected failure in the thread-to-loop handoff.
            worker.result()

        try:
            loop.run_in_executor(None, run).add_done_callback(finished)
        except BaseException:
            self.slot.release()
            raise
        try:
            while (chunk := await chunks.get()) is not None:
                if isinstance(chunk, Exception):
                    raise chunk
                yield chunk
        finally:
            cancelled.set()
