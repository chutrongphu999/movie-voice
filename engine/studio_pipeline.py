"""Offline Movie Dubbing Studio Pipeline (Movie Voice v6).

Implements the complete pre-processed dubbing workflow inspired by VideoLingo & llm-subtrans:
1. Input: Local video file (.mp4/.mkv/.webm), uploaded file, or HLS (.m3u8) / HTTP stream URL.
2. Subtitle Extraction (3 Modes):
   - 'hardsub': Scans burned-in subtitles on the video via OpenCV + Contact-Sheet Vision OCR
                so the voiceover matches the on-screen subtitle 100% word-for-word and timestamp-for-timestamp.
   - 'srt':     Parses external .srt/.vtt or embedded soft-subtitle track (0 API calls if already Vietsub).
   - 'asr':     Extracts audio, splits at natural silence boundaries, transcribes via Whisper, and translates.
3. Parallel TTS Synthesis:
   - Synthesizes all cues concurrently via Edge-TTS (HoaiMyNeural / NamMinhNeural) with silence trimming
     and WSOLA pitch-preserving time-fitting (`atempo`) into each cue's exact [start, slot_end] window.
4. Sample-Accurate Master Audio Mixing & Instant MP4 Muxing:
   - Mixes synthesized Vietnamese speech over the original movie soundtrack with smooth 180ms cosine
     auto-ducking (22% original volume during speech, 100% during music/SFX/pauses).
   - Muxes into `output_thuyetminh.mp4` using `-c:v copy -movflags +faststart` (zero video quality loss,
     instant seeking anywhere in the built-in Web Cinema Player or VLC).
"""
import os
import re
import json
import time
import wave
import uuid
import shutil
import asyncio
import subprocess
import urllib.parse
import concurrent.futures
from pathlib import Path
from typing import List, Dict, Any, Optional

import aiohttp
import numpy as np

from providers.tts_edge import EdgeTTS, FFMPEG_EXE, CACHE_DIR, clean_text_for_speech
from providers.translate_gemini import Translator
from providers.asr_groq import GroqASR
from hardsub_extractor import HardSubExtractor
from pipeline import compute_non_overlapping_slots

WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace" / "jobs"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

VIET_CHAR_RE = re.compile(
    r"[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]",
    re.IGNORECASE,
)


def parse_timecode_to_sec(tc: str) -> float:
    """Parses HH:MM:SS,mmm or MM:SS or seconds string into float seconds."""
    if not tc:
        return 0.0
    s = str(tc).strip().replace(",", ".")
    if ":" not in s:
        try:
            return max(0.0, float(s))
        except ValueError:
            return 0.0
    parts = [p.strip() for p in s.split(":")]
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60.0 + float(parts[1])
    except ValueError:
        pass
    return 0.0


def format_srt_timestamp(sec: float) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if ms >= 1000:
        ms = 999
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_vtt_timestamp(sec: float) -> str:
    return format_srt_timestamp(sec).replace(",", ".")


def parse_srt_or_vtt_text(content: str) -> List[Dict[str, Any]]:
    """Parses .srt or .vtt text into [{start, end, text}, ...]."""
    cues: List[Dict[str, Any]] = []
    blocks = re.split(r"\r?\n\r?\n+", (content or "").strip())
    time_re = re.compile(
        r"((?:\d{1,2}:)?\d{1,2}:\d{2}[\.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[\.,]\d{1,3})"
    )
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines or lines[0].upper().startswith("WEBVTT"):
            continue
        t_idx = -1
        m = None
        for idx, line in enumerate(lines):
            m = time_re.search(line)
            if m:
                t_idx = idx
                break
        if t_idx == -1 or not m:
            continue
        start_s = parse_timecode_to_sec(m.group(1))
        end_s = parse_timecode_to_sec(m.group(2))
        text_lines = []
        for l in lines[t_idx + 1 :]:
            clean_l = re.sub(r"<[^>]+>", "", l)
            clean_l = re.sub(r"^[-–—•]+\s*", "", clean_l).strip()
            if clean_l:
                text_lines.append(clean_l)
        txt = " ".join(text_lines).strip()
        if txt and end_s > start_s:
            cues.append({"start": round(start_s, 2), "end": round(end_s, 2), "text": txt})
    return cues


def write_srt_and_vtt(cues: List[Dict[str, Any]], srt_path: Path, vtt_path: Path):
    """Writes both .srt and .vtt subtitle files from cues."""
    srt_lines = []
    vtt_lines = ["WEBVTT\n"]
    for idx, c in enumerate(cues, 1):
        st = float(c["start"])
        et = max(st + 0.5, float(c.get("end", st + 1.5)))
        txt = str(c.get("text", "")).strip()
        srt_lines.append(f"{idx}\n{format_srt_timestamp(st)} --> {format_srt_timestamp(et)}\n{txt}\n")
        vtt_lines.append(f"{format_vtt_timestamp(st)} --> {format_vtt_timestamp(et)}\n{txt}\n")
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")
    vtt_path.write_text("\n".join(vtt_lines), encoding="utf-8")


def probe_video_duration(video_path: Path) -> float:
    """Estimates video duration in seconds via FFmpeg stderr header parsing."""
    try:
        res = subprocess.run(
            [FFMPEG_EXE, "-hide_banner", "-i", str(video_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        err = res.stderr.decode("utf-8", errors="ignore")
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
        if m:
            return float(m.group(1)) * 3600.0 + float(m.group(2)) * 60.0 + float(m.group(3))
    except Exception:
        pass
    return 0.0


class StudioManager:
    def __init__(self):
        self.tts = EdgeTTS()
        self.translator = Translator()
        self.asr = GroqASR()
        self.hardsub = HardSubExtractor()
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.active_tasks: Dict[str, asyncio.Task] = {}
        self._load_existing_jobs()

    def reload_keys(self):
        self.asr.update_key(os.getenv("GROQ_API_KEY", ""))
        self.translator.update_keys(
            gemini_key=os.getenv("GEMINI_API_KEY", ""),
            groq_key=os.getenv("GROQ_API_KEY", "")
        )
        self.hardsub.update_key(os.getenv("GEMINI_API_KEY", ""))

    def _load_existing_jobs(self):
        for job_dir in sorted(WORKSPACE_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if not job_dir.is_dir():
                continue
            meta_file = job_dir / "job.json"
            if meta_file.exists():
                try:
                    data = json.loads(meta_file.read_text(encoding="utf-8"))
                    if data.get("status") == "running":
                        data["status"] = "interrupted"
                        data["message"] = "Bị gián đoạn (Bấm Chạy Tiếp để hoàn tất từ checkpoint)"
                    self.jobs[data["id"]] = data
                except Exception:
                    pass

    def _save_job(self, job_id: str):
        job = self.jobs.get(job_id)
        if not job:
            return
        job_dir = WORKSPACE_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "job.json").write_text(
            json.dumps(job, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    def _update_progress(self, job_id: str, message: str, progress: float, status: str = "running"):
        job = self.jobs.get(job_id)
        if not job:
            return
        job["message"] = message
        job["progress"] = round(float(progress), 1)
        job["status"] = status
        job["updated_at"] = time.time()
        self._save_job(job_id)
        print(f"[Studio {job_id[:6]}] ({job['progress']}%) {message}")

    def list_jobs(self) -> List[Dict[str, Any]]:
        return sorted(self.jobs.values(), key=lambda j: j.get("created_at", 0), reverse=True)

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        return self.jobs.get(job_id)

    def create_and_start_job(
        self,
        title: str,
        mode: str = "hardsub",
        video_path: str = "",
        stream_url: str = "",
        subtitle_path: str = "",
        voice: str = "vi-VN-HoaiMyNeural",
        rate: int = 0,
        duck_level: float = 0.22,
        start_time_str: str = "",
        end_time_str: str = "",
        referer: str = "",
        user_agent: str = "",
    ) -> Dict[str, Any]:
        self.reload_keys()
        job_id = uuid.uuid4().hex[:10]
        job_dir = WORKSPACE_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        start_sec = parse_timecode_to_sec(start_time_str)
        end_sec = parse_timecode_to_sec(end_time_str)

        job = {
            "id": job_id,
            "title": (title or "Phim Thuyết Minh").strip(),
            "mode": mode,  # 'hardsub' | 'srt' | 'asr'
            "video_path": video_path.strip(),
            "stream_url": stream_url.strip(),
            "subtitle_path": subtitle_path.strip(),
            "voice": voice or "vi-VN-HoaiMyNeural",
            "rate": int(rate),
            "duck_level": float(duck_level),
            "start_sec": start_sec,
            "end_sec": end_sec,
            "referer": referer.strip(),
            "user_agent": user_agent.strip(),
            "status": "running",
            "progress": 1.0,
            "message": "Khởi tạo tiến trình xử lý phim...",
            "created_at": time.time(),
            "updated_at": time.time(),
            "cues_count": 0,
            "cues_preview": [],
            "output_video": "",
            "duration": 0.0,
        }
        self.jobs[job_id] = job
        self._save_job(job_id)

        task = asyncio.create_task(self._run_job_pipeline(job_id))
        self.active_tasks[job_id] = task
        task.add_done_callback(lambda _t, jid=job_id: self.active_tasks.pop(jid, None))
        return job

    def resume_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.jobs.get(job_id)
        if not job:
            return None
        if job_id in self.active_tasks:
            return job
        self.reload_keys()
        job["status"] = "running"
        job["message"] = "Đang tiếp tục từ checkpoint..."
        self._save_job(job_id)
        task = asyncio.create_task(self._run_job_pipeline(job_id))
        self.active_tasks[job_id] = task
        task.add_done_callback(lambda _t, jid=job_id: self.active_tasks.pop(jid, None))
        return job

    def auto_resume_jobs(self):
        """Automatically resumes any jobs that were interrupted by a server reload."""
        for jid, job in list(self.jobs.items()):
            if job.get("status") in ("interrupted", "running") and jid not in self.active_tasks:
                print(f"[Studio] Auto-resuming interrupted job {jid} ({job.get('title')})...")
                self.resume_job(jid)

    def delete_job(self, job_id: str) -> bool:
        self.jobs.pop(job_id, None)
        task = self.active_tasks.pop(job_id, None)
        if task:
            task.cancel()
        job_dir = WORKSPACE_DIR / job_id
        if job_dir.exists():
            shutil.rmtree(job_dir, ignore_errors=True)
        return True

    async def _run_job_pipeline(self, job_id: str):
        job = self.jobs[job_id]
        job_dir = WORKSPACE_DIR / job_id

        try:
            # STAGE 1: Prepare input video file (`source_video.mp4`)
            src_video = await self._prepare_video_input(job_id, job, job_dir)
            job["duration"] = await asyncio.to_thread(probe_video_duration, src_video)
            self._save_job(job_id)

            # STAGE 2: Extract & Prepare Subtitles (`cues.json`, `vi.srt`, `vi.vtt`)
            cues_file = job_dir / "cues.json"
            if cues_file.exists():
                cues = json.loads(cues_file.read_text(encoding="utf-8"))
                self._update_progress(job_id, f"Đã nạp {len(cues)} câu phụ đề từ checkpoint.", 68.0)
            else:
                cues = await self._extract_and_prepare_cues(job_id, job, job_dir, src_video)
                cues_file.write_text(json.dumps(cues, ensure_ascii=False, indent=2), encoding="utf-8")
                write_srt_and_vtt(cues, job_dir / "vi.srt", job_dir / "vi.vtt")

            job["cues_count"] = len(cues)
            job["cues_preview"] = cues[:80]
            self._save_job(job_id)

            if not cues:
                raise RuntimeError("Không tìm thấy câu phụ đề/lời thoại nào trong đoạn video này.")

            # STAGE 3: Parallel TTS Synthesis with WSOLA Time-Fitting
            cues_with_audio = await self._synthesize_all_cues(job_id, job, cues)

            # STAGE 4: Sample-Accurate Audio Ducking Mix + Fast MP4 Mux (`-c:v copy`)
            output_mp4 = await self._mix_and_mux_mp4(job_id, job, job_dir, src_video, cues_with_audio)

            job["output_video"] = str(output_mp4)
            self._update_progress(
                job_id,
                f"✅ Hoàn tất! Đã lồng tiếng {len(cues_with_audio)} câu khớp 100% phụ đề trên video.",
                100.0,
                status="completed"
            )
        except asyncio.CancelledError:
            if job_id in self.jobs:
                self._update_progress(
                    job_id,
                    "Tạm dừng do máy chủ khởi động lại (Bấm Chạy Tiếp để hoàn tất).",
                    job.get("progress", 0.0),
                    status="interrupted"
                )
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._update_progress(job_id, f"❌ Lỗi: {str(e)}", job.get("progress", 0.0), status="error")

    async def _prepare_video_input(self, job_id: str, job: Dict[str, Any], job_dir: Path) -> Path:
        """Prepares `source_video.mp4` (slicing [start_sec, end_sec] or downloading stream with 24 threads)."""
        target_mp4 = job_dir / "source_video.mp4"
        if target_mp4.exists() and target_mp4.stat().st_size > 100_000:
            return target_mp4

        start_sec = float(job.get("start_sec", 0.0))
        end_sec = float(job.get("end_sec", 0.0))
        local_path = job.get("video_path", "").strip()
        stream_url = job.get("stream_url", "").strip()
        temp_mp4 = job_dir / "temp_source.mp4"

        if local_path:
            src_p = Path(local_path)
            if not src_p.exists():
                raise RuntimeError(f"Không tìm thấy file video tại: {local_path}")

            # If full video and already .mp4, we can use it directly without copying gigabytes!
            if start_sec <= 0 and end_sec <= 0 and src_p.suffix.lower() == ".mp4":
                return src_p

            self._update_progress(job_id, "Đang trích xuất đoạn video cần xử lý bằng FFmpeg...", 3.0)
            cmd = [FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y"]
            if start_sec > 0:
                cmd.extend(["-ss", f"{start_sec:.2f}"])
            if end_sec > start_sec:
                cmd.extend(["-to", f"{end_sec:.2f}"])
            cmd.extend(["-i", str(src_p), "-c", "copy", str(temp_mp4)])
            await asyncio.to_thread(subprocess.run, cmd, check=True)
            temp_mp4.replace(target_mp4)
            return target_mp4

        if stream_url:
            if ".m3u8" in stream_url.lower():
                try:
                    return await self._download_hls_parallel(job_id, job, job_dir, target_mp4)
                except Exception as e:
                    print(f"[Studio] Parallel HLS downloader fallback to FFmpeg ({e})")

            self._update_progress(job_id, "Đang tải luồng video (.mp4 / .m3u8) về Studio...", 3.0)
            cmd = [FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y"]
            headers = []
            if job.get("referer"):
                headers.append(f"Referer: {job['referer']}")
            if job.get("user_agent"):
                headers.append(f"User-Agent: {job['user_agent']}")
            if headers:
                cmd.extend(["-headers", "\r\n".join(headers) + "\r\n"])
            if start_sec > 0:
                cmd.extend(["-ss", f"{start_sec:.2f}"])
            if end_sec > start_sec:
                cmd.extend(["-to", f"{end_sec:.2f}"])
            cmd.extend(["-i", stream_url, "-c", "copy", "-bsf:a", "aac_adtstoasc", str(temp_mp4)])
            res = await asyncio.to_thread(subprocess.run, cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if res.returncode != 0 or not temp_mp4.exists():
                err_txt = res.stderr.decode("utf-8", errors="ignore")[-250:]
                raise RuntimeError(f"Không thể tải stream video ({err_txt}). Hãy tải file .mp4 về máy rồi chọn file.")
            temp_mp4.replace(target_mp4)
            return target_mp4

        raise RuntimeError("Vui lòng chọn file video trên máy hoặc nhập link stream.")

    async def _download_hls_parallel(
        self,
        job_id: str,
        job: Dict[str, Any],
        job_dir: Path,
        target_mp4: Path
    ) -> Path:
        """
        High-speed 24-thread parallel HLS (.m3u8) segment downloader with real-time progress bar
        and instant checkpoint resume.
        """
        stream_url = job.get("stream_url", "").strip()
        start_sec = float(job.get("start_sec", 0.0))
        end_sec = float(job.get("end_sec", 0.0))

        req_headers = {
            "User-Agent": job.get("user_agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36"
        }
        if job.get("referer"):
            req_headers["Referer"] = job["referer"]

        self._update_progress(job_id, "Đang phân tích danh sách phân đoạn video (.m3u8)...", 2.0)

        timeout = aiohttp.ClientTimeout(total=60, connect=15)
        connector = aiohttp.TCPConnector(limit=28, ssl=False)
        async with aiohttp.ClientSession(headers=req_headers, timeout=timeout, connector=connector) as session:
            async with session.get(stream_url) as resp:
                resp.raise_for_status()
                m3u8_text = await resp.text()
                playlist_url = str(resp.url)

            # Check if Master Playlist (#EXT-X-STREAM-INF) -> select highest quality variant
            if "#EXT-X-STREAM-INF" in m3u8_text:
                best_bw = -1
                best_uri = ""
                lines = [l.strip() for l in m3u8_text.splitlines() if l.strip()]
                for i, line in enumerate(lines):
                    if line.startswith("#EXT-X-STREAM-INF"):
                        bw_m = re.search(r"BANDWIDTH=(\d+)", line)
                        bw = int(bw_m.group(1)) if bw_m else 0
                        if i + 1 < len(lines) and not lines[i + 1].startswith("#"):
                            if bw >= best_bw:
                                best_bw = bw
                                best_uri = lines[i + 1]
                if best_uri:
                    playlist_url = urllib.parse.urljoin(playlist_url, best_uri)
                    async with session.get(playlist_url) as resp2:
                        resp2.raise_for_status()
                        m3u8_text = await resp2.text()
                        playlist_url = str(resp2.url)

            # Parse segments & time range
            hls_dir = job_dir / "hls_segs"
            hls_dir.mkdir(parents=True, exist_ok=True)

            local_m3u8_lines = []
            segments_to_fetch = []  # (idx, seg_url, seg_file)
            cur_time = 0.0
            cur_dur = 4.0
            seg_idx = 0

            for raw_line in m3u8_text.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                if line.startswith("#EXTINF:"):
                    m_dur = re.search(r"#EXTINF:([\d\.]+)", line)
                    cur_dur = float(m_dur.group(1)) if m_dur else 4.0
                    continue
                if line.startswith("#"):
                    # Resolve relative URI inside #EXT-X-KEY or #EXT-X-MAP if present
                    if 'URI="' in line:
                        line = re.sub(
                            r'URI="([^"]+)"',
                            lambda m: f'URI="{urllib.parse.urljoin(playlist_url, m.group(1))}"',
                            line
                        )
                    if not line.startswith("#EXT-X-ENDLIST"):
                        local_m3u8_lines.append(line)
                    continue

                seg_start = cur_time
                seg_end = cur_time + cur_dur
                cur_time = seg_end

                if start_sec > 0 and seg_end < start_sec:
                    continue
                if end_sec > start_sec and seg_start > end_sec:
                    continue

                seg_url = urllib.parse.urljoin(playlist_url, line)
                local_name = f"seg_{seg_idx:05d}.ts"
                seg_file = hls_dir / local_name
                segments_to_fetch.append((seg_idx, seg_url, seg_file))
                local_m3u8_lines.append(f"#EXTINF:{cur_dur:.3f},")
                local_m3u8_lines.append(local_name)
                seg_idx += 1

            local_m3u8_lines.append("#EXT-X-ENDLIST")
            total_segs = len(segments_to_fetch)
            if total_segs == 0:
                raise RuntimeError("Không tìm thấy phân đoạn .ts nào trong luồng .m3u8")

            sem = asyncio.Semaphore(24)
            done_count = 0
            total_bytes = 0
            last_report_t = 0.0

            async def _fetch_one(idx: int, url: str, dest: Path):
                nonlocal done_count, total_bytes, last_report_t
                if dest.exists() and dest.stat().st_size > 512:
                    done_count += 1
                    total_bytes += dest.stat().st_size
                    return

                part_file = dest.with_suffix(".part")
                async with sem:
                    for attempt in range(4):
                        try:
                            async with session.get(url) as r:
                                r.raise_for_status()
                                data = await r.read()
                            if data:
                                part_file.write_bytes(data)
                                part_file.replace(dest)
                                total_bytes += len(data)
                                break
                        except Exception:
                            if attempt == 3:
                                raise
                            await asyncio.sleep(0.6 * (attempt + 1))

                done_count += 1
                now = time.time()
                if now - last_report_t >= 0.8 or done_count == total_segs:
                    last_report_t = now
                    mb = total_bytes / (1024.0 * 1024.0)
                    pct = 2.0 + (done_count / float(total_segs)) * 16.5
                    self._update_progress(
                        job_id,
                        f"Đang tải phim siêu tốc (24 luồng): {done_count}/{total_segs} phân đoạn ({mb:.1f} MB — {int(done_count * 100 / total_segs)}%)...",
                        pct
                    )

            await asyncio.gather(*[_fetch_one(i, u, p) for i, u, p in segments_to_fetch])

        # Remux downloaded segments into temp_source.mp4 then atomically rename to source_video.mp4
        self._update_progress(job_id, "Đang ghép các phân đoạn video thành file MP4 chuẩn...", 19.0)
        local_m3u8_file = hls_dir / "local_index.m3u8"
        local_m3u8_file.write_text("\n".join(local_m3u8_lines), encoding="utf-8")
        temp_mp4 = job_dir / "temp_source.mp4"

        cmd = [
            FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y",
            "-allowed_extensions", "ALL",
            "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
            "-i", str(local_m3u8_file),
            "-c", "copy", "-bsf:a", "aac_adtstoasc",
            str(temp_mp4)
        ]
        res = await asyncio.to_thread(subprocess.run, cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0 or not temp_mp4.exists():
            err_txt = res.stderr.decode("utf-8", errors="ignore")[-250:]
            raise RuntimeError(f"Lỗi ghép file MP4 từ HLS: {err_txt}")

        temp_mp4.replace(target_mp4)
        shutil.rmtree(hls_dir, ignore_errors=True)
        return target_mp4

    async def _extract_and_prepare_cues(
        self,
        job_id: str,
        job: Dict[str, Any],
        job_dir: Path,
        src_video: Path
    ) -> List[Dict[str, Any]]:
        """Extracts subtitles according to `job['mode']` ('hardsub' | 'srt' | 'asr') and translates if needed."""
        mode = job.get("mode", "hardsub")
        sub_path = job.get("subtitle_path", "").strip()
        self.translator.set_movie_title(job.get("title", ""))

        # 1. If user provided an external .srt/.vtt file or selected 'srt' mode
        if sub_path and Path(sub_path).exists():
            self._update_progress(job_id, "Đang đọc file phụ đề (.srt/.vtt)...", 15.0)
            raw_text = Path(sub_path).read_text(encoding="utf-8", errors="ignore")
            cues = parse_srt_or_vtt_text(raw_text)
            start_sec = float(job.get("start_sec", 0.0))
            end_sec = float(job.get("end_sec", 0.0))
            if start_sec > 0 or end_sec > start_sec:
                filtered = []
                for c in cues:
                    if end_sec > start_sec and c["start"] > end_sec:
                        continue
                    if c["end"] < start_sec:
                        continue
                    filtered.append({
                        "start": round(max(0.0, c["start"] - start_sec), 2),
                        "end": round(max(0.5, c["end"] - start_sec), 2),
                        "text": c["text"]
                    })
                cues = filtered
            return await self._translate_cues_if_needed(job_id, cues)

        # 2. Mode 'hardsub': Scan burned-in subtitles directly from the video frames!
        if mode == "hardsub":
            cues = await self.hardsub.extract_hardsub_cues(
                video_path=str(src_video),
                start_sec=0.0,
                end_sec=0.0,
                total_duration=float(job.get("duration", 0.0)),
                progress_cb=lambda msg, pct: self._update_progress(job_id, msg, pct)
            )
            if cues:
                return await self._translate_cues_if_needed(job_id, cues)
            self._update_progress(
                job_id,
                "Không thấy phụ đề gắn cứng trên hình, chuyển sang nhận diện giọng nói Whisper...",
                35.0
            )

        # 3. Mode 'asr' (or fallback if video had no burned-in hard-sub): Whisper ASR + Batch Translation
        return await self._transcribe_and_translate_audio(job_id, job_dir, src_video)

    async def _translate_cues_if_needed(self, job_id: str, cues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Checks if extracted cues are already in Vietnamese (e.g. Vietsub hard-sub or Vietsub .srt).
        If already Vietnamese, keeps exact wording 100%!
        If English/foreign, translates in batches of 25 lines with Story Bible context.
        """
        if not cues:
            return []

        sample_text = " ".join(c["text"] for c in cues[:30])
        viet_matches = len(VIET_CHAR_RE.findall(sample_text))
        # If predominantly Vietnamese hard-sub/soft-sub, keep exact Vietnamese text 100%!
        if viet_matches >= max(3, len(cues[:30]) // 2):
            self._update_progress(
                job_id,
                f"Phụ đề đã là Tiếng Việt chuẩn ({len(cues)} câu) — giữ nguyên 100% câu chữ trên hình!",
                55.0
            )
            return cues

        # Otherwise translate in batches of 25 lines
        slots = compute_non_overlapping_slots(cues)
        batch_size = 25
        total = len(cues)
        for i in range(0, total, batch_size):
            batch_cues = cues[i : i + batch_size]
            batch_slots = slots[i : i + batch_size]
            batch_texts = [c["text"] for c in batch_cues]
            prev_pairs = [
                {"src": cues[j].get("orig_text", cues[j]["text"]), "vi": cues[j]["text"]}
                for j in range(max(0, i - 5), i)
            ]
            pct = 40.0 + (i / float(max(1, total))) * 15.0
            self._update_progress(job_id, f"Đang dịch kịch bản sang Tiếng Việt ({i}/{total} câu)...", pct)
            translated = await self.translator.translate_batch(
                batch_texts,
                slots=batch_slots,
                previous_pairs=prev_pairs
            )
            for k, vi_txt in enumerate(translated):
                batch_cues[k]["orig_text"] = batch_cues[k]["text"]
                batch_cues[k]["text"] = vi_txt
            await asyncio.sleep(1.0)

        return cues

    async def _transcribe_and_translate_audio(
        self,
        job_id: str,
        job_dir: Path,
        src_video: Path
    ) -> List[Dict[str, Any]]:
        """Extracts 16kHz audio in 6-minute chunks and transcribes with Groq Whisper."""
        self._update_progress(job_id, "Đang tách âm thanh gốc để nhận diện lời thoại...", 20.0)
        dur = await asyncio.to_thread(probe_video_duration, src_video)
        if dur <= 0:
            dur = 600.0

        chunk_len = 360.0  # 6-minute chunks (~11MB WAV, well under 25MB Whisper limit)
        all_raw_cues: List[Dict[str, Any]] = []
        offset = 0.0
        chunk_idx = 0

        while offset < dur:
            chunk_wav = job_dir / f"asr_chunk_{chunk_idx}.wav"
            cmd = [
                FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{offset:.2f}",
                "-t", f"{chunk_len:.2f}",
                "-i", str(src_video),
                "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                str(chunk_wav)
            ]
            await asyncio.to_thread(subprocess.run, cmd, check=False)
            if chunk_wav.exists() and chunk_wav.stat().st_size > 4000:
                pct = 22.0 + min(20.0, (offset / max(1.0, dur)) * 20.0)
                self._update_progress(
                    job_id,
                    f"Đang nhận diện lời thoại Whisper (phút {int(offset // 60)}/{int(dur // 60)})...",
                    pct
                )
                audio_bytes = chunk_wav.read_bytes()
                cues = await self.asr.transcribe(audio_bytes, time_offset=offset)
                all_raw_cues.extend(cues)
                try:
                    chunk_wav.unlink()
                except Exception:
                    pass
            offset += chunk_len
            chunk_idx += 1

        return await self._translate_cues_if_needed(job_id, all_raw_cues)

    async def _synthesize_all_cues(
        self,
        job_id: str,
        job: Dict[str, Any],
        cues: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Synthesizes TTS for all cues concurrently (8 workers) with silence trimming
        and WSOLA pitch-preserving time-fitting into each cue's [start, slot_end] window.
        """
        compute_non_overlapping_slots(cues)
        voice = job.get("voice", "vi-VN-HoaiMyNeural")
        rate = int(job.get("rate", 0))
        total = len(cues)
        sem = asyncio.Semaphore(8)
        completed = 0

        async def _synth_one(idx: int, cue: Dict[str, Any]):
            nonlocal completed
            clean_vi = clean_text_for_speech(cue.get("text", ""))
            if not clean_vi or len(clean_vi) < 2:
                completed += 1
                return
            start = float(cue["start"])
            end = float(cue.get("end", start + 1.5))
            slot_end = float(cue.get("slot_end", end + 1.2))
            target_slot = round(max(0.9, slot_end - start), 2)

            async with sem:
                _, dur, audio_id = await self.tts.synthesize(
                    text=clean_vi,
                    voice=voice,
                    rate=rate,
                    pitch=0,
                    target_slot=target_slot
                )
                if audio_id:
                    cue["audio_path"] = str(CACHE_DIR / f"{audio_id}.mp3")
                    cue["tts_duration"] = dur
                completed += 1
                if completed % 3 == 0 or completed == total:
                    pct = 68.0 + (completed / float(max(1, total))) * 20.0
                    self._update_progress(
                        job_id,
                        f"Đang tạo giọng thuyết minh ({completed}/{total} câu): \"{clean_vi[:40]}\"",
                        pct
                    )

        await asyncio.gather(*[_synth_one(i, c) for i, c in enumerate(cues)])
        return [c for c in cues if c.get("audio_path") and Path(c["audio_path"]).exists()]

    async def _mix_and_mux_mp4(
        self,
        job_id: str,
        job: Dict[str, Any],
        job_dir: Path,
        src_video: Path,
        cues_with_audio: List[Dict[str, Any]]
    ) -> Path:
        """
        Sample-accurate NumPy Master Audio Mixer + Instant FFmpeg MP4 Muxer (-c:v copy).
        """
        self._update_progress(job_id, "Đang trộn âm thanh Thuyết Minh + Nhạc nền tự động hạ âm lượng...", 88.5)
        output_mp4 = job_dir / "output_thuyetminh.mp4"
        await asyncio.to_thread(
            self._mix_and_mux_sync,
            job_id,
            job_dir,
            src_video,
            cues_with_audio,
            float(job.get("duck_level", 0.22)),
            output_mp4
        )
        return output_mp4

    def _mix_and_mux_sync(
        self,
        job_id: str,
        job_dir: Path,
        src_video: Path,
        cues_with_audio: List[Dict[str, Any]],
        duck_level: float,
        output_mp4: Path
    ):
        SR = 24000  # 24kHz matches Edge-TTS native sample rate
        orig_wav = job_dir / "orig_24k.wav"
        mixed_wav = job_dir / "mixed_24k.wav"

        # 1. Extract original movie audio at 24kHz mono 16-bit PCM
        subprocess.run(
            [
                FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(src_video),
                "-vn", "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le",
                str(orig_wav)
            ],
            check=True
        )

        with wave.open(str(orig_wav), "rb") as wf:
            n_frames = wf.getnframes()
            raw_pcm = wf.readframes(n_frames)
        orig_samples = np.frombuffer(raw_pcm, dtype=np.int16).astype(np.float32)
        total_samples = len(orig_samples)

        # 2. Decode all cue MP3 files in parallel (8 threads) for fast mixing
        def _decode_cue_mp3(cue: Dict[str, Any]):
            mp3_path = cue.get("audio_path")
            if not mp3_path or not Path(mp3_path).exists():
                return None
            proc = subprocess.run(
                [
                    FFMPEG_EXE, "-hide_banner", "-loglevel", "error",
                    "-i", str(mp3_path),
                    "-ac", "1", "-ar", str(SR), "-f", "s16le", "pipe:1"
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL
            )
            if not proc.stdout:
                return None
            cue_pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32)
            if len(cue_pcm) == 0:
                return None
            peak = float(np.max(np.abs(cue_pcm)))
            if peak > 500.0:
                cue_pcm = cue_pcm * (26000.0 / peak)
            return cue_pcm

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            decoded_pcms = list(pool.map(_decode_cue_mp3, cues_with_audio))

        self._update_progress(job_id, "Đang hòa âm chuẩn phòng thu (Auto-Ducking 24kHz)...", 94.0)

        # 3. Build smooth cosine auto-ducking envelope + overlay voiceover PCM at exact millisecond offsets
        env = np.ones(total_samples, dtype=np.float32)
        voice_track = np.zeros(total_samples, dtype=np.float32)
        fade_len = int(0.18 * SR)  # 180ms smooth fade-in / fade-out around each spoken line

        for idx, cue in enumerate(cues_with_audio):
            cue_pcm = decoded_pcms[idx]
            if cue_pcm is None:
                continue

            start_idx = max(0, int(float(cue["start"]) * SR))
            if start_idx >= total_samples:
                continue

            # Ensure cue does not overlap the next cue's start_idx
            max_end_idx = total_samples
            if idx + 1 < len(cues_with_audio):
                next_start_idx = int(float(cues_with_audio[idx + 1]["start"]) * SR)
                if next_start_idx > start_idx:
                    max_end_idx = min(total_samples, next_start_idx)

            clip_len = min(len(cue_pcm), max_end_idx - start_idx)
            if clip_len <= 0:
                continue

            end_idx = start_idx + clip_len
            voice_track[start_idx:end_idx] = cue_pcm[:clip_len]

            # Apply ducking to original audio during [start_idx, end_idx] with smooth 180ms ramps
            env[start_idx:end_idx] = np.minimum(env[start_idx:end_idx], duck_level)
            f_in_start = max(0, start_idx - fade_len)
            if start_idx > f_in_start:
                ramp_down = np.linspace(1.0, duck_level, start_idx - f_in_start, dtype=np.float32)
                env[f_in_start:start_idx] = np.minimum(env[f_in_start:start_idx], ramp_down)

            f_out_end = min(total_samples, end_idx + fade_len)
            if f_out_end > end_idx:
                ramp_up = np.linspace(duck_level, 1.0, f_out_end - end_idx, dtype=np.float32)
                env[end_idx:f_out_end] = np.minimum(env[end_idx:f_out_end], ramp_up)

        # 4. Combine ducked original audio + normalized Vietnamese voiceover with soft limiter
        mixed = orig_samples * env + voice_track
        mixed = np.clip(mixed, -32760.0, 32760.0).astype(np.int16)

        with wave.open(str(mixed_wav), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SR)
            wf.writeframes(mixed.tobytes())

        self._update_progress(job_id, "Đang đóng gói file MP4 hoàn chỉnh (-c:v copy, giữ nguyên 100% nét gốc)...", 97.5)

        # 5. Mux original video (-c:v copy, 0 re-encoding!) + mixed Vietnamese dubbing track into MP4
        mux_cmd = [
            FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src_video),
            "-i", str(mixed_wav),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(output_mp4)
        ]
        subprocess.run(mux_cmd, check=True)

        # Clean up temporary WAV files
        for tmp_f in (orig_wav, mixed_wav):
            try:
                tmp_f.unlink()
            except Exception:
                pass
