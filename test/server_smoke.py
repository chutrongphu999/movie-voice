"""Run against the local server: server/.venv/Scripts/python.exe test/server_smoke.py."""
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding='utf-8')
BASE = 'http://127.0.0.1:8765'

def get_tts(text, preset):
    started = time.monotonic()
    url = BASE + '/tts?' + urllib.parse.urlencode({'text': text, 'preset': preset})
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read()
            assert response.headers.get_content_type() == 'audio/mpeg' and len(data) > 1000
        print(f'TTS {preset}: {len(data)} bytes, {time.monotonic()-started:.2f}s')
        return data
    except urllib.error.HTTPError as error:
        raise AssertionError(error.read().decode()) from error

health = json.load(urllib.request.urlopen(BASE + '/ping'))
assert health['status'] == 'ok' and health['ocr_ready']
sample = get_tts('Xin chào các bạn.', 'review_male')
get_tts('Xin chào các bạn.', 'review_female')
get_tts('Người đàn ông bước vào căn phòng bí ẩn.', 'review_male')
with open('test/voice_sample.mp3', 'wb') as output:
    output.write(sample)

image = Image.new('RGB', (1100, 130), 'black')
draw = ImageDraw.Draw(image)
draw.text((35, 35), 'Xin chào các bạn.', font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 48), fill='white')
buffer = BytesIO()
image.save(buffer, format='PNG')
request = urllib.request.Request(BASE + '/ocr', data=json.dumps({'image_base64': base64.b64encode(buffer.getvalue()).decode()}).encode(), headers={'Content-Type': 'application/json'})
ocr = json.load(urllib.request.urlopen(request, timeout=30))
assert ocr.get('text') == 'Xin chào các bạn.' and not ocr.get('error'), ocr
print('OCR:', ocr['text'])
print('PASS: server health, male/female TTS, longer dialogue, OCR')
