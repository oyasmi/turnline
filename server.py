"""Serve Turnline and run speech inference on the Python host."""

import argparse
import asyncio
import json
import logging
from contextlib import aclosing
from pathlib import Path
from time import monotonic
from urllib.parse import urlparse
from uuid import uuid4

from aiohttp import WSMsgType, web

from speech import ListeningTurn, SpeechModels
from synthesis import SynthesisBusy, SynthesisQueue

PUBLIC = Path(__file__).resolve().parent / "public"
LOG = logging.getLogger("turnline")


def error(message, status=400):
    return web.json_response({"error": {"message": str(message)}}, status=status)


@web.middleware
async def same_origin(request, handler):
    origin = request.headers.get("Origin")
    url = urlparse(origin) if origin else None
    restricted = request.method == "POST" or request.path == "/speech/listen"
    if restricted and url and (url.scheme not in {"http", "https"} or url.netloc != request.host):
        return error("此接口只接受 Turnline 页面发出的请求。", 403)
    return await handler(request)


async def index(_request):
    return web.FileResponse(PUBLIC / "index.html")


def tts_info(models):
    voices = [{"id": speaker, "label": label} for speaker, label in models.voice_choices]
    return {"engine": models.engine, "voices": voices}


async def tts_ready(_request, models):
    try:
        speakers = await asyncio.to_thread(models.prepare_synthesis)
        return web.json_response({**tts_info(models), "speakers": speakers})
    except FileNotFoundError as exc:
        return error(exc, 503)
    except Exception:
        LOG.exception("TTS initialization failed")
        return error("语音合成模型初始化失败，请查看 Python 服务日志。", 500)


async def tts(request, synthesis):
    response = None
    try:
        body = await request.json()
        text = body["text"]
        speaker = body["speaker"]
        if not isinstance(text, str) or not text.strip() or len(text) > 128:
            raise ValueError("每次合成需要 1 至 128 字。")
        if type(speaker) is not int:
            raise ValueError("请选择有效的音色。")
        submitted = monotonic()
        async with aclosing(synthesis.stream(text, speaker)) as chunks:
            async for pcm, rate, started, ready in chunks:
                if response is None:
                    response = web.StreamResponse(headers={
                        "Content-Type": "application/octet-stream",
                        "X-Sample-Rate": str(rate),
                        "Cache-Control": "no-store",
                        "Server-Timing": f"tts-queue;dur={(started - submitted) * 1000:.1f}, "
                                         f"tts-first-pcm;dur={(ready - started) * 1000:.1f}",
                    })
                    await response.prepare(request)
                await response.write(pcm)
        if response is None:
            raise RuntimeError("语音服务没有返回音频。请重试或改用文字。")
        await response.write_eof()
        return response
    except ConnectionError:
        raise
    except Exception as exc:
        if response is not None and response.prepared:
            LOG.exception("TTS stream failed")
            # Leave a truncated transfer so the player detects the failure.
            if request.transport is not None:
                request.transport.close()
            raise ConnectionResetError("TTS stream failed") from exc
        if isinstance(exc, (FileNotFoundError, SynthesisBusy)):
            return error(exc, 503)
        if isinstance(exc, (KeyError, ValueError, TypeError)):
            return error(exc)
        LOG.exception("TTS generation failed")
        return error(exc, 500)


async def reset_listening(text, listening):
    message = json.loads(text)
    epoch, silence = message["epoch"], message["silence"]
    if message.get("type") != "reset" or type(epoch) is not int or silence not in {0.35, 0.5, 0.8, 1.2}:
        raise ValueError("无效的收音设置。")
    await asyncio.to_thread(listening.reset, epoch, silence)


async def listen(request, models):
    ws = web.WebSocketResponse(max_msg_size=8192, heartbeat=20)
    await ws.prepare(request)
    listening = ListeningTurn()
    try:
        await asyncio.to_thread(models.prepare_recognition)
        await asyncio.to_thread(listening.reset, 0, 0.5)
        await ws.send_json({"type": "ready"})
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                await reset_listening(message.data, listening)
            elif message.type == WSMsgType.BINARY:
                started, segments = listening.accept(message.data)
                if started:
                    await ws.send_json({"type": "speech-start", "epoch": listening.epoch})
                for samples in segments:
                    endpoint = monotonic()
                    await ws.send_json({"type": "speech-end", "epoch": listening.epoch})
                    result = await asyncio.to_thread(models.recognize, samples)
                    await ws.send_json({
                        "type": "transcript",
                        "epoch": listening.epoch,
                        "text": result,
                        "asrMs": round((monotonic() - endpoint) * 1000),
                    })
    except (ConnectionError, asyncio.CancelledError):
        raise
    except (FileNotFoundError, ValueError, KeyError, TypeError) as exc:
        if not ws.closed:
            await ws.send_json({"type": "fatal", "message": str(exc)})
    except Exception:
        LOG.exception("Speech recognition failed")
        if not ws.closed:
            await ws.send_json({"type": "fatal", "message": "SenseVoice 处理语音失败，请查看 Python 服务日志。"})
    finally:
        await ws.close()
    return ws


async def demo(request):
    try:
        body = await request.json()
        inputs = [item for item in body["input"] if item.get("role") == "user"]
        if body.get("stream") is not True or not inputs:
            raise ValueError
    except (KeyError, ValueError, TypeError, AttributeError):
        return error("演示端点需要流式请求和消息数组。")
    text = str(inputs[-1].get("content", ""))
    progress = "进度" in text
    slow = "慢一点" in text
    if slow:
        chunks = ["这是一段打断测试。", "你可以现在开始说话，", "或者点一下打断。", "如果你听到了最后一句，说明这轮没有被打断。"]
    elif progress:
        chunks = ["处理完了。", "详细结果可以在屏幕上看。"]
    else:
        chunks = ["你好，我在听。" if len(inputs) == 1 else "我记得我们刚才聊过。", "你接着说。"]

    response = web.StreamResponse(headers={"Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache"})
    await response.prepare(request)
    response_id = "resp_" + uuid4().hex
    sequence = 0
    items = []

    async def emit(event_type, **fields):
        nonlocal sequence
        event = {"type": event_type, "sequence_number": sequence, **fields}
        sequence += 1
        await response.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())

    async def message(parts, phase, *, gap=0.14):
        index = len(items)
        item = {"id": "msg_" + uuid4().hex, "type": "message", "role": "assistant", "phase": phase, "content": []}
        await emit("response.output_item.added", output_index=index, item=item)
        for index_in_message, delta in enumerate(parts):
            await asyncio.sleep(gap if index_in_message else 0.14)
            await emit("response.output_text.delta", output_index=index, item_id=item["id"], content_index=0, delta=delta)
        item["content"] = [{"type": "output_text", "text": "".join(parts)}]
        items.append(item)
        await emit("response.output_item.done", output_index=index, item=item)

    try:
        await emit("response.created", response={"id": response_id, "status": "in_progress"})
        if progress:
            await message(["正在检查。"], "commentary")
            await asyncio.sleep(0.45)
        await message(chunks, "final_answer", gap=4 if slow else 0.14)
        await emit("response.completed", response={"id": response_id, "status": "completed", "output": items})
    except ConnectionError:
        pass
    return response


def create_app(tts_engine="auto", tts_threads=2):
    models = SpeechModels(tts_engine, tts_threads)
    synthesis = SynthesisQueue(models)
    app = web.Application(middlewares=[same_origin], client_max_size=1024 * 1024)

    async def open_socket(request):
        return await listen(request, models)

    async def prepare(request):
        return await tts_ready(request, models)

    async def speech_info(_request):
        return web.json_response(tts_info(models))

    async def generate(request):
        return await tts(request, synthesis)

    app.router.add_get("/", index)
    app.router.add_get("/speech/listen", open_socket)
    app.router.add_get("/speech/info", speech_info)
    app.router.add_post("/speech/prepare", prepare)
    app.router.add_post("/speech/synthesize", generate)
    app.router.add_post("/demo/v1/responses", demo)
    app.router.add_static("/", PUBLIC)

    async def headers(_request, response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"

    app.on_response_prepare.append(headers)
    return app


async def serve(host, port, tts_engine, tts_threads):
    runner = web.AppRunner(create_app(tts_engine, tts_threads), access_log=None, handler_cancellation=True)
    await runner.setup()
    try:
        site = web.TCPSite(runner, host, port)
        await site.start()
        address, actual_port = runner.addresses[0][:2]
        label = f"[{address}]" if ":" in address else address
        print(f"Turnline http://{label}:{actual_port}", flush=True)
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--tts-engine", choices=("auto", "matcha", "kokoro"), default="auto")
    parser.add_argument("--tts-threads", type=int, default=2)
    options = parser.parse_args()
    if options.tts_threads < 1:
        parser.error("--tts-threads must be at least 1")
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(serve(options.host, options.port, options.tts_engine, options.tts_threads))
    except KeyboardInterrupt:
        pass
