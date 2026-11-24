"""Serve Turnline and its speech models on a single Uvicorn port."""

import argparse
import asyncio
from contextlib import aclosing, asynccontextmanager
import json
import logging
import os
from pathlib import Path
import socket
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocketState
import uvicorn

from connection import (
    DEVICE_SECONDS, DeviceStore, Pipiclaw, default_socket, default_state, loopback, normalize_origin, session_cookie,
)
from http_support import ClientStream, error, read_json
from speech import ListeningTurn, RecognitionQueue, SpeechModels
from synthesis import SynthesisBusy, SynthesisQueue
from tls import certificates

PUBLIC = Path(__file__).resolve().parent / "public"
LOG = logging.getLogger("turnline")
PORT = 8686
DIRECT_CONNECT = " https: http://127.0.0.1:* http://localhost:* http://[::1]:*"


def browser_origin(scope, headers, tunnel):
    scheme = {"ws": "http", "wss": "https"}.get(scope["scheme"], scope["scheme"])
    hosts = headers.getlist("host")
    if len(hosts) != 1 or any(char in hosts[0] for char in "/,@"):
        raise ValueError("Invalid Host header.")
    host = hosts[0]
    peer = scope.get("client")
    if tunnel and peer and loopback(peer[0]):
        forwarded = headers.getlist("x-forwarded-host")
        if forwarded:
            if len(forwarded) != 1 or any(char in forwarded[0] for char in "/,@"):
                raise ValueError("Invalid forwarded Host header.")
            host = forwarded[0]
        proto = headers.getlist("x-forwarded-proto")
        if proto:
            if len(proto) != 1 or proto[0] not in {"http", "https"}:
                raise ValueError("Invalid forwarded protocol.")
            scheme = proto[0]
        elif not loopback(urlsplit("//" + host).hostname):
            # Some HTTPS tunnel agents preserve Host and send no forwarding headers.
            scheme = "https"
    return normalize_origin(f"{scheme}://{host}")


class BrowserBoundary:
    def __init__(self, app, *, tunnel, demo_mode):
        self.app = app
        self.tunnel = tunnel
        self.demo_mode = demo_mode

    async def __call__(self, scope, receive, send):
        protocol = scope["type"]
        if protocol not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        try:
            origin = browser_origin(scope, headers, self.tunnel)
            if self.demo_mode and not loopback(urlsplit(origin).hostname):
                raise ValueError("Demo requires a loopback origin.")
        except ValueError:
            origin = None
        restricted = protocol == "websocket" or scope.get("method") not in {"GET", "HEAD"}
        supplied = headers.getlist("origin")
        if not origin or (restricted and supplied != [origin] and (supplied or not self.demo_mode)):
            if protocol == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                response = error("请通过 Turnline 页面访问此接口。", 403)
                await response(scope, receive, send)
            return

        scope["turnline.origin"] = origin
        path = scope["path"]

        async def send_headers(message):
            if message["type"] == "http.response.start":
                outgoing = MutableHeaders(scope=message)
                outgoing["X-Content-Type-Options"] = "nosniff"
                outgoing["X-Frame-Options"] = "DENY"
                outgoing["Referrer-Policy"] = "no-referrer"
                outgoing["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()"
                if path.startswith("/assets/"):
                    outgoing["Cache-Control"] = "no-cache"
                else:
                    outgoing["Cache-Control"] = "no-store"
                if path in {"/", "/direct"}:
                    websocket = origin.replace("http", "ws", 1)
                    direct = DIRECT_CONNECT if path == "/direct" else ""
                    outgoing["Content-Security-Policy"] = (
                        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
                        f"form-action 'self'; connect-src 'self' {websocket}{direct}"
                    )
            await send(message)

        await self.app(scope, receive, send_headers)


def tts_info(models):
    voices = [{"id": speaker, "label": label} for speaker, label in models.voice_choices]
    return {"engine": models.engine, "voices": voices}


async def tts(request, synthesis):
    body = await read_json(request)
    if not isinstance(body, dict):
        return error("请发送有效的播报内容。")
    text, speaker = body.get("text"), body.get("speaker")
    if not isinstance(text, str) or not text.strip() or len(text) > 128:
        return error("每次合成需要 1 至 128 字。")
    if type(speaker) is not int or speaker not in {voice for voice, _ in synthesis.models.voice_choices}:
        return error("请选择有效的音色。")
    submitted = monotonic()

    @asynccontextmanager
    async def prepare():
        async with aclosing(synthesis.stream(text, speaker)) as chunks:
            try:
                pcm, rate, started, ready = await anext(chunks)
            except (FileNotFoundError, SynthesisBusy) as exc:
                yield error(exc, 503)
                return
            except Exception:
                LOG.exception("TTS generation failed")
                yield error("语音合成失败，请查看服务日志后重试。", 500)
                return

            async def audio():
                yield pcm
                async for chunk, *_ in chunks:
                    yield chunk

            yield StreamingResponse(audio(), media_type="application/octet-stream", headers={
                "X-Sample-Rate": str(rate),
                "X-Accel-Buffering": "no",
                "Server-Timing": f"tts-queue;dur={(started - submitted) * 1000:.1f}, "
                                 f"tts-first-pcm;dur={(ready - started) * 1000:.1f}",
            })

    return ClientStream(prepare)


async def listen(ws, models, recognition):
    await ws.accept()
    listening = ListeningTurn()
    jobs = asyncio.Queue(maxsize=2)
    revision = 0
    segment_number = 0
    tasks = []

    async def receive_audio():
        nonlocal revision, segment_number
        while (message := await ws.receive())["type"] != "websocket.disconnect":
            if (text := message.get("text")) is not None:
                reset = json.loads(text)
                epoch, silence = reset["epoch"], reset["silence"]
                if reset.get("type") != "reset" or type(epoch) is not int or silence not in {0.35, 0.5, 0.8, 1.2}:
                    raise ValueError("无效的收音设置。")
                revision += 1
                while not jobs.empty():
                    jobs.get_nowait()
                await asyncio.to_thread(listening.reset, epoch, silence)
                continue
            started, segments = listening.accept(message["bytes"])
            if started:
                await ws.send_json({"type": "speech-start", "epoch": listening.epoch})
            for samples in segments:
                segment_number += 1
                event = {"epoch": listening.epoch, "segment": segment_number}
                endpoint = monotonic()
                await ws.send_json({"type": "speech-end", **event})
                try:
                    jobs.put_nowait((revision, event, endpoint, samples))
                except asyncio.QueueFull as exc:
                    raise ValueError("语音识别繁忙，请稍后重新开始通话。") from exc

    async def transcribe():
        while True:
            ticket, event, endpoint, samples = await jobs.get()
            result = await recognition.transcribe(samples, lambda: ticket == revision)
            if result is not None and ticket == revision:
                await ws.send_json({
                    "type": "transcript", **event, "text": result,
                    "asrMs": round((monotonic() - endpoint) * 1000),
                })

    try:
        await asyncio.to_thread(models.prepare_recognition)
        await asyncio.to_thread(listening.reset, 0, 0.8)
        await ws.send_json({"type": "ready"})
        tasks = [asyncio.create_task(receive_audio()), asyncio.create_task(transcribe())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (FileNotFoundError, ValueError, KeyError, TypeError) as exc:
        if ws.client_state != WebSocketState.DISCONNECTED:
            await ws.send_json({"type": "fatal", "message": str(exc)})
    except (WebSocketDisconnect, OSError):
        pass
    except Exception:
        LOG.exception("Speech recognition failed")
        if ws.client_state != WebSocketState.DISCONNECTED:
            await ws.send_json({"type": "fatal", "message": "SenseVoice 处理语音失败，请查看服务日志。"})
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if ws.client_state != WebSocketState.DISCONNECTED and ws.application_state != WebSocketState.DISCONNECTED:
            await ws.close()


async def demo(request: Request):
    body = await read_json(request)
    try:
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

    async def events():
        response_id = "resp_" + uuid4().hex
        sequence = 0
        items = []

        def emit(event_type, **fields):
            nonlocal sequence
            event = {"type": event_type, "sequence_number": sequence, **fields}
            sequence += 1
            return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

        async def message(parts, phase, *, gap=0.14):
            index = len(items)
            item = {"id": "msg_" + uuid4().hex, "type": "message", "role": "assistant", "phase": phase, "content": []}
            yield emit("response.output_item.added", output_index=index, item=item)
            for index_in_message, delta in enumerate(parts):
                await asyncio.sleep(gap if index_in_message else 0.14)
                yield emit("response.output_text.delta", output_index=index, item_id=item["id"], content_index=0, delta=delta)
            item["content"] = [{"type": "output_text", "text": "".join(parts)}]
            items.append(item)
            yield emit("response.output_item.done", output_index=index, item=item)

        yield emit("response.created", response={"id": response_id, "status": "in_progress"})
        if progress:
            async for event in message(["正在检查。"], "commentary"):
                yield event
            await asyncio.sleep(0.45)
        async for event in message(chunks, "final_answer", gap=4 if slow else 0.14):
            yield event
        yield emit("response.completed", response={"id": response_id, "status": "completed", "output": items})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


def create_app(tts_threads=2, *, socket_path=None, state_dir=None, demo_mode=False, direct_only=False, tunnel=False):
    models = SpeechModels(tts_threads=tts_threads)
    synthesis = SynthesisQueue(models)
    recognition = RecognitionQueue(models)
    devices = None if demo_mode else DeviceStore(state_dir or default_state())
    pipiclaw = Pipiclaw(socket_path or default_socket(), devices) if devices and not direct_only else None

    async def warm(name, run):
        try:
            await asyncio.to_thread(run)
        except Exception:
            LOG.exception("%s warmup failed", name)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            await asyncio.gather(warm("SenseVoice", models.warm_recognition), warm("Matcha", models.warm_synthesis))
            yield
        finally:
            if pipiclaw:
                await pipiclaw.client.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.add_middleware(BrowserBoundary, tunnel=tunnel, demo_mode=demo_mode)
    app.mount("/assets", StaticFiles(directory=PUBLIC))

    @app.exception_handler(HTTPException)
    async def http_error(_request, exc):
        return error(exc.detail, exc.status_code)

    async def device(connection):
        if devices:
            cookie, _ = session_cookie(connection)
            return await asyncio.to_thread(devices.device, connection.cookies.get(cookie))
        return None

    async def require_device(request: Request):
        identity = await device(request)
        if devices and not identity:
            raise HTTPException(401, "请先配对此设备。")
        return identity

    @app.api_route("/", methods=["GET", "HEAD"])
    async def index():
        return RedirectResponse("/direct") if direct_only else FileResponse(PUBLIC / "index.html")

    @app.api_route("/direct", methods=["GET", "HEAD"])
    async def direct():
        return RedirectResponse("/") if demo_mode else FileResponse(PUBLIC / "index.html")

    @app.get("/api/session")
    async def session(request: Request):
        if demo_mode:
            return {"connection": "demo"}
        result = {"relay": pipiclaw is not None}
        if not await device(request):
            return {"connection": "pair", **result}
        if pipiclaw and request.query_params.get("mode") != "direct":
            return {"connection": await pipiclaw.status(), **result}
        return {"connection": "direct", **result}

    if devices:
        @app.post("/api/pair")
        async def pair(request: Request):
            body = await read_json(request)
            token = body.get("token") if isinstance(body, dict) else None
            cookie, secure = session_cookie(request)
            session_id = await asyncio.to_thread(devices.redeem, token, request.cookies.get(cookie))
            if session_id is None:
                return error("配对码已使用或失效。请在 Turnline 服务器生成新的配对码。", 401)
            response = Response(status_code=204)
            response.set_cookie(cookie, session_id, path="/", max_age=DEVICE_SECONDS,
                                secure=secure, httponly=True, samesite="strict")
            return response

        @app.post("/api/sign-out")
        async def sign_out(request: Request):
            if identity := await device(request):
                await asyncio.to_thread(devices.revoke, identity)
            cookie, secure = session_cookie(request)
            response = Response(status_code=204)
            response.delete_cookie(cookie, path="/", secure=secure, httponly=True, samesite="strict")
            return response

    if pipiclaw:
        @app.post("/api/pipiclaw/v1/conversations")
        async def create_conversation(identity=Depends(require_device)):
            return await pipiclaw.create_conversation(identity)

        @app.get("/api/pipiclaw/v1/conversations/{conversation}/items")
        async def conversation_items(request: Request, conversation: str, identity=Depends(require_device)):
            return await pipiclaw.conversation_items(request, conversation, identity)

        @app.post("/api/pipiclaw/v1/responses")
        async def responses(request: Request, identity=Depends(require_device)):
            return await pipiclaw.responses(request, identity)

    if demo_mode:
        app.add_api_route("/demo/v1/responses", demo, methods=["POST"])

    @app.websocket("/speech/listen")
    async def open_socket(ws: WebSocket):
        if devices and not await device(ws):
            await ws.close(code=1008)
            return
        await listen(ws, models, recognition)

    @app.get("/speech/info", dependencies=[Depends(require_device)])
    async def speech_info():
        return tts_info(models)

    @app.post("/speech/prepare", dependencies=[Depends(require_device)])
    async def prepare():
        try:
            speakers = await asyncio.to_thread(models.prepare_synthesis)
            return {**tts_info(models), "speakers": speakers}
        except FileNotFoundError as exc:
            return error(exc, 503)
        except Exception:
            LOG.exception("TTS initialization failed")
            return error("语音合成模型初始化失败，请查看服务日志。", 500)

    @app.post("/speech/synthesize", dependencies=[Depends(require_device)])
    async def generate(request: Request):
        return await tts(request, synthesis)

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("serve", "pair"), default="serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--public-url", default=os.environ.get("TURNLINE_PUBLIC_URL"),
                        help="Address for pairing links or the name for a self-issued certificate")
    parser.add_argument("--code", action="store_true", help="Print a pairing code for the browser's current address")
    parser.add_argument("--tunnel", action="store_true", help="Accept HTTPS forwarding from a loopback tunnel agent")
    parser.add_argument("--tls-cert", type=Path, help="PEM certificate chain for direct HTTPS")
    parser.add_argument("--tls-key", type=Path, help="PEM private key for direct HTTPS")
    parser.add_argument("--self-signed", action="store_true", help="Issue a certificate with a local Turnline CA")
    parser.add_argument("--state-dir", type=Path, default=default_state())
    parser.add_argument("--pipiclaw-socket", type=Path, default=default_socket())
    parser.add_argument("--direct-only", action="store_true", help="Disable the server-side Pipiclaw relay")
    parser.add_argument("--tts-threads", type=int, default=2)
    parser.add_argument("--demo", action="store_true")
    options = parser.parse_args()

    address = f"[{options.host}]" if ":" in options.host else options.host
    local_listener = loopback(options.host)
    try:
        public_url = normalize_origin(options.public_url) if options.public_url else None
        if not 0 <= options.port <= 65535:
            raise ValueError("Port must be between 0 and 65535.")
        if options.command == "pair":
            if options.demo:
                raise ValueError("The loopback demo does not use pairing.")
            if not options.code and not public_url and (options.port == 0 or not local_listener):
                raise ValueError("Use --code or provide the URL for the pairing link.")
            token = DeviceStore(options.state_dir).issue()
            scheme = "https" if options.tls_cert or options.self_signed else "http"
            site = public_url or f"{scheme}://{address}:{options.port}"
            print(token if options.code else f"{site}/#pair={token}")
            return

        if options.code:
            raise ValueError("--code is used with the pair command.")
        if (options.tunnel or options.demo) and not local_listener:
            raise ValueError("--tunnel and --demo require a loopback listener.")
        if options.demo and (options.direct_only or options.tunnel
                             or (public_url and not loopback(urlsplit(public_url).hostname))):
            raise ValueError("--demo is only for a standalone loopback session.")
        if options.tts_threads < 1:
            raise ValueError("--tts-threads must be at least 1.")
        if bool(options.tls_cert) != bool(options.tls_key):
            raise ValueError("--tls-cert and --tls-key must be supplied together.")
        if options.self_signed:
            if options.tls_cert:
                raise ValueError("Choose a supplied certificate or --self-signed.")
            if (public_url and not public_url.startswith("https://")) or (
                not public_url and options.host in {"0.0.0.0", "::"}
            ):
                raise ValueError("Provide the HTTPS browser address with --public-url for this certificate.")
            hostname = urlsplit(public_url or f"https://{address}").hostname
            options.tls_cert, options.tls_key, ca = certificates(options.state_dir, hostname)
            print(f"Trust this CA on your devices: {ca}", flush=True)
        if not local_listener and not options.tls_cert:
            raise ValueError("A non-loopback listener requires a TLS certificate.")

        app = create_app(options.tts_threads, socket_path=options.pipiclaw_socket, state_dir=options.state_dir,
                         demo_mode=options.demo, direct_only=options.direct_only, tunnel=options.tunnel)
        config = uvicorn.Config(
            app, host=options.host, port=options.port, proxy_headers=False, access_log=False, workers=1,
            ssl_certfile=options.tls_cert, ssl_keyfile=options.tls_key,
            ws="websockets-sansio", ws_max_size=8192,
        )
        config.load()
        family = socket.AF_INET6 if ":" in options.host else socket.AF_INET
        with socket.create_server((options.host, options.port), family=family) as listener:
            port = listener.getsockname()[1]
            scheme = "https" if options.tls_cert else "http"
            print(f"Turnline {public_url or f'{scheme}://{address}:{port}'}", flush=True)
            uvicorn.Server(config).run(sockets=[listener])
    except (ImportError, OSError, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
