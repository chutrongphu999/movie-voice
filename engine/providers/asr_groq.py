"""Groq Whisper ASR Provider for fast, accurate speech-to-text with timestamps and anti-hallucination filters."""
import array
import math
import os
import re
import subprocess
import asyncio
from typing import List, Dict, Any
import imageio_ffmpeg
import groq

FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()

# Known Whisper hallucinations on background music / silence chunks
HALLUCINATION_PHRASES = {
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "thanks",
    "thank you very much",
    "you",
    "the",
    "a",
    "i",
    "bye",
    "bye bye",
    "goodbye",
    "see you next time",
    "subtitles by",
    "amara.org",
    "please subscribe",
    "subscribe",
    "cảm ơn",
    "cảm ơn các bạn đã theo dõi",
    "hãy đăng ký kênh",
}


def compute_pcm_rms(wav_bytes: bytes) -> float:
    """Computes RMS amplitude of 16-bit PCM WAV data (skipping 44-byte header)."""
    if len(wav_bytes) <= 44:
        return 0.0
    pcm = wav_bytes[44:]
    # Ensure even byte length for int16
    if len(pcm) % 2 != 0:
        pcm = pcm[:-1]
    if not pcm:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm)
    # Sample every 16th frame for speed
    step = 16
    subset = samples[::step]
    if not subset:
        return 0.0
    sum_sq = sum(s * s for s in subset)
    return math.sqrt(sum_sq / len(subset))


def is_hallucination_text(text: str, duration: float) -> bool:
    """Checks if a transcribed segment is a known Whisper silence/music hallucination."""
    cleaned = re.sub(r"[^\w\sàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]", "", text.lower()).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned or len(cleaned) <= 1:
        return True
    if cleaned in HALLUCINATION_PHRASES:
        return True
    if "amara.org" in text.lower() or "subtitles by" in text.lower():
        return True
    # Single or two-word phrase stretched across > 8 seconds is always a music hallucination
    word_count = len(cleaned.split())
    if duration > 8.0 and word_count <= 2:
        return True
    return False


ASR_MODELS = [
    "whisper-large-v3-turbo",
    "whisper-large-v3",
]


class GroqASR:
    def __init__(self, api_key: str = None, model: str = "whisper-large-v3-turbo"):
        self.api_key = api_key or os.getenv("GROQ_API_KEY", "")
        self.model = model
        self._model_idx = 0
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
        Transcribes audio bytes and returns segments with clamped timestamps and hallucination filtering.
        Each cue: {"start": float, "end": float, "text": str}
        """
        if not self.client:
            raise RuntimeError("Chưa cấu hình GROQ_API_KEY trong engine/.env!")

        try:
            wav_bytes = await self.convert_to_wav(audio_bytes)
        except Exception as e:
            print(f"[ASR Warning] Chunk cannot be decoded by FFmpeg yet: {e}")
            return []

        if len(wav_bytes) < 3200:
            return []

        # 16kHz * 1 channel * 2 bytes/sample = 32000 bytes per second
        wav_duration = max(0.3, (len(wav_bytes) - 44) / 32000.0)

        # Skip near-silent chunks before calling Whisper API
        rms = compute_pcm_rms(wav_bytes)
        if rms < 55.0:
            return []

        # Alternate between whisper-large-v3-turbo and whisper-large-v3 (each has its own 20 RPM bucket = 40 RPM total)
        result = None
        for attempt in range(3):
            chosen_model = ASR_MODELS[(self._model_idx + attempt) % len(ASR_MODELS)]
            try:
                def _call_groq(m=chosen_model):
                    return self.client.audio.transcriptions.create(
                        file=("chunk.wav", wav_bytes),
                        model=m,
                        response_format="verbose_json",
                        temperature=0.0
                    )
                result = await asyncio.to_thread(_call_groq)
                self._model_idx = (self._model_idx + 1) % len(ASR_MODELS)
                break
            except groq.RateLimitError:
                print(f"[ASR] Rate limit on {chosen_model}, switching model / waiting...")
                await asyncio.sleep(1.2 * (attempt + 1))
            except Exception as e:
                print(f"[ASR Warning] Groq transcription error on {chosen_model}: {e}")
                return []

        if result is None:
            return []
        cues = []
        segments = getattr(result, "segments", []) or []

        for seg in segments:
            is_dict = isinstance(seg, dict)
            start = float(seg.get("start", 0.0) if is_dict else getattr(seg, "start", 0.0))
            end = float(seg.get("end", 0.0) if is_dict else getattr(seg, "end", 0.0))
            text = (seg.get("text", "") if is_dict else getattr(seg, "text", "")).strip()
            no_speech_prob = float(
                seg.get("no_speech_prob", 0.0) if is_dict else getattr(seg, "no_speech_prob", 0.0)
            )

            # Drop high no_speech_prob or segments starting past actual audio length
            if no_speech_prob > 0.65 or start >= wav_duration - 0.15:
                continue

            # Clamp end timestamp to actual WAV duration so Whisper never invents 30s cues
            end = min(end, wav_duration + 0.25)
            seg_dur = end - start
            if not text or seg_dur < 0.2:
                continue

            if is_hallucination_text(text, seg_dur):
                continue

            cues.append({
                "start": round(time_offset + start, 3),
                "end": round(time_offset + end, 3),
                "text": text
            })

        return cues
