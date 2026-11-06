"""Verify Vietnamese tone marks and an actual movie subtitle crop."""
import sys
import time
from pathlib import Path
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from vietnamese_ocr import VietnameseOCR

engine = VietnameseOCR()
try:
    for text in ['Họ bắn các nhà báo ở phía thủ đô.', 'Chúng tôi sẽ đến thủ đô vào sáng mai.', 'Xin chào các bạn.']:
        image = Image.new('RGB', (1200, 140), 'black')
        ImageDraw.Draw(image).text((30, 30), text, font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 42), fill='white')
        buffer = BytesIO()
        image.save(buffer, format='PNG')
        started = time.monotonic()
        result = engine.recognize(buffer.getvalue())
        assert result['text'].strip() == text, ascii(result)
        assert result['confidence'] >= 75, result
        print('PASS Vietnamese tone marks:', ascii(text), round(time.monotonic()-started, 3), 'seconds')
    screenshot = Path('C:/Users/phuct/AppData/Local/Temp/codex-clipboard-821e1d2b-084a-4289-b408-01fc1b9cf0a5.png')
    if screenshot.exists():
        image = Image.open(screenshot).crop((750, 497, 1710, 548))
        buffer = BytesIO()
        image.save(buffer, format='PNG')
        result = engine.recognize(buffer.getvalue())
        expected = 'Sự đóng góp này rất có ý nghĩa với chúng tôi!'
        # Condensed movie lettering can still confuse a tone mark; reject larger errors.
        from difflib import SequenceMatcher
        assert SequenceMatcher(None, result['text'].strip(), expected).ratio() > .95, ascii(result)
        assert result['confidence'] >= 80, ascii(result)
        print('PASS actual movie subtitle crop:', ascii(result['text'].strip()))
finally:
    engine.close()
