"""High quality Vietnamese Text-To-Speech using Edge TTS with instant Google TTS fallback & persistent cache."""
import re
import hashlib
import asyncio
import urllib.parse
from pathlib import Path
from typing import Tuple, Dict, List
import aiohttp
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
    """Estimates MP3 duration in seconds from byte size (48kbps = 6000 bytes/s, 32kbps = 4000 bytes/s)."""
    if not audio_bytes:
        return 0.0
    return round(max(0.4, len(audio_bytes) / 5500.0), 2)


def split_text_chunks(text: str, max_chars: int = 180) -> List[str]:
    """Splits text into chunks <= max_chars at punctuation or word boundaries for Google TTS fallback."""
    if len(text) <= max_chars:
        return [text]
    parts = re.split(r"(?<=[.,!?;:])\s+", text)
    chunks = []
    current = ""
    for p in parts:
        if len(current) + len(p) + 1 <= max_chars:
            current = f"{current} {p}".strip()
        else:
            if current:
                chunks.append(current)
            if len(p) <= max_chars:
                current = p
            else:
                words = p.split(" ")
                current = ""
                for w in words:
                    if len(current) + len(w) + 1 <= max_chars:
                        current = f"{current} {w}".strip()
                    else:
                        if current:
                            chunks.append(current)
                        current = w
    if current:
        chunks.append(current)
    return chunks


class EdgeTTS:
    def __init__(self, default_voice: str = "vi-VN-HoaiMyNeural"):
        self.default_voice = default_voice
        self._sem = asyncio.Semaphore(3)

    def _get_cache_key(self, text: str, voice: str, rate: int, pitch: int) -> str:
        raw = f"{text}|{voice}|{rate}|{pitch}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    async def _run_edge_once(self, clean_text: str, voice_name: str, rate: int, pitch: int, use_custom: bool) -> bytes:
        if use_custom and (rate != 0 or pitch != 0):
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
        return b"".join(chunks)

    async def _synthesize_google_tts(self, clean_text: str) -> bytes:
        """Fast & reliable Google Translate Vietnamese TTS fallback when Edge TTS drops connection."""
        sub_chunks = split_text_chunks(clean_text, 180)
        audio_parts = []
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=4.0)) as session:
            for part in sub_chunks:
                q = urllib.parse.quote(part)
                url = f"https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q={q}"
                async with session.get(url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                    if resp.status == 200:
                        data = await resp.read()
                        if data:
                            audio_parts.append(data)
        return b"".join(audio_parts)

    def _save_to_cache(self, cache_key: str, cache_file: Path, audio_bytes: bytes) -> Tuple[bytes, float, str]:
        duration = estimate_mp3_duration(audio_bytes)
        cache_file.write_bytes(audio_bytes)
        if len(MEMORY_CACHE) >= MAX_MEMORY_CACHE:
            for k in list(MEMORY_CACHE.keys())[:50]:
                MEMORY_CACHE.pop(k, None)
        MEMORY_CACHE[cache_key] = (audio_bytes, duration)
        return audio_bytes, duration, cache_key

    async def synthesize(
        self,
        text: str,
        voice: str = None,
        rate: int = 0,
        pitch: int = 0
    ) -> Tuple[bytes, float, str]:
        """
        Synthesizes text to MP3 audio bytes with strict 3.5s timeout + Google TTS fallback.
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

        # 3. Call Edge TTS with 3.5s timeout per attempt (max 2 attempts)
        async with self._sem:
            for attempt in range(2):
                try:
                    audio_bytes = await asyncio.wait_for(
                        self._run_edge_once(clean_text, voice_name, rate, pitch, use_custom=(attempt == 0)),
                        timeout=3.5
                    )
                    if audio_bytes and len(audio_bytes) > 200:
                        return self._save_to_cache(cache_key, cache_file, audio_bytes)
                except Exception:
                    await asyncio.sleep(0.15)

            # 4. Immediate fallback to Google Vietnamese TTS (~0.2s)
            try:
                g_bytes = await self._synthesize_google_tts(clean_text)
                if g_bytes and len(g_bytes) > 200:
                    return self._save_to_cache(cache_key, cache_file, g_bytes)
            except Exception as e:
                raise RuntimeError(f"Both Edge TTS and Google TTS fallback failed: {e}")

        raise RuntimeError("TTS synthesis returned empty audio")
