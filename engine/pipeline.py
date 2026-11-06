"""Movie Voice Dubbing Pipeline: Orchestrates ASR -> Batch Translation -> TTS."""
import os
import asyncio
from typing import List, Dict, Any, Optional
from providers.asr_groq import GroqASR
from providers.translate_gemini import Translator
from providers.tts_edge import EdgeTTS, CACHE_DIR


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

    def is_duplicate(self, text: str, start: float, threshold_sec: float = 2.0) -> bool:
        """Avoids re-speaking duplicate lines within a small time window."""
        norm = text.lower().strip()
        for item in self.spoken_cues[-30:]:
            if item["text"].lower().strip() == norm and abs(item["start"] - start) < threshold_sec:
                return True
        return False

    async def process_audio_buffer(
        self,
        audio_bytes: bytes,
        time_offset: float,
        voice: str = "vi-VN-HoaiMyNeural",
        rate: int = 0,
        pitch: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Receives an audio chunk captured by MSE hook (10-30s of movie audio),
        runs ASR to extract dialogue with timestamps, translates to Vietnamese,
        and synthesizes speech.
        """
        if not audio_bytes or len(audio_bytes) < 1000:
            return []

        # 1. Speech-to-Text via Groq Whisper
        raw_cues = await self.asr.transcribe(audio_bytes, time_offset=time_offset)
        if not raw_cues:
            return []

        # Filter out cues already processed
        new_cues = [c for c in raw_cues if not self.is_duplicate(c["text"], c["start"])]
        if not new_cues:
            return []

        # 2. Batch Translation
        texts = [c["text"] for c in new_cues]
        translated_texts = await self.translator.translate_batch(texts)

        # 3. Speech Synthesis via Edge TTS
        synthesized_cues = []
        for cue, vi_text in zip(new_cues, translated_texts):
            try:
                audio_bytes, duration, audio_id = await self.tts.synthesize(
                    text=vi_text,
                    voice=voice,
                    rate=rate,
                    pitch=pitch
                )
                if not audio_id:
                    continue

                item = {
                    "id": audio_id,
                    "start": cue["start"],
                    "end": cue["end"],
                    "original": cue["text"],
                    "text": vi_text,
                    "duration": duration,
                    "audio_url": f"/api/dub/voice/{audio_id}"
                }
                self.spoken_cues.append(item)
                synthesized_cues.append(item)
            except Exception as e:
                print(f"[Pipeline] TTS synthesis error for '{vi_text}': {e}")

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

        new_cues = [c for c in cues if not self.is_duplicate(c.get("text", ""), float(c.get("start", 0)))]
        if not new_cues:
            return []

        texts = [c.get("text", "").strip() for c in new_cues]

        # Translate if not already Vietnamese
        if is_vietnamese:
            translated_texts = texts
        else:
            translated_texts = await self.translator.translate_batch(texts)

        synthesized_cues = []
        for cue, vi_text in zip(new_cues, translated_texts):
            try:
                audio_bytes, duration, audio_id = await self.tts.synthesize(
                    text=vi_text,
                    voice=voice,
                    rate=rate,
                    pitch=pitch
                )
                if not audio_id:
                    continue

                start = float(cue.get("start", 0))
                end = float(cue.get("end", start + 2.5))
                item = {
                    "id": audio_id,
                    "start": start,
                    "end": end,
                    "original": cue.get("text", ""),
                    "text": vi_text,
                    "duration": duration,
                    "audio_url": f"/api/dub/voice/{audio_id}"
                }
                self.spoken_cues.append(item)
                synthesized_cues.append(item)
            except Exception as e:
                print(f"[Pipeline] Subtitle TTS error: {e}")

        return synthesized_cues
