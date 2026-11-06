"""Hard-sub reader: reads burned-in subtitle text from a cropped video frame using Gemini Vision.
Rotates across several Gemini models (each has its own free quota) and cools down any model that returns 429.
"""
import os
import re
import time
import base64
import asyncio
from typing import Dict, Optional
import aiohttp

VISION_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-2.5-flash",
]

PROMPT = (
    "Đây là ảnh cắt phần dưới của một khung hình phim. Hãy đọc CHÍNH XÁC phụ đề (chữ phim) đang hiển thị, "
    "giữ nguyên dấu tiếng Việt. Chỉ trả về nội dung phụ đề, các dòng nối bằng một dấu cách. "
    "Bỏ qua logo, watermark, tên website, chữ quảng cáo. "
    "Nếu không có phụ đề thì trả về đúng một từ: NONE."
)


class SubtitleReader:
    def __init__(self, api_key: str = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY", "")
        self._cooldown: Dict[str, float] = {}
        self._idx = 0

    def update_key(self, api_key: str):
        if api_key:
            self.api_key = api_key

    async def _call(self, model: str, jpeg_b64: str) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        payload = {
            "contents": [{
                "parts": [
                    {"text": PROMPT},
                    {"inline_data": {"mime_type": "image/jpeg", "data": jpeg_b64}},
                ]
            }],
            "generationConfig": {"temperature": 0.0, "maxOutputTokens": 200},
        }
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=7.0)) as session:
            async with session.post(url, headers={"x-goog-api-key": self.api_key}, json=payload) as resp:
                if resp.status == 429:
                    self._cooldown[model] = time.monotonic() + 60.0
                    raise RuntimeError("429")
                if resp.status != 200:
                    self._cooldown[model] = time.monotonic() + 20.0
                    raise RuntimeError(f"HTTP {resp.status}")
                data = await resp.json()
                parts = data["candidates"][0]["content"]["parts"]
                return "".join(p.get("text", "") for p in parts).strip()

    async def read(self, jpeg_bytes: bytes) -> Optional[str]:
        """Returns subtitle text, '' if no subtitle, or None if every model failed."""
        if not self.api_key:
            raise RuntimeError("Chưa cấu hình GEMINI_API_KEY trong engine/.env!")
        b64 = base64.b64encode(jpeg_bytes).decode("ascii")
        now = time.monotonic()
        n = len(VISION_MODELS)
        for i in range(n):
            model = VISION_MODELS[(self._idx + i) % n]
            if self._cooldown.get(model, 0) > now:
                continue
            try:
                text = await self._call(model, b64)
                self._idx = (self._idx + i + 1) % n
                return clean_sub_text(text)
            except Exception as e:
                print(f"[OCR] {model} skipped ({e})")
        return None


def clean_sub_text(text: str) -> str:
    text = (text or "").strip().strip("`\"'")
    if not text or text.upper().startswith("NONE"):
        return ""
    text = re.sub(r"\s+", " ", text)
    return text
