"""Movie Voice Dubbing Pipeline: Orchestrates ASR -> Story-Bible Slot-Fitted Translation -> Silence-Trimmed Neural TTS.
Directly incorporates the architecture from _refs/real-time-video-subs (rtsubs) and _refs/LocalDub.
"""
import os
import time
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional
from providers.asr_groq import GroqASR
from providers.translate_gemini import Translator
from providers.tts_edge import EdgeTTS, CACHE_DIR, MEMORY_CACHE, clean_text_for_speech


def compute_non_overlapping_slots(cues: List[Dict[str, Any]]) -> List[float]:
    """
    Computes the exact available speaking window (slot in seconds) for each cue
    so a sentence never overflows into the next sentence (from rtsubs/pipeline.py).
    """
    slots: List[float] = []
    n = len(cues)
    for i, c in enumerate(cues):
        start = float(c.get("start", 0.0))
        end = float(c.get("end", start + 2.0))
        if i + 1 < n:
            next_start = float(cues[i + 1].get("start", end + 0.5))
            effective_end = min(end + 0.35, next_start - 0.04)
        else:
            effective_end = end + 0.45
        c["slot_end"] = round(max(start + 0.65, effective_end), 2)
        slots.append(round(max(0.8, c["slot_end"] - start), 2))
    return slots


class DubbingPipeline:
    def __init__(self):
        self.asr = GroqASR()
        self.translator = Translator()
        self.tts = EdgeTTS()
        # Session state: track processed cue times to avoid duplicate lines & keep rolling dialogue context
        self.spoken_cues: List[Dict[str, Any]] = []
        # In-flight background TTS tasks: audio_id -> asyncio.Task
        self.tts_tasks: Dict[str, asyncio.Task] = {}

    def reload_config(self):
        """Reloads keys and settings from environment."""
        self.asr.update_key(os.getenv("GROQ_API_KEY", ""))
        self.translator.update_keys(
            gemini_key=os.getenv("GEMINI_API_KEY", ""),
            groq_key=os.getenv("GROQ_API_KEY", "")
        )

    def is_duplicate(self, text: str, start: float, threshold_sec: float = 3.2) -> bool:
        """Avoids re-speaking duplicate lines within a time window."""
        norm = text.lower().strip()
        if not norm:
            return True
        for item in self.spoken_cues[-60:]:
            orig_match = item.get("original", "").lower().strip() == norm
            text_match = item.get("text", "").lower().strip() == norm
            if (orig_match or text_match) and abs(item["start"] - start) < threshold_sec:
                return True
        return False

    def _get_recent_pairs(self) -> List[Dict[str, str]]:
        """Returns up to 8 most recent (src, vi) dialogue pairs for Story Bible context continuity."""
        recent = self.spoken_cues[-8:]
        return [
            {"src": str(c.get("original", "")), "vi": str(c.get("text", ""))}
            for c in recent
            if c.get("original") and c.get("text")
        ]

    async def get_or_wait_audio(self, audio_id: str) -> Optional[Path]:
        """
        Awaits an in-flight background TTS task if still running, then returns the cached MP3 file path.
        """
        file_path = CACHE_DIR / f"{audio_id}.mp3"
        if file_path.exists() and file_path.stat().st_size > 200:
            return file_path

        task = self.tts_tasks.get(audio_id)
        if task:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=8.0)
            except Exception as e:
                print(f"[Pipeline] Background TTS task error for {audio_id[:12]}: {e}")

        if file_path.exists() and file_path.stat().st_size > 200:
            return file_path
        return None

    async def _schedule_tts_batch(
        self,
        cues_and_texts: List[tuple],
        voice: str,
        rate: int,
        pitch: int
    ) -> List[Dict[str, Any]]:
        """
        Starts TTS synthesis for all cues in parallel background tasks, awaits ONLY the first cue
        so the response returns immediately while remaining cues finish in the background.
        """
        out_cues = []
        first_task = None

        for cue, vi_text in cues_and_texts:
            clean_vi = clean_text_for_speech(vi_text)
            if not clean_vi or len(clean_vi) < 2:
                continue

            voice_name = voice or self.tts.default_voice
            audio_id = self.tts._get_cache_key(clean_vi, voice_name, rate, pitch)

            # Initial estimate (~16.5 chars/sec after silence trim) until exact CBR 64k MP3 is measured
            est_dur = round(max(0.7, len(clean_vi) / 16.5), 2)
            if audio_id in MEMORY_CACHE:
                est_dur = MEMORY_CACHE[audio_id][1]

            start = float(cue.get("start", 0.0))
            end = float(cue.get("end", start + est_dur))
            slot_end = float(cue.get("slot_end", end + 0.35))

            if audio_id not in self.tts_tasks and not (CACHE_DIR / f"{audio_id}.mp3").exists():
                task = asyncio.create_task(
                    self.tts.synthesize(text=clean_vi, voice=voice_name, rate=rate, pitch=pitch)
                )
                self.tts_tasks[audio_id] = task
                task.add_done_callback(lambda _t, aid=audio_id: self.tts_tasks.pop(aid, None))
                if first_task is None:
                    first_task = task

            out_cues.append({
                "id": audio_id,
                "start": round(start, 2),
                "end": round(end, 2),
                "slot_end": round(slot_end, 2),
                "original": cue.get("text", ""),
                "text": clean_vi,
                "duration": est_dur,
                "audio_url": f"/api/dub/voice/{audio_id}"
            })

        # Wait only for the 1st cue's audio so it is immediately ready when the browser receives the response
        if first_task is not None:
            try:
                _, actual_dur, _ = await first_task
                if out_cues and actual_dur > 0:
                    out_cues[0]["duration"] = actual_dur
            except Exception as e:
                print(f"[Pipeline] First cue TTS error: {e}")

        self.spoken_cues.extend(out_cues)
        if len(self.spoken_cues) > 200:
            self.spoken_cues = self.spoken_cues[-120:]
        return out_cues

    async def process_audio_buffer(
        self,
        audio_bytes: bytes,
        time_offset: float,
        voice: str = "vi-VN-HoaiMyNeural",
        rate: int = 0,
        pitch: int = 0,
        movie_title: str = ""
    ) -> List[Dict[str, Any]]:
        """
        Receives an audio chunk captured by MSE/HLS hook,
        runs ASR with Story Bible glossary hint, translates with slot-based max_chars budget,
        and schedules parallel silence-trimmed TTS.
        """
        if not audio_bytes or len(audio_bytes) < 1000:
            return []

        if movie_title:
            self.translator.set_movie_title(movie_title)

        t0 = time.monotonic()
        glossary_hint = self.translator.get_whisper_glossary_hint()
        raw_cues = await self.asr.transcribe(
            audio_bytes,
            time_offset=time_offset,
            glossary_hint=glossary_hint
        )
        if not raw_cues:
            return []
        t_asr = time.monotonic() - t0

        new_cues = [c for c in raw_cues if not self.is_duplicate(c["text"], c["start"])][:10]
        if not new_cues:
            return []

        # Feed transcribed cues into Story Bible builder (runs asynchronously in background)
        self.translator.record_source_cues(new_cues)

        slots = compute_non_overlapping_slots(new_cues)

        t1 = time.monotonic()
        texts = [c["text"] for c in new_cues]
        translated_texts = await self.translator.translate_batch(
            texts,
            slots=slots,
            previous_pairs=self._get_recent_pairs()
        )
        t_tr = time.monotonic() - t1

        t2 = time.monotonic()
        synthesized_cues = await self._schedule_tts_batch(
            list(zip(new_cues, translated_texts)),
            voice=voice,
            rate=rate,
            pitch=pitch
        )
        t_tts = time.monotonic() - t2

        if synthesized_cues:
            first_t = synthesized_cues[0]["start"]
            last_t = synthesized_cues[-1]["end"]
            sample = synthesized_cues[0]["text"][:55]
            print(
                f"[Pipeline] +{len(synthesized_cues)} câu ({first_t:.1f}s..{last_t:.1f}s) "
                f"| ASR {t_asr:.2f}s, Dịch {t_tr:.2f}s, TTS-1st {t_tts:.2f}s | \"{sample}\""
            )

        return synthesized_cues

    async def process_subtitles(
        self,
        cues: List[Dict[str, Any]],
        voice: str = "vi-VN-HoaiMyNeural",
        rate: int = 0,
        pitch: int = 0,
        is_vietnamese: bool = True,
        movie_title: str = ""
    ) -> List[Dict[str, Any]]:
        """
        Processes soft subtitles detected in player (DOM or VTT/SRT).
        If already Vietnamese, skips translation directly to TTS.
        """
        if not cues:
            return []

        if movie_title:
            self.translator.set_movie_title(movie_title)

        new_cues = [c for c in cues if not self.is_duplicate(c.get("text", ""), float(c.get("start", 0)))][:12]
        if not new_cues:
            return []

        slots = compute_non_overlapping_slots(new_cues)
        texts = [c.get("text", "").strip() for c in new_cues]

        if is_vietnamese:
            translated_texts = texts
        else:
            self.translator.record_source_cues(new_cues)
            translated_texts = await self.translator.translate_batch(
                texts,
                slots=slots,
                previous_pairs=self._get_recent_pairs()
            )

        return await self._schedule_tts_batch(
            list(zip(new_cues, translated_texts)),
            voice=voice,
            rate=rate,
            pitch=pitch
        )
