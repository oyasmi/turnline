"""One WebSocket for microphone frames, turn events and cancellable speech."""

import asyncio
from collections import deque
from contextlib import aclosing
import json
import logging
import struct
from time import monotonic

import numpy as np
from starlette.websockets import WebSocketDisconnect, WebSocketState

from .synthesis import AUDIBLE_THRESHOLD
from .turn_engine import DEFAULT_MIN_VOICE_SECONDS, MIN_VOICE_SECONDS, RESPONSE_SPEEDS, TurnEngine

LOG = logging.getLogger("turnline")
SPEECH_RATES = (0.9, 1.0, 1.07, 1.15)
MAX_SAY_QUEUE = 64


def integer(value, maximum):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError("语音会话收到无效的编号。")
    return value


class VoiceSession:
    def __init__(self, socket, models, recognition, synthesis):
        self.socket = socket
        self.models = models
        self.synthesis = synthesis
        self.send_lock = asyncio.Lock()
        self.input = TurnEngine(recognition, self.send)
        self.queue = deque()
        self.available = asyncio.Event()
        self.task = None
        self.active = None
        self.cancelled_through = 0

    async def send(self, event):
        async with self.send_lock:
            await self.socket.send_json(event)

    async def receive(self):
        while (message := await self.socket.receive())["type"] != "websocket.disconnect":
            if message.get("bytes") is not None:
                await self.input.accept(message["bytes"])
                continue
            data = json.loads(message["text"])
            if not isinstance(data, dict):
                raise ValueError("无效的语音会话消息。")
            kind = data.get("type")
            if kind == "ping":
                await self.send({"type": "pong"})
            elif kind == "configure":
                speed = data.get("speed")
                if not isinstance(speed, str) or speed not in RESPONSE_SPEEDS:
                    raise ValueError("无效的反应速度。")
                minimum = data.get("minVoiceSeconds", DEFAULT_MIN_VOICE_SECONDS)
                if type(minimum) is not int or minimum not in MIN_VOICE_SECONDS:
                    raise ValueError("无效的最短有效语音时长。")
                self.input.speed = speed
                self.input.min_voice_seconds = minimum
                self.input.expecting_answer = data.get("expectingAnswer") is True
                self.input.manual = data.get("manual") is True
            elif kind == "reset":
                self.input.reset(integer(data.get("epoch"), 0xffffffff))
            elif kind == "capture":
                mode = data.get("mode")
                tail = data.get("tailSample")
                if mode not in ("off", "listen", "monitor", "barge"):
                    raise ValueError("无效的收音模式。")
                await self.input.set_mode(mode, None if tail is None else integer(tail, 2**53 - 1))
            elif kind == "force-commit":
                if data.get("release") is True and self.input.turn is None:
                    await self.send({"type": "hold-empty", "epoch": self.input.epoch})
                else:
                    await self.input.force_commit()
            elif kind == "discard-input":
                self.input.discard(integer(data.get("input"), 0xffffffff))
            elif kind == "say":
                await self.say(data)
            elif kind == "cancel":
                self.cancel(integer(data.get("turn"), 0xffffffff))
            else:
                raise ValueError("未知的语音会话消息。")

    async def say(self, data):
        turn = integer(data.get("turn"), 0xffffffff)
        seq = integer(data.get("seq"), 0xffff)
        text, speed = data.get("text"), data.get("speed")
        if turn <= self.cancelled_through:
            return
        if not isinstance(text, str) or not text.strip() or len(text) > 128:
            raise ValueError("每次合成需要 1 至 128 字。")
        if type(speed) not in (int, float) or speed not in SPEECH_RATES:
            raise ValueError("无效的播报语速。")
        if len(self.queue) >= MAX_SAY_QUEUE:
            await self.send({"type": "say-error", "turn": turn, "seq": seq, "message": "播报队列已满。"})
            return
        self.queue.append((turn, seq, text, speed, monotonic()))
        self.available.set()

    def cancel(self, turn):
        self.cancelled_through = max(self.cancelled_through, turn)
        self.queue = deque(job for job in self.queue if job[0] > turn)
        if self.active is not None and self.active <= turn:
            self.task.cancel()

    async def synthesize(self, turn, seq, text, speed, queued):
        chunks = []
        async with aclosing(self.synthesis.stream(text, 0, speed)) as stream:
            async for pcm, rate, start, ready in stream:
                if not chunks:
                    timing = {"queue": (start - queued) * 1000, "synthesis": (ready - start) * 1000}
                chunks.append(np.frombuffer(pcm, dtype="<f4"))
        if not chunks:
            raise ValueError("语音模型未生成音频。")
        samples = np.concatenate(chunks)
        audible = np.flatnonzero(np.abs(samples) >= AUDIBLE_THRESHOLD)
        first, end = (int(audible[0]), int(audible[-1]) + 1) if audible.size else (0, len(samples))
        await self.send(dict(type="say-start", turn=turn, seq=seq, rate=rate, timing=timing))
        pcm = np.rint(np.clip(samples, -1, 32767 / 32768) * 32768).astype("<i2").tobytes()
        for point in range(0, len(pcm), 8192):
            chunk = pcm[point:point + 8192]
            flags = int(point + len(chunk) == len(pcm))
            async with self.send_lock:
                await self.socket.send_bytes(struct.pack("!IHB", turn, seq, flags) + chunk)
            await asyncio.sleep(0)
        await self.send(dict(type="say-done", turn=turn, seq=seq, samples=len(samples),
                             textMap={"start": first, "end": end}))

    async def playback(self):
        while True:
            await self.available.wait()
            if not self.queue:
                self.available.clear()
                continue
            job = self.queue.popleft()
            turn, seq, *_ = job
            self.active = turn
            self.task = asyncio.create_task(self.synthesize(*job))
            try:
                await self.task
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
            except (WebSocketDisconnect, OSError):
                raise
            except Exception:
                LOG.exception("Voice session synthesis failed")
                await self.send(dict(type="say-error", turn=turn, seq=seq, message="这段语音合成失败。"))
            finally:
                self.task = self.active = None

    async def run(self):
        await self.socket.accept()
        tasks = []
        try:
            await asyncio.gather(
                asyncio.to_thread(self.models.prepare_recognition),
                asyncio.to_thread(self.models.prepare_synthesis),
                asyncio.to_thread(self.input.prepare),
            )
            await self.send({"type": "ready"})
            tasks = [asyncio.create_task(coro) for coro in (self.receive(), self.input.transcribe(), self.playback())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (WebSocketDisconnect, OSError):
            pass
        except (FileNotFoundError, ValueError, KeyError, TypeError) as exc:
            await self.send({"type": "fatal", "message": str(exc)})
        except Exception:
            LOG.exception("Voice session failed")
            await self.send({"type": "fatal", "message": "语音服务处理失败，请查看服务日志。"})
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if (self.socket.client_state != WebSocketState.DISCONNECTED
                    and self.socket.application_state != WebSocketState.DISCONNECTED):
                await self.socket.close()
