import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from readaloud.config import EXTENSION_ORIGIN_REGEX, allowed_origins
from readaloud.routes import extract, health, settings, tts, voices


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Run the job TTL sweeper, and drop job audio on shutdown."""
    sweeper = asyncio.create_task(tts.sweep_jobs_forever())
    try:
        yield
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper
        tts.shutdown_job_storage()


def create_app() -> FastAPI:
    """Build the application.

    A factory rather than a module-level app so CORS configuration can be exercised
    under different settings without reimporting the module.
    """
    app = FastAPI(title="ReadAloud API", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_origin_regex=EXTENSION_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    app.include_router(health.router, prefix="/api")
    app.include_router(tts.router, prefix="/api")
    app.include_router(extract.router, prefix="/api")
    app.include_router(voices.router, prefix="/api")
    app.include_router(settings.router, prefix="/api")

    frontend_dist = Path(__file__).resolve().parent.parent.parent.parent / "frontend" / "dist"
    if frontend_dist.is_dir():
        app.mount("/", StaticFiles(directory=str(frontend_dist), html=True))

    return app


app = create_app()
