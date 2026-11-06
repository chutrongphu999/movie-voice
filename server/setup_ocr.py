"""Install the pinned Vietnamese model used by the local OCR worker."""
import hashlib
from pathlib import Path
import urllib.request

target = Path(__file__).resolve().parent / 'models/vie.traineddata'
EXPECTED = 'b6b49293d95d0b6dbd8780174627e82c75be957b6f4ed9862155540d6b00bb45'
target.parent.mkdir(exist_ok=True)
if not target.exists():
    urllib.request.urlretrieve('https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/vie.traineddata', target)
assert hashlib.sha256(target.read_bytes()).hexdigest() == EXPECTED, 'Vietnamese model checksum mismatch'
print('Vietnamese OCR model verified')
