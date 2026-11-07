"""Groq Whisper ASR Provider with FFmpeg vocal isolation, rolling context prompt, and accurate filtering."""
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

# Known Whisper hallucinations on background music / action / silence chunks
HALLUCINATION_SUBSTRINGS = [
    "thank you for watching",
    "thanks for watching",
    "hope you enjoyed",
    "hope you enjoy",
    "welcome to the first episode",
    "don't forget to subscribe",
    "please subscribe",
    "like and subscribe",
    "see you in the next",
    "subtitles by",
    "amara.org",
    "transcribed by",
    "castingwords",
    "in the description",
    "avenger 1",
    "avenger 2",
    "avenger 3",
    "speaker 1",
    "speaker 2",
    "hy vọng bạn thích video",
    "chào mừng đến với tập đầu tiên",
    "cảm ơn các bạn đã xem",
    "hãy đăng ký kênh",
]

HALLUCINATION_EXACT = {
    "you",
    "the",
    "a",
    "i",
    "subscribe",
    "uh",
    "um",
    "hmm",
}

SILENCE_ONLY_HALLUCINATION = {
    "thank you",
    "thanks",
    "thank you very much",
    "cảm ơn",
    "bye",
    "bye bye",
}

ASR_MODELS = [
    "whisper-large-v3",
    "whisper-large-v3-turbo",
]


def compute_pcm_rms(wav_bytes: bytes) -> float:
    """Computes RMS amplitude of 16-bit PCM WAV data (skipping header)."""
    if len(wav_bytes) <= 80:
        return 0.0
    pcm = wav_bytes[80:]
    if len(pcm) % 2 != 0:
        pcm = pcm[:-1]
    if not pcm:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm)
    step = 16
    subset = samples[::step]
    if not subset:
        return 0.0
    sum_sq = sum(s * s for s in subset)
    return math.sqrt(sum_sq / len(subset))


def is_hallucination_text(text: str, duration: float, no_speech_prob: float = 0.0) -> bool:
    """Checks if a transcribed segment is a Whisper silence/music/YouTube hallucination or stutter loop."""
    lower = text.lower().strip()
    for sub in HALLUCINATION_SUBSTRINGS:
        if sub in lower:
            return True

    cleaned = re.sub(
        r"[^\w\sàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]",
        " ",
        lower
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned or len(cleaned) <= 1:
        return True
    if cleaned in HALLUCINATION_EXACT:
        return True
    if cleaned in SILENCE_ONLY_HALLUCINATION and no_speech_prob > 0.50:
        return True

    words = cleaned.split()
    unique_words = set(words)
    if len(words) >= 3 and len(unique_words) == 1:
        return True
    if len(words) >= 4 and len(unique_words) <= 2:
        return True

    if duration > 6.5 and len(words) <= 2 and no_speech_prob > 0.45:
        return True

    return False


def merge_short_segments(cues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merges consecutive short segments that belong to the same sentence (gap < 0.45s)
    so the translator gets complete sentences instead of broken fragments.
    """
    if len(cues) <= 1:
        return cues

    merged = [cues[0].copy()]
    for cur in cues[1:]:
        prev = merged[-1]
        gap = cur["start"] - prev["end"]
        combined_dur = cur["end"] - prev["start"]
        prev_ends_sentence = bool(re.search(r"[.!?…]$", prev["text"].strip()))

        if gap < 0.45 and combined_dur <= 6.8 and (not prev_ends_sentence or (prev["end"] - prev["start"]) < 1.8):
            prev["end"] = round(cur["end"], 3)
            prev["text"] = f"{prev['text'].rstrip()} {cur['text'].lstrip()}".strip()
        else:
            if cur["start"] < prev["end"]:
                prev["end"] = round(max(prev["start"] + 0.4, cur["start"] - 0.04), 3)
            merged.append(cur.copy())

    return merged


class GroqASR:
    def __init__(self, api_key: str = None, model: str = "whisper-large-v3"):
        self.api_key = api_key or os.getenv("GROQ_API_KEY", "")
        self.model = model
        self._model_idx = 0
        self._last_prompt = ""
        self._last_offset = -999.0
        self.client = groq.Groq(api_key=self.api_key) if self.api_key else None

    def update_key(self, api_key: str):
        self.api_key = api_key
        self.client = groq.Groq(api_key=api_key) if api_key else None

    async def convert_to_wav(self, audio_data: bytes) -> bytes:
        """
        Converts arbitrary audio/video container (MSE chunks, webm, mp4, aac) to 16kHz mono WAV
        with speech bandpass filtering (100Hz-4200Hz) and dynamic normalization so voices stand out over movie SFX.
        """
        def _run_ffmpeg():
            cmd = [
                FFMPEG_EXE,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i", "pipe:0",
                "-vn",
                "-af", "highpass=f=85,lowpass=f=7600,dynaudnorm=f=250:g=15:p=0.9",
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

    async def transcribe(self, audio_bytes: bytes, time_offset: float = 0.0, glossary_hint: str = "") -> List[Dict[str, Any]]:
        """
        Transcribes audio bytes and returns clean, merged segments with clamped timestamps.
        """
        if not self.client:
            raise RuntimeError("Chưa cấu hình GROQ_API_KEY trong engine/.env!")

        try:
            wav_bytes = await self.convert_to_wav(audio_bytes)
        except Exception as e:
            print(f"[ASR Warning] Chunk at {time_offset:.1f}s cannot be decoded by FFmpeg: {e}")
            return []

        if len(wav_bytes) < 3200:
            return []

        wav_duration = max(0.3, (len(wav_bytes) - 78) / 32000.0)

        # Skip near-silent chunks before calling Whisper API
        rms = compute_pcm_rms(wav_bytes)
        if rms < 18.0:
            return []

        language = os.getenv("ASR_LANGUAGE", "auto").strip().lower()

        result = None
        for attempt in range(3):
            chosen_model = ASR_MODELS[(self._model_idx + attempt) % len(ASR_MODELS)]
            try:
                def _call_groq(m=chosen_model):
                    # Follow rtsubs/asr.py: NEVER pass prompt to Whisper so it never echoes glossary/previous text on BGM
                    kwargs = dict(
                        file=("chunk.wav", wav_bytes),
                        model=m,
                        response_format="verbose_json",
                        temperature=0.0,
                    )
                    if language and language != "auto":
                        kwargs["language"] = language
                    return self.client.audio.transcriptions.create(**kwargs)

                result = await asyncio.to_thread(_call_groq)
                self._model_idx = (self._model_idx + 1) % len(ASR_MODELS)
                break
            except groq.RateLimitError:
                print(f"[ASR] Rate limit on {chosen_model}, switching model...")
                await asyncio.sleep(0.8 * (attempt + 1))
            except Exception as e:
                print(f"[ASR Warning] Groq transcription error on {chosen_model}: {e}")
                return []

        if result is None:
            return []

        raw_segments = getattr(result, "segments", []) or []

        seg_texts = [
            (s.get("text", "") if isinstance(s, dict) else getattr(s, "text", "")).strip().lower()
            for s in raw_segments
        ]
        text_counts = {}
        for t in seg_texts:
            if t:
                text_counts[t] = text_counts.get(t, 0) + 1

        cues = []
        prev_norm = ""

        for seg in raw_segments:
            is_dict = isinstance(seg, dict)
            start = float(seg.get("start", 0.0) if is_dict else getattr(seg, "start", 0.0))
            end = float(seg.get("end", 0.0) if is_dict else getattr(seg, "end", 0.0))
            text = (seg.get("text", "") if is_dict else getattr(seg, "text", "")).strip()
            no_speech_prob = float(
                seg.get("no_speech_prob", 0.0) if is_dict else getattr(seg, "no_speech_prob", 0.0)
            )
            avg_logprob = float(
                seg.get("avg_logprob", -0.2) if is_dict else getattr(seg, "avg_logprob", -0.2)
            )
            compression_ratio = float(
                seg.get("compression_ratio", 1.0) if is_dict else getattr(seg, "compression_ratio", 1.0)
            )

            # Match rtsubs/asr.py: drop non-speech / BGM segments (no_speech_prob >= 0.78)
            if no_speech_prob >= 0.78 or avg_logprob < -1.45 or compression_ratio > 2.4:
                continue
            if start >= wav_duration - 0.05:
                continue

            end = min(end, wav_duration + 0.25)
            seg_dur = end - start
            if not text or seg_dur < 0.10:
                continue

            norm = text.lower()
            if text_counts.get(norm, 0) >= 2 and norm == prev_norm:
                continue
            if text_counts.get(norm, 0) >= 3:
                continue

            if is_hallucination_text(text, seg_dur, no_speech_prob):
                continue

            prev_norm = norm
            cues.append({
                "start": round(time_offset + start, 3),
                "end": round(time_offset + end, 3),
                "text": text
            })

        merged = merge_short_segments(cues)
        if merged:
            self._last_prompt = " ".join(c["text"] for c in merged)[-200:]
        return merged
