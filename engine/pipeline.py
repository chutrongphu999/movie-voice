"""Movie Voice Dubbing Pipeline: Orchestrates ASR -> Context-Aware Batch Translation -> Non-Blocking Neural TTS."""
import os
import time
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional
from providers.asr_groq import GroqASR
from providers.translate_gemini import Translator
from providers.tts_edge import EdgeTTS, CACHE_DIR, clean_text_for_speech


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

    def is_duplicate(self, text: str, start: float, threshold_sec: float = 3.5) -> bool:
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

    def _get_recent_context(self) -> str:
        """Returns up to 6 most recent translated dialogue lines for pronoun & plot consistency."""
        recent = self.spoken_cues[-6:]
        if not recent:
            return ""
        return "\n".join(f"- {c.get('original', '')} => {c.get('text', '')}" for c in recent)

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
        so the response returns ~3s faster while remaining cues finish in the background!
        """
        out_cues = []
        first_task = None

        for idx, (cue, vi_text) in enumerate(cues_and_texts):
            clean_vi = clean_text_for_speech(vi_text)
            if not clean_vi or len(clean_vi) < 2:
                continue

            voice_name = voice or self.tts.default_voice
            audio_id = self.tts._get_cache_key(clean_vi, voice_name, rate, pitch)

            # Estimate speech duration (~14 chars/sec in Vietnamese) until actual MP3 is fetched
            est_dur = round(max(1.2, len(clean_vi) / 14.0), 2)
            start = float(cue.get("start", 0.0))
            end = float(cue.get("end", start + est_dur))

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
        pitch: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Receives an audio chunk captured by MSE hook,
        runs ASR to extract dialogue with timestamps, translates to Vietnamese with context,
        and schedules parallel TTS.
        """
        if not audio_bytes or len(audio_bytes) < 1000:
            return []

        t0 = time.monotonic()
        raw_cues = await self.asr.transcribe(audio_bytes, time_offset=time_offset)
        if not raw_cues:
            return []
        t_asr = time.monotonic() - t0

        new_cues = [c for c in raw_cues if not self.is_duplicate(c["text"], c["start"])][:8]
        if not new_cues:
            return []

        t1 = time.monotonic()
        texts = [c["text"] for c in new_cues]
        context_hint = self._get_recent_context()
        translated_texts = await self.translator.translate_batch(texts, context_hint=context_hint)
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
            translated_texts = await self.translator.translate_batch(texts, context_hint=self._get_recent_context())

        return await self._schedule_tts_batch(
            list(zip(new_cues, translated_texts)),
            voice=voice,
            rate=rate,
            pitch=pitch
        )
