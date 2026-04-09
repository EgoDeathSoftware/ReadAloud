from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from readaloud.routes import extract, health, settings, tts, voices

app = FastAPI(title="ReadAloud API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(tts.router, prefix="/api")
app.include_router(extract.router, prefix="/api")
app.include_router(voices.router, prefix="/api")
app.include_router(settings.router, prefix="/api")

frontend_dist = Path(__file__).resolve().parent.parent.parent.parent / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True))
