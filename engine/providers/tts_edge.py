"""High quality Vietnamese Text-To-Speech using Edge TTS with FFmpeg silence trimming, exact duration & cache.
Inspired by real-time-video-subs (rtsubs) & LocalDub for zero dead-air and exact slot time-fitting.
"""
import re
import hashlib
import asyncio
import subprocess
import urllib.parse
from pathlib import Path
from typing import Tuple, Dict, List
import aiohttp
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
    """
    Cleans subtitle formatting, HTML tags, sound indicators, and trailing commas
    (from rtsubs/translate.py _clean: never end on a dangling comma so TTS reads a complete clause).
    """
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
    text = re.sub(r"\s+", " ", text).strip().strip("\"“”")
    text = re.sub(r"[,;:，；：、\s]+$", "", text)
    if text and text[-1].isalnum():
        text += "."
    return text


def trim_silence_and_measure_mp3(raw_mp3: bytes, target_slot: float = 0.0) -> Tuple[bytes, float]:
    """
    Uses FFmpeg to strip Edge-TTS leading/trailing silence (200-350ms dead air),
    applies pitch-preserving WSOLA time-fitting (atempo <= 1.25, from rtsubs/tts.py load_fitted)
    if needed to fit target_slot without changing voice pitch,
    and outputs CBR 64kbps MP3 where byte length / 8000.0 gives exact duration to +-0.02s.
    """
    if not raw_mp3 or len(raw_mp3) < 200:
        return raw_mp3, 0.0

    try:
        # Edge-TTS raw stream is 48kbps CBR (6000 bytes/sec) with ~0.28s leading+trailing silence
        est_trimmed_dur = max(0.25, (len(raw_mp3) / 6000.0) - 0.28)
        tempo = 1.0
        if target_slot and target_slot >= 0.5 and est_trimmed_dur > target_slot * 1.03:
            # Cap at 1.25x so speech always sounds natural and calm while preserving 100% original pitch
            tempo = min(1.25, max(1.0, est_trimmed_dur / target_slot))

        af_chain = (
            "silenceremove=start_periods=1:start_silence=0.03:start_threshold=-42dB,"
            "areverse,"
            "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-42dB,"
            "areverse"
        )
        if tempo > 1.02:
            af_chain = f"{af_chain},atempo={tempo:.4f}"

        cmd = [
            FFMPEG_EXE,
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", "pipe:0",
            "-af", af_chain,
            "-ac", "1",
            "-ar", "24000",
            "-c:a", "libmp3lame",
            "-b:a", "64k",
            "-write_xing", "0",
            "-f", "mp3",
            "pipe:1"
        ]
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
        stdout, _ = proc.communicate(input=raw_mp3, timeout=4.0)
        if proc.returncode == 0 and len(stdout) > 400:
            # CBR 64kbps = exactly 8000 bytes per second
            exact_dur = round(max(0.25, len(stdout) / 8000.0), 2)
            return stdout, exact_dur
    except Exception:
        pass

    fallback_dur = round(max(0.35, len(raw_mp3) / 6000.0), 2)
    return raw_mp3, fallback_dur


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
        self._sem = asyncio.Semaphore(5)

    def _get_cache_key(self, text: str, voice: str, rate: int, pitch: int) -> str:
        raw = f"v2|{text}|{voice}|{rate}|{pitch}".encode("utf-8")
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
        """Fallback to Google Vietnamese TTS only if Edge Neural TTS fails for this specific line."""
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

    async def _save_to_cache(
        self,
        cache_key: str,
        cache_file: Path,
        raw_audio_bytes: bytes,
        target_slot: float = 0.0
    ) -> Tuple[bytes, float, str]:
        trimmed_bytes, duration = await asyncio.to_thread(
            trim_silence_and_measure_mp3,
            raw_audio_bytes,
            target_slot
        )
        cache_file.write_bytes(trimmed_bytes)
        if len(MEMORY_CACHE) >= MAX_MEMORY_CACHE:
            for k in list(MEMORY_CACHE.keys())[:50]:
                MEMORY_CACHE.pop(k, None)
        MEMORY_CACHE[cache_key] = (trimmed_bytes, duration)
        return trimmed_bytes, duration, cache_key

    async def synthesize(
        self,
        text: str,
        voice: str = None,
        rate: int = 0,
        pitch: int = 0,
        target_slot: float = 0.0
    ) -> Tuple[bytes, float, str]:
        """
        Synthesizes text to silence-trimmed, pitch-preserving slot-fitted CBR 64k MP3 audio bytes
        using Microsoft Edge Neural Voice, returning (audio_bytes, exact_duration_sec, cache_key).
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
                dur = round(max(0.25, len(data) / 8000.0), 2)
                MEMORY_CACHE[cache_key] = (data, dur)
                return data, dur, cache_key

        # Default +8% cadence gives HoaiMyNeural / NamMinhNeural a crisp professional thuyết minh pace
        effective_rate = rate + 8

        # 3. Call Edge Neural TTS inside semaphore (6.5s timeout so it never aborts mid-synthesis at 3.5s)
        async with self._sem:
            try:
                audio_bytes = await asyncio.wait_for(
                    self._run_edge_once(clean_text, voice_name, effective_rate, pitch, use_custom=True),
                    timeout=6.5
                )
                if audio_bytes and len(audio_bytes) > 200:
                    return await self._save_to_cache(cache_key, cache_file, audio_bytes, target_slot=target_slot)
            except Exception:
                pass

            # 4. Per-line fallback to Google Vietnamese TTS only if Edge truly failed
            try:
                g_bytes = await self._synthesize_google_tts(clean_text)
                if g_bytes and len(g_bytes) > 200:
                    return await self._save_to_cache(cache_key, cache_file, g_bytes, target_slot=target_slot)
            except Exception as e:
                raise RuntimeError(f"Both Edge TTS and Google TTS fallback failed: {e}")

        raise RuntimeError("TTS synthesis returned empty audio")
