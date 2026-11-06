import os
import sys
import re
import base64
import hashlib
import asyncio
import atexit
from io import BytesIO
from typing import Optional

# Đảm bảo console Windows hiển thị tiếng Việt UTF-8 không lỗi font
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from pydantic import BaseModel
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
import edge_tts

# Khởi tạo Engine OCR để hỗ trợ đọc Sub Cứng (Hardsub)
from PIL import Image
ocr_engine = None
try:
    from vietnamese_ocr import VietnameseOCR
    ocr_engine = VietnameseOCR()
    atexit.register(ocr_engine.close)
    print('[OCR] Vietnamese Tesseract ready')
except Exception as e:
    print(f'[OCR] Vietnamese OCR unavailable: {e}')

app = FastAPI(title="Movie Voiceover Pro - AI Storytelling & Dubbing Server")

# Cho phép CORS toàn cục để Chrome Extension gọi từ mọi trang web phim
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8765", "http://localhost:8765"],
    allow_origin_regex=r"chrome-extension://[a-p]{32}",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Bộ nhớ đệm âm thanh (In-memory LRU Cache)
AUDIO_CACHE = {}
MAX_CACHE_SIZE = 800

# Hệ thống Preset Giọng đọc chuẩn Review Phim & Kể Chuyện
VOICE_PRESETS = {
    "review_male": {
        "name": "🔥 Review Phim Kịch Tính (Nam)",
        "voice": "vi-VN-NamMinhNeural",
        "rate": 18,     # +18% nhanh, dứt khoát kiểu Tóm tắt phim
        "pitch": -4,    # -4Hz trầm, dày giọng
        "volume": "+0%"  # Keep service volume at its supported baseline.
    },
    "review_female": {
        "name": "✨ Review Phim Cuốn Hút (Nữ)",
        "voice": "vi-VN-HoaiMyNeural",
        "rate": 15,     # +15% lôi cuốn, mượt mà
        "pitch": -2,    # -2Hz bớt chói, ấm áp hơn
        "volume": "+0%"
    },
    "story_male": {
        "name": "📖 Kể Chuyện Trầm Ấm (Nam)",
        "voice": "vi-VN-NamMinhNeural",
        "rate": 4,      # +4% nhịp kể chuyện tự nhiên
        "pitch": -5,    # -5Hz giọng trầm sâu
        "volume": "+0%"
    },
    "story_female": {
        "name": "🌙 Kể Chuyện Đêm Khuya (Nữ)",
        "voice": "vi-VN-HoaiMyNeural",
        "rate": -2,     # -2% thong thả, truyền cảm
        "pitch": -3,    # -3Hz dịu dàng
        "volume": "+0%"
    },
    "vtv_female": {
        "name": "📺 Thuyết Minh Truyền Hình (Nữ VTV)",
        "voice": "vi-VN-HoaiMyNeural",
        "rate": 10,     # +10% chuẩn nhịp thuyết minh phim bộ
        "pitch": -1,
        "volume": "+0%"
    },
    "vtv_male": {
        "name": "📺 Thuyết Minh Truyền Hình (Nam VTV)",
        "voice": "vi-VN-NamMinhNeural",
        "rate": 10,
        "pitch": -2,
        "volume": "+0%"
    }
}

VOICES_MAP = {
    "female": "vi-VN-HoaiMyNeural",
    "male": "vi-VN-NamMinhNeural"
}


def normalize_story_text(raw_text: str) -> str:
    """
    Chuẩn hóa văn bản phụ đề sang văn phong đọc truyện / thuyết minh mượt mà:
    - Xóa thẻ HTML, ký hiệu nhạc (♪, ♫), mô tả âm thanh [Tiếng thở], (Cười)
    - Nối các dòng hội thoại bị ngắt dòng hoặc gạch đầu dòng thành câu liền mạch
    - Xử lý dấu ba chấm (...) thành nhịp nghỉ tự nhiên
    """
    if not raw_text:
        return ""

    text = raw_text
    # Bỏ HTML tags
    text = re.sub(r"<[^>]+>", " ", text)
    # Bỏ ký tự nốt nhạc
    text = re.sub(r"[♪♫♬♩]+", " ", text)
    # Bỏ mô tả âm thanh trong ngoặc vuông / ngoặc tròn
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\([^\)]*\)", " ", text)
    # Bỏ tên nhân vật viết hoa đầu câu (VD: "JOHN: Chào em")
    text = re.sub(r"^[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ0-9_\s]{2,15}:\s*", "", text, flags=re.MULTILINE)
    # Thay thế xuống dòng có gạch đầu dòng (- Câu 1 \n - Câu 2) thành dấu phẩy/chấm nghỉ nhịp
    text = re.sub(r"\n\s*[-–—]\s*", ". ", text)
    text = re.sub(r"^\s*[-–—]\s*", "", text)
    # Nối các dòng bị ngắt giữa chừng
    text = re.sub(r"\s*\n+\s*", ", ", text)
    # Xử lý dấu ba chấm (...) để không bị ngắt cụt
    text = re.sub(r"\.{2,}", ", ", text)
    # Chuẩn hóa khoảng trắng
    text = re.sub(r"\s+", " ", text).strip()
    # Bỏ dấu phẩy thừa ở đầu/cuối
    text = text.strip(",; ")
    return text


def format_rate(rate_val: int) -> str:
    return f"+{rate_val}%" if rate_val >= 0 else f"{rate_val}%"


def format_pitch(pitch_val: int) -> str:
    return f"+{pitch_val}Hz" if pitch_val >= 0 else f"{pitch_val}Hz"


@app.get("/ping")
async def ping():
    return {
        "status": "ok",
        "ocr_ready": ocr_engine is not None,
        "ocr_engine": 'tesseract-vie' if ocr_engine else None,
        "presets": {k: v["name"] for k, v in VOICE_PRESETS.items()}
    }


@app.get("/tts")
async def text_to_speech(
    text: str = Query(..., description="Văn bản phụ đề cần đọc"),
    preset: str = Query("review_female", description="Mã preset giọng đọc"),
    voice: Optional[str] = Query(None, description="Ghi đè giọng: 'female' hoặc 'male'"),
    rate_offset: int = Query(0, description="Tăng/giảm thêm tốc độ (%) so với preset"),
    pitch_offset: int = Query(0, description="Tăng/giảm thêm độ trầm (Hz) so với preset"),
    boost: int = Query(0, description="Tăng tốc tự động khi phụ đề chạy nhanh (%)")
):
    clean_text = normalize_story_text(text)
    if not clean_text or len(clean_text) < 2:
        raise HTTPException(status_code=400, detail="Text too short after normalization")

    # Lấy thông số từ Preset
    p = VOICE_PRESETS.get(preset, VOICE_PRESETS["review_female"])
    voice_id = VOICES_MAP.get(voice, p["voice"]) if voice else p["voice"]

    # Tính toán Rate và Pitch cuối cùng (giới hạn an toàn)
    final_rate_num = max(-40, min(80, p["rate"] + rate_offset + boost))
    final_pitch_num = max(-20, min(20, p["pitch"] + pitch_offset))

    rate_str = format_rate(final_rate_num)
    pitch_str = format_pitch(final_pitch_num)
    volume_str = p.get("volume", "+0%")

    # Kiểm tra Cache
    cache_key = hashlib.md5(
        f"{clean_text}_{voice_id}_{rate_str}_{pitch_str}".encode("utf-8")
    ).hexdigest()

    if cache_key in AUDIO_CACHE:
        return Response(content=AUDIO_CACHE[cache_key], media_type="audio/mpeg")

    last_err = None
    for attempt in range(3):
        try:
            # Some upstream sessions return no audio for customized prosody.
            # The final attempt uses the same voice with baseline prosody.
            fallback = attempt == 2
            communicate = edge_tts.Communicate(
                text=clean_text,
                voice=voice_id,
                rate="+0%" if fallback else rate_str,
                pitch="+0Hz" if fallback else pitch_str,
                volume="+0%" if fallback else volume_str
            )
            audio_data = b""
            async def collect_audio():
                chunks = []
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        chunks.append(chunk["data"])
                return b"".join(chunks)
            audio_data = await asyncio.wait_for(collect_audio(), timeout=8)

            if audio_data:
                if len(AUDIO_CACHE) >= MAX_CACHE_SIZE:
                    for k in list(AUDIO_CACHE.keys())[:100]:
                        AUDIO_CACHE.pop(k, None)
                if not fallback:
                    AUDIO_CACHE[cache_key] = audio_data
                return Response(content=audio_data, media_type="audio/mpeg", headers={"X-Voiceover-Fallback": str(fallback).lower()})
        except Exception as e:
            last_err = f"{type(e).__name__}: {str(e) or 'Dịch vụ giọng nói phản hồi quá chậm'}"

    raise HTTPException(status_code=500, detail=f"TTS Error after retries: {str(last_err)}")


class OcrRequest(BaseModel):
    image_base64: str


@app.post("/ocr")
async def ocr_subtitle(req: OcrRequest):
    """
    Nhận ảnh cắt vùng phụ đề (base64) từ video Sub Cứng và trả về văn bản.
    """
    if ocr_engine is None:
        raise HTTPException(status_code=503, detail="OCR Engine chưa được cài đặt")

    try:
        img_str = req.image_base64
        if "," in img_str:
            img_str = img_str.split(",", 1)[1]
        img_bytes = base64.b64decode(img_str)
        img = Image.open(BytesIO(img_bytes)).convert("RGB")

        # A Chinese recognition alphabet cannot preserve Vietnamese tone marks.
        # Use the Vietnamese traineddata, then reject uncertain output.
        output = BytesIO()
        img.save(output, format='PNG')
        result = await run_in_threadpool(ocr_engine.recognize, output.getvalue())
        confidence = result.get('confidence', 0)
        text = normalize_story_text(result.get('text', '')) if confidence >= 75 and result.get('worstWordConfidence', 0) >= 60 else ''
        # Scene edges/control glyphs can look like letters, even with a high mean score.
        # Reject the whole candidate instead of speaking a fabricated partial sentence.
        if re.search(r'[|_~<>]', text):
            text = ''
        return {'text': text, 'confidence': confidence, 'engine': 'tesseract-vie'}
    except Exception as e:
        return {"text": "", "error": str(e)}


from pathlib import Path
from vod import router as vod_router, SESSIONS, restore_sessions
app.include_router(vod_router)


@app.on_event('startup')
async def restore_vod():
    restore_sessions()


@app.middleware('http')
async def protect_local_api(request, call_next):
    if request.url.path.startswith('/api/'):
        origin = request.headers.get('origin')
        allowed = origin in (None, 'http://127.0.0.1:8765', 'http://localhost:8765') or bool(re.fullmatch(r'chrome-extension://[a-p]{32}', origin or ''))
        host = request.headers.get('host', '').split(':')[0]
        if not allowed or host not in ('127.0.0.1', 'localhost'):
            return Response(content='Local player requests only', status_code=403)
        if request.method in ('POST', 'PUT', 'DELETE') and request.headers.get('sec-fetch-site') == 'cross-site' and not (origin or '').startswith('chrome-extension://'):
            return Response(content='Cross-site requests are not accepted', status_code=403)
    return await call_next(request)


@app.on_event('shutdown')
async def stop_vod_workers():
    for session in SESSIONS.values():
        if session.task:
            session.task.cancel()
    await asyncio.gather(*(s.task for s in SESSIONS.values() if s.task), return_exceptions=True)
    if ocr_engine:
        ocr_engine.close()


app.mount('/player', StaticFiles(directory=Path(__file__).resolve().parent / 'web', html=True), name='player')


if __name__ == "__main__":
    import uvicorn
    print("========================================================")
    print("  MOVIE VOICEOVER PRO - STORYTELLING & REVIEW SERVER")
    print("  Endpoint: http://127.0.0.1:8765")
    print("========================================================")
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)

