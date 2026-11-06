"""High quality Vietnamese Text-To-Speech using Edge TTS with persistent audio cache."""
import os
import re
import hashlib
import asyncio
import subprocess
from pathlib import Path
from typing import Tuple, Dict
import edge_tts
import imageio_ffmpeg

FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache" / "audio"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# In-memory LRU cache: cache_key -> (audio_bytes, duration)
MEMORY_CACHE: Dict[str, Tuple[bytes, float]] = {}
MAX_MEMORY_CACHE = 500

DEFAULT_VOICES = {
    "female": "vi-VN-HoaiMyNeural",
    "male": "vi-VN-NamMinhNeural"
}


def clean_text_for_speech(text: str) -> str:
    """Cleans subtitle formatting, HTML tags, and sound indicators."""
    if not text:
        return ""
    # Strip HTML tags
    text = re.sub(r"<[^>]+>", " ", text)
    # Strip parenthetical sound descriptions [laughs], (sighs)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\([^\)]*\)", " ", text)
    # Strip music notes
    text = re.sub(r"[♪♫♬♩]+", " ", text)
    # Strip speaker prefixes like "JOHN: "
    text = re.sub(r"^[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ0-9_\s]{2,15}:\s*", "", text)
    # Normalize whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


class EdgeTTS:
    def __init__(self, default_voice: str = "vi-VN-HoaiMyNeural"):
        self.default_voice = default_voice

    def _get_cache_key(self, text: str, voice: str, rate: str, pitch: str) -> str:
        raw = f"{text}|{voice}|{rate}|{pitch}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    async def _measure_audio_duration(self, audio_data: bytes) -> float:
        """Uses FFmpeg probe to calculate exact duration of synthesized audio in seconds."""
        def _run():
            cmd = [
                FFMPEG_EXE,
                "-hide_banner",
                "-i", "pipe:0",
                "-f", "null",
                "-"
            ]
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
            _, stderr = process.communicate(input=audio_data)
            match = re.search(rb"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
            if match:
                h, m, s = map(float, match.groups())
                return h * 3600 + m * 60 + s
            return 1.0

        return await asyncio.to_thread(_run)

    async def synthesize(
        self,
        text: str,
        voice: str = None,
        rate: int = 0,
        pitch: int = 0
    ) -> Tuple[bytes, float, str]:
        """
        Synthesizes text to MP3 audio bytes.
        Returns: (audio_bytes, duration_seconds, audio_id)
        """
        clean_text = clean_text_for_speech(text)
        if not clean_text:
            return b"", 0.0, ""

        voice_name = voice or self.default_voice
        rate_str = f"+{rate}%" if rate >= 0 else f"{rate}%"
        pitch_str = f"+{pitch}Hz" if pitch >= 0 else f"{pitch}Hz"

        cache_key = self._get_cache_key(clean_text, voice_name, rate_str, pitch_str)

        # 1. Check in-memory cache
        if cache_key in MEMORY_CACHE:
            data, dur = MEMORY_CACHE[cache_key]
            return data, dur, cache_key

        # 2. Check disk cache
        cache_file = CACHE_DIR / f"{cache_key}.mp3"
        if cache_file.exists():
            data = cache_file.read_bytes()
            dur = await self._measure_audio_duration(data)
            MEMORY_CACHE[cache_key] = (data, dur)
            return data, dur, cache_key

        # 3. Call Edge TTS
        communicate = edge_tts.Communicate(
            text=clean_text,
            voice=voice_name,
            rate=rate_str,
            pitch=pitch_str
        )

        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])

        audio_bytes = b"".join(chunks)
        if not audio_bytes:
            raise RuntimeError("Edge TTS returned no audio data")

        duration = await self._measure_audio_duration(audio_bytes)

        # Write to disk cache
        cache_file.write_bytes(audio_bytes)

        # Update in-memory cache
        if len(MEMORY_CACHE) >= MAX_MEMORY_CACHE:
            for k in list(MEMORY_CACHE.keys())[:50]:
                MEMORY_CACHE.pop(k, None)
        MEMORY_CACHE[cache_key] = (audio_bytes, duration)

        return audio_bytes, duration, cache_key
