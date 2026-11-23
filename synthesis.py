"""Serialize synthesis while letting disconnected clients release queued work."""

import asyncio
from threading import Event


class SynthesisBusy(Exception):
    pass


class SynthesisQueue:
    def __init__(self, models):
        self.models = models
        self.slot = asyncio.Lock()
        self.waiting = 0

    async def stream(self, text, speaker):
        if self.waiting >= 2:
            raise SynthesisBusy("语音合成队列已满。请稍后重试。")
        self.waiting += 1
        try:
            await self.slot.acquire()
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
                self.models.synthesize(text, speaker, cancelled, lambda *chunk: send(chunk))
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
