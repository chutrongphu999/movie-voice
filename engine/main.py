"""FastAPI Server for Movie Voice Engine (Phase 1)."""
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ENV_FILE = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_FILE)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from pipeline import DubbingPipeline
from providers.tts_edge import CACHE_DIR

app = FastAPI(title="Movie Voice Engine - AI Dubbing & Synchronization")

# Allow CORS for Chrome Extensions and local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = DubbingPipeline()


class SubtitleItem(BaseModel):
    start: float
    end: float
    text: str


class SubtitlesRequest(BaseModel):
    cues: List[SubtitleItem]
    voice: Optional[str] = "vi-VN-HoaiMyNeural"
    rate: Optional[int] = 0
    pitch: Optional[int] = 0
    is_vietnamese: Optional[bool] = True


class SettingsUpdate(BaseModel):
    groq_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    default_voice: Optional[str] = None


@app.get("/api/health")
async def health_check():
    groq_ok = bool(os.getenv("GROQ_API_KEY", "").strip())
    gemini_ok = bool(os.getenv("GEMINI_API_KEY", "").strip())
    return {
        "status": "online",
        "groq_configured": groq_ok,
        "gemini_configured": gemini_ok,
        "active_voice": os.getenv("DEFAULT_VOICE", "vi-VN-HoaiMyNeural"),
        "cached_audio_count": len(list(CACHE_DIR.glob("*.mp3")))
    }


@app.post("/api/dub/audio")
async def dub_audio_chunk(
    file: UploadFile = File(...),
    time_offset: float = Form(0.0),
    voice: str = Form("vi-VN-HoaiMyNeural"),
    rate: int = Form(0),
    pitch: int = Form(0)
):
    """
    Receives an audio chunk (WAV, MP3, AAC, WebM, MP4) captured by the browser extension
    and returns dubbing cues with audio links.
    """
    try:
        data = await file.read()
        if not data:
            return {"cues": []}

        cues = await pipeline.process_audio_buffer(
            audio_bytes=data,
            time_offset=time_offset,
            voice=voice,
            rate=rate,
            pitch=pitch
        )
        return {"cues": cues}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/dub/subtitles")
async def dub_subtitles(req: SubtitlesRequest):
    """
    Receives soft subtitles from the browser player, translates if needed, and synthesizes speech.
    """
    try:
        raw_cues = [c.dict() for c in req.cues]
        cues = await pipeline.process_subtitles(
            cues=raw_cues,
            voice=req.voice,
            rate=req.rate,
            pitch=req.pitch,
            is_vietnamese=req.is_vietnamese
        )
        return {"cues": cues}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dub/voice/{audio_id}")
async def get_dub_voice(audio_id: str):
    """Streams synthesized MP3 audio chunk to the browser player."""
    file_path = CACHE_DIR / f"{audio_id}.mp3"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(file_path, media_type="audio/mpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/settings")
async def get_settings():
    return {
        "groq_configured": bool(os.getenv("GROQ_API_KEY")),
        "gemini_configured": bool(os.getenv("GEMINI_API_KEY")),
        "default_voice": os.getenv("DEFAULT_VOICE", "vi-VN-HoaiMyNeural"),
        "asr_model": os.getenv("ASR_MODEL", "whisper-large-v3-turbo"),
        "translate_model": os.getenv("TRANSLATE_MODEL", "gemini-2.5-flash-lite")
    }


@app.post("/api/settings")
async def update_settings(req: SettingsUpdate):
    if req.groq_api_key is not None:
        os.environ["GROQ_API_KEY"] = req.groq_api_key.strip()
    if req.gemini_api_key is not None:
        os.environ["GEMINI_API_KEY"] = req.gemini_api_key.strip()
    if req.default_voice is not None:
        os.environ["DEFAULT_VOICE"] = req.default_voice.strip()

    # Persist into .env
    lines = [
        f"GROQ_API_KEY={os.getenv('GROQ_API_KEY', '')}",
        f"GEMINI_API_KEY={os.getenv('GEMINI_API_KEY', '')}",
        f"DEFAULT_VOICE={os.getenv('DEFAULT_VOICE', 'vi-VN-HoaiMyNeural')}",
        f"ASR_MODEL={os.getenv('ASR_MODEL', 'whisper-large-v3-turbo')}",
        f"TRANSLATE_MODEL={os.getenv('TRANSLATE_MODEL', 'gemini-2.5-flash-lite')}",
    ]
    ENV_FILE.write_text("\n".join(lines), encoding="utf-8")
    pipeline.reload_config()
    return {"ok": True, "message": "Settings updated successfully"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=False)
