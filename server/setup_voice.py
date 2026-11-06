from pathlib import Path
import urllib.request
import hashlib

root = Path(__file__).resolve().parent / 'models'
root.mkdir(exist_ok=True)
base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/'
HASHES = {
    'vi_VN-vais1000-medium.onnx': 'ec7c89e2c85f4d1edc24b6120c18aaf1bda614f06b511567eb9c7c0de15e2dab',
    'vi_VN-vais1000-medium.onnx.json': 'fafb9da1354ed4b77c31af228ed41fb41cd825c14cffa105454b25e6ae751ee0',
}
for name in ['vi_VN-vais1000-medium.onnx', 'vi_VN-vais1000-medium.onnx.json', 'MODEL_CARD']:
    target = root / ('PIPER-MODEL-CARD.txt' if name == 'MODEL_CARD' else name)
    if not target.exists():
        temporary = target.with_suffix(target.suffix + '.download')
        urllib.request.urlretrieve(base + name, temporary)
        temporary.replace(target)
    if name in HASHES and hashlib.sha256(target.read_bytes()).hexdigest() != HASHES[name]:
        raise RuntimeError(f'Voice checksum mismatch: {name}')
    print('Voice file ready:', target.name)
