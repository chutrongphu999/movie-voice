"""Persistent local Tesseract worker; no subtitle images leave the computer."""
import base64
import json
import shutil
import subprocess
import threading
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageOps


def prepare_subtitle(image_bytes):
    image = Image.open(BytesIO(image_bytes)).convert('L')
    # Movie subtitles commonly use narrow white letters with a black outline.
    # Invert the foreground and widen condensed glyphs before recognition.
    image = image.point(lambda pixel: 0 if pixel > 160 else 255)
    image = image.resize((round(image.width * 2.6), image.height * 2), Image.Resampling.LANCZOS)
    image = ImageOps.expand(image, border=20, fill=255)
    output = BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


class VietnameseOCR:
    def __init__(self):
        root = Path(__file__).resolve().parent
        node = shutil.which('node')
        if not node or not (root / 'models/vie.traineddata').exists():
            raise RuntimeError('Thiếu Node.js hoặc models/vie.traineddata')
        self.lock = threading.Lock()
        self.process = subprocess.Popen(
            [node, str(root / 'ocr/worker.cjs')], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        if not json.loads(self.process.stdout.readline()).get('ready'):
            raise RuntimeError('Không khởi tạo được OCR tiếng Việt')

    def recognize(self, image_bytes, subtitle=True):
        with self.lock:
            if self.process.poll() is not None:
                raise RuntimeError('OCR đã dừng; hãy khởi động lại server')
            def read_image(payload):
                self.process.stdin.write(json.dumps({'image': base64.b64encode(payload).decode()}) + '\n')
                self.process.stdin.flush()
                result = json.loads(self.process.stdout.readline())
                if result.get('error'):
                    raise RuntimeError(result['error'])
                return result
            result = read_image(image_bytes)
            if subtitle and result.get('text', '').strip() and result.get('confidence', 0) < 90:
                alternative = read_image(prepare_subtitle(image_bytes))
                if alternative.get('confidence', 0) > result.get('confidence', 0):
                    result = alternative
            return result

    def close(self):
        self.process.terminate()
