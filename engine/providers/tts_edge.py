"""High quality Vietnamese Text-To-Speech using Edge TTS with persistent audio cache."""
import re
import hashlib
import asyncio
from pathlib import Path
from typing import Tuple, Dict
import edge_tts

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
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\([^\)]*\)", " ", text)
    text = re.sub(r"[♪♫♬♩]+", " ", text)
    text = re.sub(
        r"^[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ0-9_\s]{2,15}:\s*",
        "",
        text
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text


def estimate_mp3_duration(audio_bytes: bytes) -> float:
    """Edge TTS outputs 24kHz 48kbps mono MP3 (6000 bytes/sec)."""
    if not audio_bytes:
        return 0.0
    return round(max(0.4, len(audio_bytes) / 6000.0), 2)


class EdgeTTS:
    def __init__(self, default_voice: str = "vi-VN-HoaiMyNeural"):
        self.default_voice = default_voice
        # Limit concurrent connections to Edge TTS to avoid upstream throttling
        self._sem = asyncio.Semaphore(3)

    def _get_cache_key(self, text: str, voice: str, rate: int, pitch: int) -> str:
        raw = f"{text}|{voice}|{rate}|{pitch}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    async def synthesize(
        self,
        text: str,
        voice: str = None,
        rate: int = 0,
        pitch: int = 0
    ) -> Tuple[bytes, float, str]:
        """
        Synthesizes text to MP3 audio bytes with automatic retry.
        Returns: (audio_bytes, duration_seconds, audio_id)
        """
        clean_text = clean_text_for_speech(text)
        if not clean_text or len(clean_text) < 2:
            return b"", 0.0, ""

        voice_name = voice or self.default_voice
        cache_key = self._get_cache_key(clean_text, voice_name, rate, pitch)

        # 1. Check in-memory cache
        if cache_key in MEMORY_CACHE:
            data, dur = MEMORY_CACHE[cache_key]
            return data, dur, cache_key

        # 2. Check disk cache
        cache_file = CACHE_DIR / f"{cache_key}.mp3"
        if cache_file.exists():
            data = cache_file.read_bytes()
            if len(data) > 200:
                dur = estimate_mp3_duration(data)
                MEMORY_CACHE[cache_key] = (data, dur)
                return data, dur, cache_key

        # 3. Call Edge TTS with concurrency limit & retries
        last_err = None
        async with self._sem:
            for attempt in range(3):
                try:
                    use_custom = (rate != 0 or pitch != 0) and (attempt < 2)
                    if use_custom:
                        rate_str = f"+{rate}%" if rate >= 0 else f"{rate}%"
                        pitch_str = f"+{pitch}Hz" if pitch >= 0 else f"{pitch}Hz"
                        communicate = edge_tts.Communicate(
                            text=clean_text,
                            voice=voice_name,
                            rate=rate_str,
                            pitch=pitch_str
                        )
                    else:
                        communicate = edge_tts.Communicate(
                            text=clean_text,
                            voice=voice_name
                        )

                    chunks = []
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            chunks.append(chunk["data"])

                    audio_bytes = b"".join(chunks)
                    if audio_bytes and len(audio_bytes) > 200:
                        duration = estimate_mp3_duration(audio_bytes)
                        cache_file.write_bytes(audio_bytes)
                        if len(MEMORY_CACHE) >= MAX_MEMORY_CACHE:
                            for k in list(MEMORY_CACHE.keys())[:50]:
                                MEMORY_CACHE.pop(k, None)
                        MEMORY_CACHE[cache_key] = (audio_bytes, duration)
                        return audio_bytes, duration, cache_key
                except Exception as e:
                    last_err = e
                    await asyncio.sleep(0.35 * (attempt + 1))

        raise RuntimeError(f"Edge TTS failed after 3 attempts: {last_err}")
