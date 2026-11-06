"""Reusable local Vietnamese neural voice. No network calls during synthesis."""
import threading
import wave
from io import BytesIO
from pathlib import Path

MODEL = Path(__file__).resolve().parent / 'models/vi_VN-vais1000-medium.onnx'
_voice = None
_lock = threading.Lock()


def ready():
    return MODEL.is_file() and MODEL.with_suffix('.onnx.json').is_file()


def synthesize(text, path):
    global _voice
    if not ready():
        raise RuntimeError('Chưa có giọng cục bộ. Chạy server/setup_voice.py rồi thử lại.')
    with _lock:
        if _voice is None:
            from piper import PiperVoice
            _voice = PiperVoice.load(MODEL)
        output = BytesIO()
        with wave.open(output, 'wb') as audio:
            _voice.synthesize_wav(text, audio)
        data = output.getvalue()
    with wave.open(BytesIO(data)) as audio:
        duration = audio.getnframes() / audio.getframerate()
    Path(path).write_bytes(data)
    return duration
