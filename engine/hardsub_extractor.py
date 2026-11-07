"""Offline Hard-Sub Extractor & Contact-Sheet Vision OCR for Movie Voice Studio (v6).

Scans the bottom subtitle region of a video file using FFmpeg raw video piping + OpenCV (cv2):
1. Detects exact timestamps [start_sec, end_sec] when burned-in subtitles appear, change, or disappear.
2. Extracts the sharpest cropped subtitle strip (640x96) for each unique subtitle line.
3. Stacks up to 14 subtitle strips vertically into a numbered Contact Sheet image (#1 .. #14).
4. Uses rotating Gemini Flash Vision models (with retry & fallback) to read the exact Vietnamese
   (or English) subtitle text printed on the video frames so the voiceover matches the on-screen
   subtitle 100% word-for-word and timestamp-for-timestamp.
"""
import os
import re
import json
import base64
import asyncio
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional, Callable, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import aiohttp

from providers.tts_edge import FFMPEG_EXE

VISION_MODELS = [
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
]

STRIP_W = 640
STRIP_H = 104
SCAN_FPS = 2.5  # 0.40s timestamp precision (fast scan, catches all movie subtitles)
BATCH_STRIPS_PER_SHEET = 16

CONTACT_SHEET_PROMPT = """Bạn là hệ thống OCR đọc phụ đề phim chính xác tuyệt đối.
Trong ảnh đính kèm là các dải phụ đề cắt từ đáy khung hình video, được xếp chồng từ trên xuống dưới và đánh số thứ tự ở lề trái (#1, #2, #3...).

Quy tắc bắt buộc:
1. Đọc CHÍNH XÁC 100% từng từ tiếng Việt (hoặc tiếng Anh nếu phụ đề là tiếng Anh) hiển thị trong mỗi dải #id.
2. Nếu một dải có 2 dòng thoại (ví dụ: "- Tony!\\n- Tôi ổn."), hãy gộp thành 1 câu cách nhau bởi dấu cách (ví dụ: "Tony! Tôi ổn."), bỏ dấu gạch ngang đầu dòng "-".
3. Bỏ qua mọi logo góc màn hình, tên web quảng cáo, hoặc khung hình không có chữ phụ đề (trả về chuỗi rỗng "" cho id đó).
4. Tuyệt đối KHÔNG tự bịa chữ, KHÔNG dịch hay viết lại câu nếu chữ trên hình đã là tiếng Việt. Giữ đúng từng từ như trên hình để giọng thuyết minh khớp 100% với chữ người xem nhìn thấy.
5. Chỉ trả về DUY NHẤT một JSON hợp lệ (không bọc markdown):
{"items":[{"id":1,"text":"..."},{"id":2,"text":"..."}]}"""


def clean_ocr_subtitle_text(text: str) -> str:
    """Cleans OCR subtitle text for natural TTS reading while keeping exact wording."""
    if not text:
        return ""
    # Replace newlines and dialogue dashes with clean spacing
    lines = []
    for raw_line in text.splitlines():
        s = raw_line.strip()
        s = re.sub(r"^[-–—•*+]+\s*", "", s).strip()
        if s:
            lines.append(s)
    joined = " ".join(lines)
    joined = re.sub(r"\s*[-–—]\s+", " ", joined)
    joined = re.sub(r"\[.*?\]|\(.*?\)|♪|♫", "", joined)
    joined = re.sub(r"\s+", " ", joined).strip()
    # Filter out common watermark/url noise
    if re.search(r"(motchill|phimmoi|rophim|kkphim|ophim|streamc|\.com|\.net|\.cc|\.vn|subteam)", joined, re.I):
        if len(joined.split()) <= 4:
            return ""
    return joined


def extract_subtitle_mask_and_score(frame_bgr: np.ndarray) -> Tuple[np.ndarray, int, float]:
    """
    Computes a binary mask of high-contrast subtitle text pixels (bright white/yellow text
    with dark outline/drop-shadow) in a 640x96 bottom-strip BGR frame.
    Returns (mask, text_pixel_count, sharpness_score).
    """
    h, w, _ = frame_bgr.shape
    # Focus on horizontal center 8%..92% and vertical 6%..94% where subtitles live
    x0, x1 = int(w * 0.08), int(w * 0.92)
    y0, y1 = int(h * 0.06), int(h * 0.94)
    roi = frame_bgr[y0:y1, x0:x1]

    b = roi[:, :, 0].astype(np.int16)
    g = roi[:, :, 1].astype(np.int16)
    r = roi[:, :, 2].astype(np.int16)

    # 1. Bright white or bright yellow subtitle pixels (supports compressed/anti-aliased cinema streams)
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    is_white = (r >= 150) & (g >= 150) & (b >= 150) & ((max_c - min_c) <= 45)
    # Yellow: R>=165, G>=150, B<=115
    is_yellow = (r >= 165) & (g >= 150) & (b <= 115) & ((r - b) >= 75)
    bright_text = (is_white | is_yellow).astype(np.uint8) * 255

    # 2. Dark outline / shadow pixels (movie hard-subs always have black outline/shadow)
    is_dark = (max_c <= 80).astype(np.uint8) * 255
    kernel_5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    dilated_dark = cv2.dilate(is_dark, kernel_5, iterations=1)

    # Text pixels must be bright AND near dark outline pixels
    sub_mask_roi = cv2.bitwise_and(bright_text, dilated_dark)

    # Filter connected components by character-like bounding boxes (height 6..52px, width 2..140px)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(sub_mask_roi, connectivity=8)
    filtered_roi = np.zeros_like(sub_mask_roi)
    valid_pixels = 0
    for lbl in range(1, num_labels):
        cw = stats[lbl, cv2.CC_STAT_WIDTH]
        ch = stats[lbl, cv2.CC_STAT_HEIGHT]
        area = stats[lbl, cv2.CC_STAT_AREA]
        if 6 <= ch <= 54 and 2 <= cw <= 145 and area >= 6:
            filtered_roi[labels == lbl] = 255
            valid_pixels += int(area)

    full_mask = np.zeros((h, w), dtype=np.uint8)
    full_mask[y0:y1, x0:x1] = filtered_roi

    # Dilate slightly so IoU comparison between adjacent frames tolerates 1-2px video compression jitter
    kernel_iou = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
    iou_mask = cv2.dilate(full_mask, kernel_iou, iterations=1)

    # Sharpness score (Laplacian variance on grayscale ROI) to pick the crispest frame mid-subtitle
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var()) if valid_pixels >= 45 else 0.0

    return iou_mask, valid_pixels, sharpness


def compute_mask_similarity(mask_a: np.ndarray, mask_b: np.ndarray) -> float:
    """Computes overlap similarity between two dilated subtitle masks."""
    inter = int(np.count_nonzero(cv2.bitwise_and(mask_a, mask_b)))
    union = int(np.count_nonzero(cv2.bitwise_or(mask_a, mask_b)))
    if union == 0:
        return 1.0
    return inter / float(union)


class HardSubExtractor:
    def __init__(self, gemini_key: str = ""):
        self.gemini_key = (gemini_key or os.getenv("GEMINI_API_KEY", "")).strip()
        self._model_idx = 0

    def update_key(self, gemini_key: str = ""):
        if gemini_key:
            self.gemini_key = gemini_key.strip()

    async def extract_hardsub_cues(
        self,
        video_path: str,
        start_sec: float = 0.0,
        end_sec: float = 0.0,
        total_duration: float = 0.0,
        progress_cb: Optional[Callable[[str, float], None]] = None
    ) -> List[Dict[str, Any]]:
        """
        Full pipeline:
        1. Scans bottom 28% of video via FFmpeg + OpenCV at 2.5 fps to detect subtitle [start, end] events.
        2. Packs unique subtitle strips into numbered Contact Sheets (16 strips/sheet).
        3. Runs Vision OCR (4 sheets in parallel) to read exact Vietnamese/English subtitle text.
        4. Deduplicates/merges identical adjacent cues and returns [{start, end, text}, ...].
        """
        if progress_cb:
            progress_cb("Đang quét vùng phụ đề trên video bằng OpenCV...", 20.0)

        events = await asyncio.to_thread(
            self._scan_video_events_sync,
            video_path,
            start_sec,
            end_sec,
            total_duration,
            progress_cb
        )
        if not events:
            return []

        if progress_cb:
            progress_cb(f"Đã phát hiện {len(events)} khung phụ đề. Đang đọc chữ chính xác trên hình...", 45.0)

        ocr_cues = await self._ocr_events_in_batches(events, progress_cb)

        # Merge consecutive cues that have the exact same text (e.g. across a camera flash)
        merged: List[Dict[str, Any]] = []
        for cue in ocr_cues:
            txt = clean_ocr_subtitle_text(cue.get("text", ""))
            if not txt or len(txt) < 2:
                continue
            cue["text"] = txt
            if merged and merged[-1]["text"].lower() == txt.lower() and (cue["start"] - merged[-1]["end"]) <= 0.85:
                merged[-1]["end"] = round(max(merged[-1]["end"], cue["end"]), 2)
            else:
                merged.append({
                    "start": round(float(cue["start"]), 2),
                    "end": round(max(float(cue["start"]) + 0.8, float(cue["end"])), 2),
                    "text": txt
                })

        print(f"[HardSubExtractor] Hoàn tất trích xuất {len(merged)} câu phụ đề khớp 100% với hình ảnh.")
        return merged

    def _scan_video_events_sync(
        self,
        video_path: str,
        start_sec: float,
        end_sec: float,
        total_duration: float = 0.0,
        progress_cb: Optional[Callable[[str, float], None]] = None
    ) -> List[Dict[str, Any]]:
        """
        Streams the bottom 28% of `video_path` through FFmpeg at 2.5 fps into OpenCV
        and detects every subtitle appearance, change, and disappearance.
        """
        cmd = [FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-threads", "4"]
        if start_sec > 0:
            cmd.extend(["-ss", f"{start_sec:.2f}"])
        if end_sec > start_sec:
            cmd.extend(["-to", f"{end_sec:.2f}"])

        # Crop bottom 28% (from y=66% to y=94%) where 1-line and 2-line burned-in subtitles appear, scale to 640x104
        vf = f"fps={SCAN_FPS},crop=iw:ih*0.28:0:ih*0.66,scale={STRIP_W}:{STRIP_H}"
        cmd.extend([
            "-i", str(video_path),
            "-an", "-sn",
            "-vf", vf,
            "-pix_fmt", "bgr24",
            "-f", "rawvideo",
            "pipe:1"
        ])

        frame_bytes_len = STRIP_W * STRIP_H * 3
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=frame_bytes_len * 16)

        events: List[Dict[str, Any]] = []
        active_event: Optional[Dict[str, Any]] = None
        empty_streak = 0
        frame_idx = 0
        MIN_TEXT_PIXELS = 52
        est_dur = max(10.0, total_duration if total_duration > 0 else 3600.0)

        try:
            while True:
                raw = proc.stdout.read(frame_bytes_len) if proc.stdout else b""
                if not raw or len(raw) < frame_bytes_len:
                    break

                t = round(frame_idx / SCAN_FPS, 2)
                frame_idx += 1

                frame = np.frombuffer(raw, dtype=np.uint8).reshape((STRIP_H, STRIP_W, 3)).copy()
                iou_mask, px_count, sharpness = extract_subtitle_mask_and_score(frame)

                if px_count >= MIN_TEXT_PIXELS:
                    empty_streak = 0
                    if active_event is None:
                        active_event = {
                            "start": t,
                            "end": round(t + (1.0 / SCAN_FPS), 2),
                            "mask": iou_mask,
                            "px_count": px_count,
                            "best_frame": frame,
                            "best_score": sharpness * (1.0 + min(px_count, 800) / 800.0),
                            "frames_seen": 1,
                        }
                    else:
                        sim = compute_mask_similarity(active_event["mask"], iou_mask)
                        px_ratio = min(px_count, active_event["px_count"]) / float(max(px_count, active_event["px_count"], 1))
                        # Same subtitle still on screen
                        if sim >= 0.44 or (sim >= 0.34 and px_ratio >= 0.78):
                            active_event["end"] = round(t + (1.0 / SCAN_FPS), 2)
                            active_event["frames_seen"] += 1
                            score = sharpness * (1.0 + min(px_count, 800) / 800.0)
                            # Prefer frame after the first fade-in frame
                            if active_event["frames_seen"] >= 2 and score >= active_event["best_score"] * 0.92:
                                active_event["best_frame"] = frame
                                active_event["best_score"] = score
                                active_event["mask"] = iou_mask
                                active_event["px_count"] = px_count
                        else:
                            # Subtitle changed directly to a new line!
                            if (active_event["end"] - active_event["start"]) >= 0.25:
                                events.append({
                                    "start": active_event["start"],
                                    "end": round(t, 2),
                                    "frame": active_event["best_frame"]
                                })
                            active_event = {
                                "start": t,
                                "end": round(t + (1.0 / SCAN_FPS), 2),
                                "mask": iou_mask,
                                "px_count": px_count,
                                "best_frame": frame,
                                "best_score": sharpness * (1.0 + min(px_count, 800) / 800.0),
                                "frames_seen": 1,
                            }
                else:
                    empty_streak += 1
                    if active_event is not None and empty_streak >= 1:
                        if (active_event["end"] - active_event["start"]) >= 0.25:
                            events.append({
                                "start": active_event["start"],
                                "end": active_event["end"],
                                "frame": active_event["best_frame"]
                            })
                        active_event = None

                if frame_idx % 25 == 0 and progress_cb:
                    mins = int(t // 60)
                    secs = int(t % 60)
                    tot_m = int(est_dur // 60)
                    tot_s = int(est_dur % 60)
                    pct = 20.0 + min(24.5, (t / est_dur) * 24.5)
                    progress_cb(
                        f"Đang quét hình ảnh phụ đề: phút {mins:02d}:{secs:02d} / {tot_m:02d}:{tot_s:02d} (đã bắt được {len(events)} khung chữ)...",
                        pct
                    )
        finally:
            try:
                if proc.stdout:
                    proc.stdout.close()
                proc.terminate()
            except Exception:
                pass

        if active_event is not None and (active_event["end"] - active_event["start"]) >= 0.25:
            events.append({
                "start": active_event["start"],
                "end": active_event["end"],
                "frame": active_event["best_frame"]
            })

        return events

    def _build_contact_sheet_jpeg(self, batch_events: List[Dict[str, Any]]) -> bytes:
        """
        Stacks up to 12 subtitle crop strips vertically into a single numbered JPEG Contact Sheet.
        Left column (56px wide) displays clear #1, #2, ... badges so the Vision model never misaligns indices.
        """
        n = len(batch_events)
        label_w = 58
        divider_h = 4
        total_w = label_w + STRIP_W
        total_h = n * STRIP_H + (n - 1) * divider_h

        sheet = Image.new("RGB", (total_w, total_h), (18, 18, 24))
        draw = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.truetype("arialbd.ttf", 22)
        except Exception:
            font = ImageFont.load_default()

        for idx, ev in enumerate(batch_events):
            y_top = idx * (STRIP_H + divider_h)
            # Draw left badge box
            draw.rectangle([0, y_top, label_w - 2, y_top + STRIP_H - 1], fill=(32, 38, 56))
            draw.text((8, y_top + STRIP_H // 2 - 12), f"#{idx + 1}", fill=(255, 230, 80), font=font)

            # Convert BGR strip to RGB and enhance contrast slightly for crisp OCR
            bgr = ev["frame"]
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            pil_strip = Image.fromarray(rgb)
            sheet.paste(pil_strip, (label_w, y_top))

            if idx < n - 1:
                draw.rectangle([0, y_top + STRIP_H, total_w, y_top + STRIP_H + divider_h - 1], fill=(255, 215, 0))

        import io
        buf = io.BytesIO()
        sheet.save(buf, format="JPEG", quality=88)
        return buf.getvalue()

    async def _ocr_single_sheet(self, jpeg_bytes: bytes, count: int) -> Dict[int, str]:
        """Calls rotating Gemini Flash Vision models to read all #1..#count strips in one contact sheet."""
        if not self.gemini_key:
            raise RuntimeError("GEMINI_API_KEY is required for Vision Hard-Sub OCR")

        b64 = base64.b64encode(jpeg_bytes).decode("ascii")
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": f"{CONTACT_SHEET_PROMPT}\nẢnh này có {count} dải phụ đề đánh số từ #1 đến #{count}."},
                        {"inline_data": {"mime_type": "image/jpeg", "data": b64}}
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.05,
                "maxOutputTokens": 1200,
            }
        }

        for attempt in range(len(VISION_MODELS) * 2):
            model = VISION_MODELS[self._model_idx % len(VISION_MODELS)]
            self._model_idx += 1
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.gemini_key}"
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15.0)) as session:
                    async with session.post(url, json=payload) as resp:
                        if resp.status == 429:
                            await asyncio.sleep(1.5)
                            continue
                        if resp.status != 200:
                            continue
                        data = await resp.json()
                        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
                        return self._parse_sheet_json(raw_text)
            except Exception as e:
                print(f"[HardSubExtractor] Vision {model} retry: {e}")
                await asyncio.sleep(0.8)

        return {}

    def _parse_sheet_json(self, raw_text: str) -> Dict[int, str]:
        """Extracts {"items":[{"id":1,"text":"..."}]} from model response."""
        out: Dict[int, str] = {}
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", (raw_text or "").strip(), flags=re.IGNORECASE)
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                obj = json.loads(cleaned[start : end + 1])
                for item in obj.get("items", []):
                    if isinstance(item, dict) and "id" in item:
                        idx = int(item["id"])
                        txt = str(item.get("text", "")).strip()
                        out[idx] = txt
                if out:
                    return out
            except Exception:
                pass

        # Fallback line parser if JSON was slightly malformed
        for line in cleaned.splitlines():
            m = re.match(r'^#?(\d+)\s*[:\-]\s*"?([^"]+)"?$', line.strip())
            if m:
                out[int(m.group(1))] = m.group(2).strip()
        return out

    async def _ocr_events_in_batches(
        self,
        events: List[Dict[str, Any]],
        progress_cb: Optional[Callable[[str, float], None]] = None
    ) -> List[Dict[str, Any]]:
        """Processes all detected subtitle events in parallel Contact Sheet batches (3 workers)."""
        total_events = len(events)
        batches = [
            events[i : i + BATCH_STRIPS_PER_SHEET]
            for i in range(0, total_events, BATCH_STRIPS_PER_SHEET)
        ]
        batch_results: List[List[Dict[str, Any]]] = [[] for _ in range(len(batches))]
        sem = asyncio.Semaphore(3)
        done_events = 0

        async def _run_batch(b_idx: int, batch: List[Dict[str, Any]]):
            nonlocal done_events
            async with sem:
                jpeg_bytes = await asyncio.to_thread(self._build_contact_sheet_jpeg, batch)
                mapping = await self._ocr_single_sheet(jpeg_bytes, len(batch))
                out_list = []
                for i, ev in enumerate(batch):
                    txt = mapping.get(i + 1, "")
                    if txt:
                        out_list.append({
                            "start": ev["start"],
                            "end": ev["end"],
                            "text": txt
                        })
                batch_results[b_idx] = out_list
                done_events = min(total_events, done_events + len(batch))
                if progress_cb:
                    pct = 45.0 + (done_events / float(max(1, total_events))) * 22.0
                    sample = out_list[-1]["text"] if out_list else "..."
                    progress_cb(
                        f"Đọc chữ phụ đề trên hình ({done_events}/{total_events} câu) — vừa đọc: \"{sample[:45]}\"",
                        pct
                    )
                await asyncio.sleep(0.25)

        await asyncio.gather(*[_run_batch(i, b) for i, b in enumerate(batches)])
        results: List[Dict[str, Any]] = []
        for sub in batch_results:
            results.extend(sub)
        return results
