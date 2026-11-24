"""Serve Turnline and run speech inference on the Python host."""

import argparse
import asyncio
import json
import logging
import os
import ssl
from contextlib import aclosing
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

from aiohttp import WSMsgType, web

from connection import DeviceStore, Pipiclaw, default_socket, default_state, error, loopback, normalize_origin
from speech import ListeningTurn, SpeechModels
from synthesis import SynthesisBusy, SynthesisQueue

PUBLIC = Path(__file__).resolve().parent / "public"
LOG = logging.getLogger("turnline")


def browser_origin(request, public_origin):
    if public_origin:
        return public_origin if request.host == urlsplit(public_origin).netloc else None
    host = urlsplit("//" + request.host).hostname
    return f"http://{request.host}" if host and loopback(host) else None


def browser_boundary(public_origin, pipiclaw):
    @web.middleware
    async def check(request, handler):
        try:
            origin = browser_origin(request, public_origin)
        except ValueError:
            origin = None
        if not origin:
            return error("请使用 Turnline 服务配置的访问地址。", 403)
        supplied = request.headers.get("Origin")
        restricted = request.method not in {"GET", "HEAD"} or request.path == "/speech/listen"
        if restricted and supplied != origin and (supplied is not None or pipiclaw):
            return error("请通过 Turnline 页面访问此接口。", 403)
        if pipiclaw and request.path.startswith("/speech/") and not pipiclaw.device(request):
            return error("请先配对此设备，再开始通话。", 401)
        return await handler(request)
    return check


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


def create_app(tts_threads=2, *, origin=None, socket_path=None, state_dir=None, demo_mode=False):
    models = SpeechModels(tts_threads=tts_threads)
    synthesis = SynthesisQueue(models)
    pipiclaw = None if demo_mode else Pipiclaw(
        socket_path or default_socket(), DeviceStore(state_dir or default_state()), origin or "http:",
    )
    app = web.Application(middlewares=[browser_boundary(origin, pipiclaw)], client_max_size=128 * 1024)

    async def warm_models():
        try:
            await asyncio.gather(asyncio.to_thread(models.prepare_recognition),
                                 asyncio.to_thread(models.prepare_synthesis))
        except Exception:
            LOG.exception("Voice model warmup failed")

    async def prepare_models(_app):
        warming = asyncio.create_task(warm_models())
        try:
            yield
        finally:
            warming.cancel()
            await asyncio.gather(warming, return_exceptions=True)

    async def demo_status(_request):
        return web.json_response({"connection": "demo"})

    app.cleanup_ctx.append(prepare_models)
    if pipiclaw:
        app.cleanup_ctx.append(pipiclaw.connect)
        app.router.add_get("/api/session", pipiclaw.status)
        app.router.add_post("/api/pair", pipiclaw.pair)
        app.router.add_post("/api/sign-out", pipiclaw.sign_out)
        app.router.add_post("/api/pipiclaw/v1/conversations", pipiclaw.relay, name="create-conversation")
        app.router.add_get("/api/pipiclaw/v1/conversations/{conversation}/items", pipiclaw.relay,
                           name="conversation-items")
        app.router.add_post("/api/pipiclaw/v1/responses", pipiclaw.relay, name="responses")
    else:
        app.router.add_get("/api/session", demo_status)
        app.router.add_post("/demo/v1/responses", demo)

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
    app.router.add_static("/assets/", PUBLIC)

    async def headers(request, response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()"
        if request.path == "/" or request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if request.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "no-cache"
        if request.path == "/":
            site = browser_origin(request, origin)
            if site:
                websocket = site.replace("http", "ws", 1)
                response.headers["Content-Security-Policy"] = (
                    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
                    f"form-action 'self'; connect-src 'self' {websocket}"
                )

    app.on_response_prepare.append(headers)
    return app


async def serve(options, origin, ssl_context=None):
    application = create_app(options.tts_threads, origin=origin, socket_path=options.pipiclaw_socket,
                             state_dir=options.state_dir, demo_mode=options.demo)
    runner = web.AppRunner(application, access_log=None, handler_cancellation=True)
    await runner.setup()
    try:
        site = web.TCPSite(runner, options.host, options.port, ssl_context=ssl_context)
        await site.start()
        address, actual_port = runner.addresses[0][:2]
        label = f"[{address}]" if ":" in address else address
        print(f"Turnline {origin or f'http://{label}:{actual_port}'}", flush=True)
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("serve", "pair"), default="serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--public-url", default=os.environ.get("TURNLINE_PUBLIC_URL"))
    parser.add_argument("--tls-cert", type=Path, help="PEM certificate chain for direct HTTPS")
    parser.add_argument("--tls-key", type=Path, help="PEM private key for direct HTTPS")
    parser.add_argument("--state-dir", type=Path, default=default_state())
    parser.add_argument("--pipiclaw-socket", type=Path, default=default_socket())
    parser.add_argument("--tts-threads", type=int, default=2)
    parser.add_argument("--demo", action="store_true")
    options = parser.parse_args()
    address = f"[{options.host}]" if ":" in options.host else options.host
    try:
        origin = normalize_origin(options.public_url) if options.public_url else None
        local_listener = loopback(options.host)
        if options.demo and (not local_listener or (origin and not loopback(urlsplit(origin).hostname))):
            raise ValueError("The offline demo is available on loopback only.")
    except ValueError as exc:
        parser.error(str(exc))
    if options.command == "pair":
        if options.demo or (origin is None and (options.port == 0 or not local_listener)):
            parser.error("Pairing requires the deployed Turnline URL.")
        site = origin or f"http://{address}:{options.port}"
        print(f"{site}/#pair={DeviceStore(options.state_dir).issue()}")
        return
    if options.tts_threads < 1:
        parser.error("--tts-threads must be at least 1")
    if bool(options.tls_cert) != bool(options.tls_key):
        parser.error("--tls-cert and --tls-key must be supplied together.")
    if not local_listener and not options.tls_cert:
        parser.error("A non-loopback listener requires --tls-cert and --tls-key.")
    ssl_context = None
    if options.tls_cert:
        if not origin or not origin.startswith("https://"):
            parser.error("Direct HTTPS requires an HTTPS --public-url.")
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            ssl_context.load_cert_chain(options.tls_cert, options.tls_key)
        except OSError as exc:
            parser.error(f"Could not load the HTTPS certificate and key: {exc}")
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(serve(options, origin, ssl_context))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
