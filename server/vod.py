"""Look-ahead VOD dubbing: publish a segment only after its audio mix is complete."""
import asyncio
import html
import json
import math
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import edge_tts
import imageio_ffmpeg
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from gemini_provider import Gemini, ProviderError, public_settings, save_settings
from local_voice import synthesize as local_voice, ready as local_voice_ready

router = APIRouter(prefix='/api')
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.cache'
CACHE.mkdir(exist_ok=True)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
CHUNK = 20
LOOKAHEAD = 60
MAX_DURATION = 6 * 3600


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def clean_text(text):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', '', str(text)))).strip()


def validate_cues(raw, duration, offset=0):
    """Strict validation: never silently clamp hallucinated timestamps or overlaps."""
    if not isinstance(raw, list) or len(raw) > 20000:
        raise ValueError('Danh sách phụ đề không hợp lệ')
    output = []
    for item in raw:
        start, end = float(item['start']), float(item['end'])
        text = clean_text(item['text'])
        if not all(map(math.isfinite, (start, end))) or start < 0 or end <= start or end > duration + .1:
            raise ValueError('Mốc thời gian phụ đề nằm ngoài đoạn phim')
        if not text:
            continue
        if len(text) > 1000:
            raise ValueError('Một câu phụ đề quá dài')
        output.append(Cue(start + offset, min(end, duration) + offset, text))
    output.sort(key=lambda cue: cue.start)
    for a, b in zip(output, output[1:]):
        if b.start < a.end - .05:
            raise ValueError('Phụ đề chồng thời gian. Hãy gộp hội thoại trùng trước khi phát.')
    return output


def parse_subtitles(text):
    text = text.lstrip('\ufeff').replace('\r\n', '\n')
    pattern = r'(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})'
    def seconds(match):
        h, m, s, ms = match.groups()
        return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
    raw = []
    for block in re.split(r'\n\s*\n', text):
        lines = block.strip().splitlines()
        timing = next((i for i, line in enumerate(lines) if '-->' in line), None)
        if timing is None:
            continue
        left, right = lines[timing].split('-->', 1)
        a, b = re.search(pattern, left), re.search(pattern, right)
        if a and b:
            raw.append({'start': seconds(a), 'end': seconds(b), 'text': ' '.join(lines[timing + 1:])})
    if not raw:
        raise ValueError('Không tìm thấy câu phụ đề SRT/VTT hợp lệ')
    return validate_cues(raw, MAX_DURATION)


async def run_ffmpeg(args, timeout=120):
    process = await asyncio.create_subprocess_exec(
        FFMPEG, '-hide_banner', '-nostdin', '-y', *map(str, args),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(__import__('subprocess'), 'CREATE_NO_WINDOW', 0),
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
        if process.returncode:
            # Do not return remote URLs/query strings or credentials in FFmpeg stderr.
            raise RuntimeError('Không đọc hoặc xử lý được nguồn phim. Nguồn có thể hết hạn, chặn truy cập hoặc thiếu audio/video.')
        return stdout, stderr
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise


async def probe_duration(source):
    _, stderr = await run_ffmpeg([*source_options(source), '-i', source, '-t', '0', '-f', 'null', '-'], 35)
    match = re.search(rb'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', stderr)
    if not match:
        raise ValueError('Không xác định được thời lượng. Chỉ hỗ trợ phim đã ghi sẵn, không hỗ trợ livestream.')
    h, m, s = map(float, match.groups())
    duration = h * 3600 + m * 60 + s
    if not 0 < duration <= MAX_DURATION:
        raise ValueError('Thời lượng phim phải từ 1 giây đến 6 giờ')
    return duration


def input_source(value):
    if value.startswith('upload:'):
        token = value[7:]
        if not re.fullmatch(r'[a-f0-9]{32}', token):
            raise ValueError('Mã file không hợp lệ')
        path = CACHE / 'uploads' / token
        if not path.is_file():
            raise ValueError('File đã hết hạn. Hãy chọn lại file.')
        return str(path)
    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Cần link HTTP/HTTPS trực tiếp tới MP4 hoặc HLS, hoặc chọn file trên máy')
    # Only called by our same-origin UI or an extension after an explicit user action.
    return value


def source_options(source):
    protocols = 'http,https,tcp,tls,crypto' if source.startswith(('http://', 'https://')) else 'file,crypto'
    return ['-rw_timeout', '15000000', '-protocol_whitelist', protocols]


def atempo_chain(ratio):
    ratio = max(.5, ratio)
    result = []
    while ratio > 2:
        result.append('atempo=2')
        ratio /= 2
    result.append(f'atempo={ratio:.8f}')
    return ','.join(result)


async def edge_voice(text, path):
    for attempt in range(3):
        try:
            await asyncio.wait_for(edge_tts.Communicate(text, 'vi-VN-HoaiMyNeural').save(str(path)), 20)
            pcm, _ = await run_ffmpeg(['-i', path, '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', '-'])
            if len(pcm) < 100:
                raise RuntimeError('Không có âm thanh')
            return len(pcm) / 48000
        except asyncio.CancelledError:
            raise
        except Exception:
            if attempt == 2:
                raise ProviderError('Edge TTS không tạo được giọng. Chọn Gemini TTS hoặc bấm Thử lại; player chưa phát đoạn lỗi.')
            await asyncio.sleep(.5 * (attempt + 1))


@dataclass
class Segment:
    index: int
    duration: float
    path: Path
    cues: list
    elapsed: float


@dataclass
class Session:
    id: str
    source: str
    title: str
    duration: float
    cues: list | None
    provider: str
    ducking: float
    playhead: float
    root: Path
    ai: object = field(default_factory=Gemini)
    segments: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)
    target: int = 0
    processing: int | None = None
    phase: str = 'Đang chuẩn bị'
    task: object = None
    touched: float = field(default_factory=time.monotonic)
    wake: object = field(default_factory=asyncio.Event)
    voice_limit: object = field(default_factory=lambda: asyncio.Semaphore(2))
    jobs: dict = field(default_factory=dict)

    def save(self):
        data = {
            'version': 1, 'id': self.id, 'source': self.source, 'title': self.title,
            'duration': self.duration, 'provider': self.provider, 'ducking': self.ducking,
            'playhead': self.playhead,
            'cues': None if self.cues is None else [cue.__dict__ for cue in self.cues],
            'segments': [{'index': s.index, 'duration': s.duration, 'elapsed': s.elapsed, 'cues': [cue.__dict__ for cue in s.cues]} for s in self.segments.values()],
        }
        temporary = self.root / 'session.json.tmp'
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        temporary.replace(self.root / 'session.json')

    async def prepare(self, index):
        started = time.monotonic()
        start = index * CHUNK
        length = min(CHUNK, self.duration - start)
        work = self.root / f'work-{index}'
        work.mkdir(exist_ok=True)
        original = work / 'original.mp4'
        self.phase = 'Đọc trước nguồn phim'
        if not (work / 'original.ready').exists():
            await run_ffmpeg([
            *source_options(self.source), '-ss', f'{start:.3f}', '-i', self.source,
            '-t', f'{length:.3f}', '-map', '0:v:0', '-map', '0:a:0',
            '-vf', "scale=w='min(1280,iw)':h=-2,setsar=1", '-c:v', 'libx264',
            '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '50',
            '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', original,
            ], 150)
            (work / 'original.ready').touch()
        if self.cues is None:
            self.phase = 'Nhận diện và dịch lời thoại'
            transcript = work / f"{self.ai.settings['text_model'] if hasattr(self.ai, 'settings') else 'test'}.cues.json"
            if transcript.exists():
                raw = json.loads(transcript.read_text(encoding='utf-8'))
            else:
                wav, _ = await run_ffmpeg(['-i', original, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-'])
                raw = await self.ai.transcribe(wav, length)
                validate_cues(raw, length)
                transcript.write_text(json.dumps(raw, ensure_ascii=False), encoding='utf-8')
            cues = validate_cues(raw, length, start)
        else:
            # A cue crossing a chunk boundary belongs to its start segment. Its full
            # speech is pre-rendered once and sliced consistently into both chunks.
            cues = [cue for cue in self.cues if cue.start < start + length and cue.end > start]

        self.phase = 'Tạo giọng tiếng Việt'
        async def voice(cue):
            async with self.voice_limit:
                key = __import__('hashlib').sha256(f'{cue.start}:{cue.end}:{cue.text}:{self.provider}'.encode()).hexdigest()[:24]
                path = self.root / f'voice-{key}.wav'
                meta = path.with_suffix('.json')
                if path.exists() and meta.exists():
                    return cue, path, json.loads(meta.read_text())['duration']
                if self.provider == 'gemini':
                    data, duration = await self.ai.speak(cue.text, cue.end - cue.start)
                    path.write_bytes(data)
                elif self.provider == 'local':
                    duration = await asyncio.to_thread(local_voice, cue.text, path)
                else:
                    duration = await edge_voice(cue.text, path)
                meta.write_text(json.dumps({'duration': duration}))
                return cue, path, duration

        voices = await asyncio.gather(*(voice(cue) for cue in cues), return_exceptions=True)
        for result in voices:
            if isinstance(result, BaseException):
                raise result
        self.phase = 'Ghép tiếng và kiểm tra đồng bộ'
        inputs = ['-i', original]
        filters = []
        windows = []
        for n, (cue, path, duration) in enumerate(voices, 1):
            slot = cue.end - cue.start
            ratio = max(1., duration / slot)
            if ratio > 1.8:
                raise ProviderError('Giọng đọc dài hơn khung thoại quá nhiều. Hãy rút gọn câu phụ đề hoặc đổi giọng rồi thử lại.')
            inputs += ['-i', path]
            offset = max(0., cue.start - start)
            trim = max(0., start - cue.start)
            end = min(length, cue.end - start)
            # Tempo correction preserves pitch. Slicing after correction also
            # preserves a cue that spans two video segments.
            filters.append(f'[{n}:a]{atempo_chain(ratio)},atrim=start={trim:.6f}:duration={end-offset:.6f},asetpts=PTS-STARTPTS,adelay={round(offset*1000)}:all=1[d{n}]')
            windows.append(f'between(t,{offset:.6f},{end:.6f})')
        if voices:
            enable = '+'.join(windows)
            filters.insert(0, f"[0:a]volume={self.ducking}:enable='{enable}'[original]")
            mixed = '[original]' + ''.join(f'[d{n}]' for n in range(1, len(voices) + 1))
            filters.append(f'{mixed}amix=inputs={len(voices)+1}:duration=first:normalize=0,alimiter=limit=0.95:level=0[mix]')
        else:
            filters = ['[0:a]anull[mix]']
        temporary = self.root / f'{index}.partial.ts'
        await run_ffmpeg([
            *inputs, '-filter_complex', ';'.join(filters), '-map', '0:v:0', '-map', '[mix]',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', f'{length:.3f}',
            '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-f', 'mpegts', temporary,
        ], 90)
        if temporary.stat().st_size < 1000:
            raise RuntimeError('Đoạn phim đầu ra rỗng; đã dừng trước khi phát')
        final = self.root / f'{index}.ts'
        temporary.replace(final)  # Publication is atomic: half-built media is never served.
        shutil.rmtree(work)
        return Segment(index, length, final, cues, time.monotonic() - started)

    async def worker(self):
        try:
            while True:
                if time.monotonic() - self.touched > 1800:
                    self.phase = 'Phiên đã nghỉ quá 30 phút. Mở lại phim để tiếp tục.'
                    return
                current = min(int(self.playhead // CHUNK), int((self.duration - .001) // CHUNK))
                indices = list(range(current, min(math.ceil(self.duration / CHUNK), current + LOOKAHEAD // CHUNK + 1)))
                # A seek prioritizes its new range; canceled jobs keep their partial
                # cache for a later retry but can never publish into a new timeline.
                for index in list(self.jobs):
                    if index not in indices:
                        job = self.jobs.pop(index); job.cancel()
                        await asyncio.gather(job, return_exceptions=True)
                frontier = next((i for i in indices if i not in self.segments), None)
                blocked = frontier in self.errors
                if not blocked:
                    for index in indices:
                        if index in self.errors:
                            break
                        if len(self.jobs) >= 2:
                            break
                        if index not in self.segments and index not in self.jobs:
                            self.jobs[index] = asyncio.create_task(self.prepare(index))
                self.processing = min(self.jobs) if self.jobs else None
                if not self.jobs:
                    self.phase = 'Đã dừng tại đoạn lỗi; bấm Thử lại' if blocked else 'Đã chuẩn bị đủ phần phim sắp xem'
                    self.wake.clear()
                    try:
                        await asyncio.wait_for(self.wake.wait(), 5)
                    except asyncio.TimeoutError:
                        pass
                    continue
                done, _ = await asyncio.wait(self.jobs.values(), timeout=1, return_when=asyncio.FIRST_COMPLETED)
                for index, job in list(self.jobs.items()):
                    if job not in done:
                        continue
                    self.jobs.pop(index)
                    try:
                        self.segments[index] = job.result()
                        self.prune()
                        self.save()
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        self.errors[index] = str(error) if isinstance(error, (ValueError, RuntimeError, ProviderError)) else 'Xử lý đoạn phim thất bại. Hãy thử lại.'
        finally:
            for job in self.jobs.values():
                job.cancel()
            await asyncio.gather(*self.jobs.values(), return_exceptions=True)
            self.jobs.clear()
            self.processing = None

    def prune(self):
        # Bound disk use during long films; already-appended browser media is independent.
        current = int(self.playhead // CHUNK)
        for index in list(self.segments):
            if index < current - 12 or index > current + 12:
                segment = self.segments.pop(index)
                segment.path.unlink(missing_ok=True)
        if not self.jobs and sum(path.stat().st_size for path in self.root.glob('voice-*') if path.is_file()) > 150_000_000:
            for path in self.root.glob('voice-*'):
                path.unlink(missing_ok=True)

    def status(self):
        index = min(int(self.playhead // CHUNK), math.ceil(self.duration / CHUNK) - 1)
        end = index
        while end in self.segments:
            end += 1
        return {
            'id': self.id, 'title': self.title, 'duration': self.duration, 'playhead': self.playhead,
            'chunk_seconds': CHUNK, 'ready_until': min(self.duration, end * CHUNK) if end > index else self.playhead,
            'ready': index in self.segments, 'phase': self.phase, 'processing': self.processing,
            'errors': [{'index': i, 'message': message} for i, message in sorted(self.errors.items()) if index <= i <= index + 3],
            'segments': [{'index': s.index, 'seconds': s.duration, 'processing_seconds': round(s.elapsed, 2)} for s in self.segments.values()],
            'cues': [{'start': cue.start, 'end': cue.end, 'text': cue.text} for s in self.segments.values() for cue in s.cues],
        }


SESSIONS = {}
LAUNCHES = {}


def restore_sessions():
    candidates = sorted(CACHE.glob('*/session.json'), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        if not re.fullmatch(r'[a-f0-9]{32}', path.parent.name):
            continue
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if data['version'] != 1 or data['id'] != path.parent.name or not 0 < data['duration'] <= MAX_DURATION:
                continue
            source = input_source(data['source']) if data['source'].startswith(('http://','https://','upload:')) else data['source']
            if not source.startswith(('http://','https://')) and Path(source).parent != CACHE / 'uploads':
                continue
            if not source.startswith(('http://','https://')) and not Path(source).exists():
                continue
            cues = None if data['cues'] is None else validate_cues(data['cues'],data['duration'])
            session = Session(data['id'],source,data['title'],data['duration'],cues,data['provider'],data['ducking'],data['playhead'],path.parent)
            for raw in data['segments']:
                index = int(raw['index'])
                media = path.parent / f'{index}.ts'
                if index >= 0 and media.is_file():
                    session.segments[index] = Segment(index,raw['duration'],media,validate_cues(raw['cues'],data['duration']),raw['elapsed'])
            session.phase = 'Đã khôi phục phần phim chuẩn bị trước'
            SESSIONS[session.id] = session
            return  # The product runs one active film at a time.
        except (ValueError, KeyError, TypeError, OSError):
            continue


class SessionInput(BaseModel):
    source: str = Field(max_length=8192)
    title: str = Field(default='Phim của bạn', max_length=200)
    start: float = Field(default=0, ge=0)
    subtitles: str = Field(default='', max_length=3_000_000)
    cues: list = Field(default_factory=list, max_length=20000)
    provider: str = 'local'
    ducking: float = Field(default=.18, ge=0, le=1)
    vietnamese_subtitles: bool = False


def get_session(session_id):
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, 'Phiên phim đã hết hạn; hãy mở lại phim')
    return session


@router.get('/settings')
async def settings():
    return {**public_settings(), 'local_voice_ready': local_voice_ready()}


@router.put('/settings')
async def update_settings(request: Request):
    data = await request.json()
    try:
        return save_settings(data)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/settings/check')
async def check_settings():
    try:
        await Gemini().check()
        preview = CACHE / 'voice-preview.wav'
        await asyncio.to_thread(local_voice, 'Xin chào, chúng ta cùng xem phim nhé.', preview)
        return {'ok': True, 'message': 'Đã kết nối Gemini và tạo được giọng Việt cục bộ.', 'audio_url': '/api/voice-preview.wav'}
    except ProviderError as error:
        raise HTTPException(400, str(error)) from error
    except Exception as error:
        raise HTTPException(503, 'Không tạo được giọng cục bộ. Kiểm tra đã chạy setup_voice.py và cài Piper.') from error


@router.get('/voice-preview.wav')
async def preview_voice():
    path = CACHE / 'voice-preview.wav'
    if not path.exists():
        raise HTTPException(404, 'Bấm kiểm tra key và giọng trước')
    return FileResponse(path, media_type='audio/wav', headers={'Cache-Control': 'no-store'})


@router.post('/launch')
async def launch(data: SessionInput):
    try:
        input_source(data.source)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    # No media is sent to a provider until the user starts the local player.
    token = uuid.uuid4().hex
    launch_data = data.model_dump()
    if data.title in ('Player', 'Phim của bạn'):
        matching = next((s for s in SESSIONS.values() if s.source == data.source), None)
        if matching:
            launch_data['title'] = matching.title
    LAUNCHES[token] = launch_data
    if len(LAUNCHES) > 20:
        LAUNCHES.pop(next(iter(LAUNCHES)))
    return {'url': f'http://127.0.0.1:8765/player/?launch={token}'}


@router.get('/launch/{token}')
async def read_launch(token: str):
    if token not in LAUNCHES:
        raise HTTPException(404, 'Link mở phim đã hết hạn')
    return LAUNCHES[token]


@router.post('/uploads')
async def upload(request: Request):
    directory = CACHE / 'uploads'
    directory.mkdir(exist_ok=True)
    token = uuid.uuid4().hex
    path = directory / token
    count = 0
    try:
        with path.open('wb') as output:
            async for chunk in request.stream():
                count += len(chunk)
                if count > 4_000_000_000:
                    raise HTTPException(413, 'File lớn hơn giới hạn 4 GB')
                output.write(chunk)
        if not count:
            raise HTTPException(400, 'File rỗng')
        return {'source': f'upload:{token}'}
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@router.post('/sessions')
async def create_session(data: SessionInput):
    if data.provider not in ('local', 'gemini', 'edge'):
        raise HTTPException(400, 'Nhà cung cấp giọng không hợp lệ')
    if data.provider == 'local' and not local_voice_ready():
        raise HTTPException(400, 'Chưa cài giọng tiếng Việt cục bộ. Chạy server/setup_voice.py rồi thử lại.')
    try:
        source = input_source(data.source)
        cues = parse_subtitles(data.subtitles) if data.subtitles.strip() else (validate_cues(data.cues, MAX_DURATION) if data.cues else None)
        if cues is not None and not data.vietnamese_subtitles:
            raise ValueError('Hãy dùng phụ đề tiếng Việt và xác nhận ngôn ngữ trước khi tạo giọng')
        if (cues is None or data.provider == 'gemini') and not public_settings()['key_configured']:
            raise ValueError('Cần Gemini API key cho nhận diện/dịch âm thanh hoặc giọng Gemini. Nhập key trong Cài đặt.')
        for existing in SESSIONS.values():
            profile = getattr(existing.ai, 'settings', {})
            current_profile = public_settings()
            same_models = all(profile.get(key) == current_profile.get(key) for key in ('text_model','tts_model','voice'))
            if existing.source == source and existing.provider == data.provider and existing.cues == cues and existing.ducking == data.ducking and same_models:
                if data.start >= existing.duration:
                    raise ValueError('Vị trí bắt đầu nằm ngoài phim')
                existing.playhead = data.start
                existing.title = data.title
                existing.touched = time.monotonic()
                existing.save()
                existing.wake.set()
                if not existing.task or existing.task.done():
                    existing.task = asyncio.create_task(existing.worker())
                return existing.status()
        duration = await probe_duration(source)
        if cues and any(cue.end > duration + .1 for cue in cues):
            raise ValueError('Phụ đề dài hơn phim. Hãy chọn đúng phụ đề cho bản phim này.')
        if data.start >= duration:
            raise ValueError('Vị trí bắt đầu nằm ngoài phim')
    except (ValueError, RuntimeError, asyncio.TimeoutError) as error:
        raise HTTPException(400, str(error) or 'Nguồn phim không phản hồi') from error
    # One active film avoids competing background processing and unbounded API usage.
    for old in list(SESSIONS.values()):
        if old.task:
            old.task.cancel()
            await asyncio.gather(old.task, return_exceptions=True)
        shutil.rmtree(old.root, ignore_errors=True)
        old_source = Path(old.source)
        if old.source != source and old_source.parent == CACHE / 'uploads':
            old_source.unlink(missing_ok=True)
    SESSIONS.clear()
    session_id = uuid.uuid4().hex
    root = CACHE / session_id
    root.mkdir()
    session = Session(session_id, source, data.title, duration, cues, data.provider, data.ducking, data.start, root)
    session.save()
    SESSIONS[session_id] = session
    session.task = asyncio.create_task(session.worker())
    return session.status()


@router.get('/sessions/{session_id}')
async def session_status(session_id: str):
    return get_session(session_id).status()


@router.get('/session/current')
async def current_session():
    session = next(iter(SESSIONS.values()), None)
    return session.status() if session else None


class Position(BaseModel):
    seconds: float = Field(ge=0)


@router.post('/sessions/{session_id}/position')
async def position(session_id: str, data: Position):
    session = get_session(session_id)
    if not math.isfinite(data.seconds) or data.seconds >= session.duration:
        raise HTTPException(400, 'Vị trí phát không hợp lệ')
    session.playhead = data.seconds
    session.save()
    session.touched = time.monotonic()
    session.wake.set()
    if not session.task or session.task.done():
        session.task = asyncio.create_task(session.worker())
    return session.status()


@router.post('/sessions/{session_id}/retry')
async def retry(session_id: str):
    session = get_session(session_id)
    session.errors.clear()
    session.touched = time.monotonic()
    # New settings (including a corrected key) apply after an explicit retry.
    session.ai = Gemini()
    session.wake.set()
    if not session.task or session.task.done():
        session.task = asyncio.create_task(session.worker())
    return {'ok': True}


@router.delete('/sessions/{session_id}')
async def stop_session(session_id: str):
    session = get_session(session_id)
    if session.task:
        session.task.cancel()
        await asyncio.gather(session.task, return_exceptions=True)
    SESSIONS.pop(session_id)
    shutil.rmtree(session.root, ignore_errors=True)
    uploaded = Path(session.source)
    if uploaded.parent == CACHE / 'uploads':
        uploaded.unlink(missing_ok=True)
    return {'ok': True}


@router.get('/sessions/{session_id}/playlist.m3u8')
async def playlist(session_id: str, start: int = 0):
    session = get_session(session_id)
    if start < 0 or start >= math.ceil(session.duration / CHUNK):
        raise HTTPException(400, 'Mốc playlist không hợp lệ')
    if start not in session.segments:
        raise HTTPException(425, 'Đang chuẩn bị đoạn phim này')
    lines = ['#EXTM3U', '#EXT-X-VERSION:3', f'#EXT-X-TARGETDURATION:{CHUNK + 1}', f'#EXT-X-MEDIA-SEQUENCE:{start}', '#EXT-X-PLAYLIST-TYPE:EVENT']
    index = start
    while index in session.segments:
        segment = session.segments[index]
        lines += ['#EXT-X-DISCONTINUITY', f'#EXTINF:{segment.duration:.6f},', f'segments/{index}.ts']
        index += 1
    if index * CHUNK >= session.duration:
        lines.append('#EXT-X-ENDLIST')
    return Response('\n'.join(lines) + '\n', media_type='application/vnd.apple.mpegurl', headers={'Cache-Control': 'no-store'})


@router.get('/sessions/{session_id}/segments/{index}.ts')
async def segment_file(session_id: str, index: int):
    segment = get_session(session_id).segments.get(index)
    if not segment:
        raise HTTPException(404, 'Đoạn phim chưa sẵn sàng')
    return FileResponse(segment.path, media_type='video/mp2t', headers={'Cache-Control': 'private, max-age=3600'})
