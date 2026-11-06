"""Groq Whisper ASR Provider for fast, accurate speech-to-text with timestamps."""
import io
import os
import subprocess
import asyncio
from typing import List, Dict, Any
import imageio_ffmpeg
import groq

FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()


class GroqASR:
    def __init__(self, api_key: str = None, model: str = "whisper-large-v3-turbo"):
        self.api_key = api_key or os.getenv("GROQ_API_KEY", "")
        self.model = model
        self.client = groq.Groq(api_key=self.api_key) if self.api_key else None

    def update_key(self, api_key: str):
        self.api_key = api_key
        self.client = groq.Groq(api_key=api_key) if api_key else None

    async def convert_to_wav(self, audio_data: bytes) -> bytes:
        """Converts arbitrary audio/video container (MSE chunks, webm, mp4, aac) to 16kHz mono WAV."""
        def _run_ffmpeg():
            cmd = [
                FFMPEG_EXE,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i", "pipe:0",
                "-vn",
                "-ac", "1",
                "-ar", "16000",
                "-f", "wav",
                "pipe:1"
            ]
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
            stdout, stderr = process.communicate(input=audio_data)
            if process.returncode != 0:
                raise RuntimeError(f"FFmpeg conversion failed: {stderr.decode('utf-8', errors='ignore')}")
            return stdout

        return await asyncio.to_thread(_run_ffmpeg)

    async def transcribe(self, audio_bytes: bytes, time_offset: float = 0.0) -> List[Dict[str, Any]]:
        """
        Transcribes audio bytes and returns segments with absolute timestamps.
        Each cue: {"start": float, "end": float, "text": str}
        """
        if not self.client:
            raise RuntimeError("Chưa cấu hình GROQ_API_KEY trong engine/.env!")

        # Convert input buffer to clean WAV
        try:
            wav_bytes = await self.convert_to_wav(audio_bytes)
        except Exception as e:
            print(f"[ASR Warning] Chunk cannot be decoded by FFmpeg yet (likely missing init segment or keyframe): {e}")
            return []

        if len(wav_bytes) < 1000:
            return []

        def _call_groq():
            # Groq audio file upload
            response = self.client.audio.transcriptions.create(
                file=("chunk.wav", wav_bytes),
                model=self.model,
                response_format="verbose_json",
                temperature=0.0
            )
            return response

        result = await asyncio.to_thread(_call_groq)
        cues = []
        segments = getattr(result, "segments", []) or []

        for seg in segments:
            # Handle both dict-like and object-like segment attributes
            start = float(seg.get("start", 0.0) if isinstance(seg, dict) else getattr(seg, "start", 0.0))
            end = float(seg.get("end", 0.0) if isinstance(seg, dict) else getattr(seg, "end", 0.0))
            text = (seg.get("text", "") if isinstance(seg, dict) else getattr(seg, "text", "")).strip()

            if not text or (end - start) < 0.2:
                continue

            cues.append({
                "start": round(time_offset + start, 3),
                "end": round(time_offset + end, 3),
                "text": text
            })

        return cues
