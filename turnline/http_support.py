"""HTTP request limits and streams tied to the browser connection."""

import json

from anyio import create_task_group
from anyio.lowlevel import checkpoint
from fastapi import HTTPException
from starlette.responses import JSONResponse, Response, StreamingResponse

BODY_LIMIT = 128 * 1024
WS_AUTH_CLOSE_CODE = 4401


def error(message, status=400):
    return JSONResponse({"error": {"message": str(message)}}, status_code=status)


async def read_json(request, *, allow_empty=False, limit=BODY_LIMIT):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "请求内容过大。")
        body.extend(chunk)
    if allow_empty and not body.strip():
        return {}
    try:
        return json.loads(body)
    except ValueError as exc:
        raise HTTPException(400, "请发送有效的 JSON。") from exc


class ClientStream(Response):
    """Cancel work on disconnect, including while waiting for the first chunk."""

    def __init__(self, prepare):
        super().__init__()
        self.prepare = prepare

    async def __call__(self, scope, receive, send):
        async with create_task_group() as tasks:
            async def watch_disconnect():
                while (await receive())["type"] != "http.disconnect":
                    pass
                tasks.cancel_scope.cancel()

            async def send_or_cancel(message):
                try:
                    await send(message)
                except OSError:
                    tasks.cancel_scope.cancel()
                    await checkpoint()

            tasks.start_soon(watch_disconnect)
            async with self.prepare() as response:
                if isinstance(response, StreamingResponse):
                    await response.stream_response(send_or_cancel)
                else:
                    await response(scope, receive, send_or_cancel)
            tasks.cancel_scope.cancel()
