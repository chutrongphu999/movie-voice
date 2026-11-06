import asyncio
import math
import struct
import sys
import tempfile
import unittest
import wave
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from vod import Cue, Session, parse_subtitles, validate_cues, run_ffmpeg, probe_duration, input_source, atempo_chain
from gemini_provider import Gemini, ProviderError


def tone(seconds=4, frequency=880):
    output = BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
        audio.writeframes(b''.join(struct.pack('<h', round(8000 * math.sin(2 * math.pi * frequency * n / 24000))) for n in range(round(seconds * 24000))))
    return output.getvalue()


class FakeGemini:
    def __init__(self, seconds=4, cues=None):
        self.seconds = seconds
        self.cues = cues or []
        self.calls = 0

    async def speak(self, text, duration):
        self.calls += 1
        return tone(self.seconds), self.seconds

    async def transcribe(self, audio, duration):
        return self.cues


def projection(raw, start, end, frequency):
    values = struct.unpack('<' + 'h' * (len(raw)//2), raw)
    a, b = round(start*24000), round(end*24000)
    return abs(sum(values[n] * math.sin(2*math.pi*frequency*n/24000) for n in range(a, min(b,len(values))))) * 2 / (b-a)


class ValidationTests(unittest.TestCase):
    def test_srt_vtt_unicode_and_multiline(self):
        cues = parse_subtitles('1\n00:00:01,000 --> 00:00:03,500\n<i>Xin chào</i>\ncác bạn.\n\n2\n00:00:18,000 --> 00:00:22,000\nCâu đi qua hai đoạn.\n')
        self.assertEqual(cues[0], Cue(1,3.5,'Xin chào các bạn.'))
        self.assertEqual(cues[1].end,22)
        self.assertEqual(parse_subtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:center\nChào bạn.')[0].start,1)

    def test_invalid_timestamps_and_overlapping_speech_are_rejected(self):
        for raw in [
            [{'start':-1,'end':2,'text':'bad'}],
            [{'start':0,'end':float('nan'),'text':'bad'}],
            [{'start':1,'end':3,'text':'a'},{'start':2,'end':4,'text':'b'}],
            [{'start':1,'end':21,'text':'outside'}],
        ]:
            with self.assertRaises(ValueError): validate_cues(raw,20)

    def test_upload_traversal_and_credential_urls_are_rejected(self):
        for source in ['file:///C:/Windows/win.ini','upload:../../data','https://user:pass@example.com/movie.mp4']:
            with self.assertRaises(ValueError): input_source(source)

    def test_audio_tempo_uses_preserving_filters(self):
        self.assertEqual(atempo_chain(4),'atempo=2,atempo=2.00000000')


class RenderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.mp4'
        await run_ffmpeg(['-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=24','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=24','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',self.source])

    async def asyncTearDown(self):
        self.temp.cleanup()

    def make_session(self, cues, fake=None):
        root = self.root / 'session'; root.mkdir(exist_ok=True)
        return Session('test',str(self.source),'Fixture',24,cues,'gemini',.18,0,root,ai=fake or FakeGemini())

    async def test_pre_muxed_audio_is_on_time_and_boundary_cue_is_not_repeated(self):
        fake = FakeGemini()
        session = self.make_session([Cue(18,22,'Câu đi qua hai đoạn.')], fake)
        first = await session.prepare(0)
        second = await session.prepare(1)
        self.assertEqual(fake.calls,1,'cross-boundary cue must reuse the exact same speech')
        self.assertAlmostEqual(await probe_duration(str(first.path)),20,delta=.15)
        self.assertAlmostEqual(await probe_duration(str(second.path)),4,delta=.15)
        a,_ = await run_ffmpeg(['-i',first.path,'-vn','-ar','24000','-ac','1','-f','s16le','-'])
        b,_ = await run_ffmpeg(['-i',second.path,'-vn','-ar','24000','-ac','1','-f','s16le','-'])
        self.assertLess(projection(a,16,17,880),100)
        self.assertGreater(projection(a,18.5,19.5,880),2000)
        self.assertGreater(projection(b,.5,1.5,880),2000)
        self.assertLess(projection(b,2.5,3.5,880),100)
        self.assertFalse(list(session.root.glob('*.partial.ts')))

    async def test_provider_failure_does_not_publish_unvoiced_video(self):
        fake = FakeGemini(seconds=8)
        session = self.make_session([Cue(1,2,'Too long')],fake)
        with self.assertRaisesRegex(ProviderError,'dài hơn'):
            await session.prepare(0)
        self.assertFalse((session.root/'0.ts').exists())
        self.assertFalse(session.segments)

    async def test_silence_is_preserved_without_invented_speech(self):
        fake = FakeGemini(cues=[])
        session = self.make_session(None,fake)
        segment = await session.prepare(1)
        self.assertEqual(fake.calls,0)
        self.assertEqual(segment.cues,[])

    async def test_worker_primes_new_seek_target_without_publishing_old_range_as_ready(self):
        session = self.make_session([])
        session.playhead = 21
        session.task = asyncio.create_task(session.worker())
        try:
            for _ in range(100):
                if 1 in session.segments: break
                await asyncio.sleep(.05)
            self.assertTrue(session.status()['ready'])
            self.assertEqual(session.status()['ready_until'],24)
            self.assertNotIn(0,session.segments)
        finally:
            session.task.cancel(); await asyncio.gather(session.task,return_exceptions=True)

    async def test_two_lookahead_segments_can_progress_concurrently(self):
        gate=asyncio.Event()
        class GatedVoice(FakeGemini):
            async def speak(self,text,duration):
                self.calls+=1
                if self.calls==2:gate.set()
                await asyncio.wait_for(gate.wait(),3)
                return tone(1),1
        fake=GatedVoice()
        session=self.make_session([Cue(2,3,'First'),Cue(22,23,'Second')],fake)
        session.task=asyncio.create_task(session.worker())
        try:
            for _ in range(120):
                if len(session.segments)==2 or session.errors:break
                await asyncio.sleep(.05)
            self.assertEqual(session.errors,{})
            self.assertEqual(len(session.segments),2)
        finally:
            session.task.cancel();await asyncio.gather(session.task,return_exceptions=True)

    async def test_prepared_media_restores_without_recalling_ai(self):
        import vod,uuid,shutil
        cache=self.root/'cache';cache.mkdir()
        uploads=cache/'uploads';uploads.mkdir()
        upload=uploads/uuid.uuid4().hex;shutil.copyfile(self.source,upload)
        token=uuid.uuid4().hex;root=cache/token;root.mkdir()
        session=Session(token,str(upload),'Resume',24,[],'local',.18,21,root,ai=FakeGemini())
        segment=await session.prepare(1);session.segments[1]=segment;session.save()
        registry={}
        with patch.object(vod,'CACHE',cache),patch.object(vod,'SESSIONS',registry):
            vod.restore_sessions()
        restored=registry[token]
        self.assertIsNone(restored.task,'restoring must not start paid processing')
        self.assertTrue(restored.status()['ready'])
        self.assertEqual(restored.playhead,21)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_malformed_transcript_fails_closed(self):
        model = Gemini({'api_key':'not-a-real-key','text_model':'test','tts_model':'test','voice':'Kore'})
        async def generate(*args): return {'candidates':[{'content':{'parts':[{'text':'not JSON'}]}}]}
        with patch.object(model,'generate',generate):
            with self.assertRaises(ProviderError): await model.transcribe(b'wav',20)

    async def test_pcm_metadata_controls_wav_rate(self):
        import base64
        model = Gemini({'api_key':'not-a-real-key','text_model':'test','tts_model':'test','voice':'Kore'})
        async def generate(*args): return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'audio/L16;rate=24000','data':base64.b64encode(bytes(48000)).decode()}}]}}]}
        with patch.object(model,'generate',generate):
            data,duration = await model.speak('test',1)
        self.assertEqual(duration,1)
        with wave.open(BytesIO(data)) as audio: self.assertEqual(audio.getframerate(),24000)


if __name__=='__main__': unittest.main(verbosity=2)
