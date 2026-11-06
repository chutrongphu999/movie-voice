"""Movie Voice Dubbing Pipeline: Orchestrates ASR -> Batch Translation -> TTS."""
import os
import time
import asyncio
from typing import List, Dict, Any
from providers.asr_groq import GroqASR
from providers.translate_gemini import Translator
from providers.tts_edge import EdgeTTS


class DubbingPipeline:
    def __init__(self):
        self.asr = GroqASR()
        self.translator = Translator()
        self.tts = EdgeTTS()
        # Session state: track processed cue times to avoid duplicate lines
        self.spoken_cues: List[Dict[str, Any]] = []

    def reload_config(self):
        """Reloads keys and settings from environment."""
        self.asr.update_key(os.getenv("GROQ_API_KEY", ""))
        self.translator.update_keys(
            gemini_key=os.getenv("GEMINI_API_KEY", ""),
            groq_key=os.getenv("GROQ_API_KEY", "")
        )

    def is_duplicate(self, text: str, start: float, threshold_sec: float = 3.0) -> bool:
        """Avoids re-speaking duplicate lines within a small time window."""
        norm = text.lower().strip()
        if not norm:
            return True
        for item in self.spoken_cues[-60:]:
            orig_match = item.get("original", "").lower().strip() == norm
            text_match = item.get("text", "").lower().strip() == norm
            if (orig_match or text_match) and abs(item["start"] - start) < threshold_sec:
                return True
        return False

    async def _synthesize_batch(
        self,
        cues_and_texts: List[tuple],
        voice: str,
        rate: int,
        pitch: int
    ) -> List[Dict[str, Any]]:
        async def _synth_one(cue: Dict[str, Any], vi_text: str):
            try:
                _, duration, audio_id = await self.tts.synthesize(
                    text=vi_text,
                    voice=voice,
                    rate=rate,
                    pitch=pitch
                )
                if not audio_id:
                    return None
                start = float(cue.get("start", 0.0))
                end = float(cue.get("end", start + max(1.5, duration)))
                return {
                    "id": audio_id,
                    "start": round(start, 2),
                    "end": round(end, 2),
                    "original": cue.get("text", ""),
                    "text": vi_text,
                    "duration": duration,
                    "audio_url": f"/api/dub/voice/{audio_id}"
                }
            except Exception as e:
                print(f"[Pipeline] TTS synthesis error for '{vi_text}': {e}")
                return None

        results = await asyncio.gather(
            *(_synth_one(c, t) for c, t in cues_and_texts)
        )
        valid = [r for r in results if r is not None]
        self.spoken_cues.extend(valid)
        if len(self.spoken_cues) > 200:
            self.spoken_cues = self.spoken_cues[-120:]
        return valid

    async def process_audio_buffer(
        self,
        audio_bytes: bytes,
        time_offset: float,
        voice: str = "vi-VN-HoaiMyNeural",
        rate: int = 0,
        pitch: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Receives an audio chunk captured by MSE hook,
        runs ASR to extract dialogue with timestamps, translates to Vietnamese,
        and synthesizes speech in parallel.
        """
        if not audio_bytes or len(audio_bytes) < 1000:
            return []

        t0 = time.monotonic()
        # 1. Speech-to-Text via Groq Whisper
        raw_cues = await self.asr.transcribe(audio_bytes, time_offset=time_offset)
        if not raw_cues:
            return []
        t_asr = time.monotonic() - t0

        # Filter out cues already processed and cap batch size so responses return quickly
        new_cues = [c for c in raw_cues if not self.is_duplicate(c["text"], c["start"])][:10]
        if not new_cues:
            return []

        # 2. Batch Translation
        t1 = time.monotonic()
        texts = [c["text"] for c in new_cues]
        translated_texts = await self.translator.translate_batch(texts)
        t_tr = time.monotonic() - t1

        # 3. Parallel Speech Synthesis via Edge TTS
        t2 = time.monotonic()
        synthesized_cues = await self._synthesize_batch(
            list(zip(new_cues, translated_texts)),
            voice=voice,
            rate=rate,
            pitch=pitch
        )
        t_tts = time.monotonic() - t2

        if synthesized_cues:
            first_t = synthesized_cues[0]["start"]
            last_t = synthesized_cues[-1]["end"]
            sample = synthesized_cues[0]["text"][:50]
            print(
                f"[Pipeline] +{len(synthesized_cues)} câu ({first_t:.1f}s..{last_t:.1f}s) "
                f"| ASR {t_asr:.2f}s, Dịch {t_tr:.2f}s, TTS {t_tts:.2f}s | \"{sample}\""
            )

        return synthesized_cues

    async def process_subtitles(
        self,
        cues: List[Dict[str, Any]],
        voice: str = "vi-VN-HoaiMyNeural",
        rate: int = 0,
        pitch: int = 0,
        is_vietnamese: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Processes soft subtitles detected in player (DOM or VTT/SRT).
        If already Vietnamese, skips translation directly to TTS.
        """
        if not cues:
            return []

        new_cues = [c for c in cues if not self.is_duplicate(c.get("text", ""), float(c.get("start", 0)))][:12]
        if not new_cues:
            return []

        texts = [c.get("text", "").strip() for c in new_cues]

        if is_vietnamese:
            translated_texts = texts
        else:
            translated_texts = await self.translator.translate_batch(texts)

        return await self._synthesize_batch(
            list(zip(new_cues, translated_texts)),
            voice=voice,
            rate=rate,
            pitch=pitch
        )
