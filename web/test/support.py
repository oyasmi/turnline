import asyncio
from contextlib import asynccontextmanager
import socket

import uvicorn


@asynccontextmanager
async def running(app, *, uds=None):
    family = socket.AF_UNIX if uds else socket.AF_INET
    with socket.socket(family) as listener:
        listener.bind(str(uds) if uds else ("127.0.0.1", 0))
        listener.listen()
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False, timeout_graceful_shutdown=2))
        task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    if task.done():
                        task.result()
                        raise RuntimeError("Uvicorn did not start.")
                    await asyncio.sleep(0.01)
            yield None if uds else f"http://127.0.0.1:{listener.getsockname()[1]}"
        finally:
            server.should_exit = True
            await task
