"""Create a deterministic local video with Vietnamese cues for browser smoke tests."""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from vod import FFMPEG, CACHE

fixture = CACHE/'sync-demo.mp4'
subprocess.run([FFMPEG,'-hide_banner','-nostdin','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=25:duration=26','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=26','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(fixture)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def post(path,data,raw=False):
    request=urllib.request.Request('http://127.0.0.1:8765/api'+path,data=data if raw else json.dumps(data).encode(),headers={'Content-Type':'application/octet-stream' if raw else 'application/json'})
    return json.load(urllib.request.urlopen(request,timeout=60))

source=post('/uploads',fixture.read_bytes(),True)['source']
launch=post('/launch',{'source':source,'title':'Kiểm tra đồng bộ · giọng Việt trong video','provider':'edge','cues':[{'start':2,'end':5,'text':'Xin chào các bạn.'},{'start':18,'end':22,'text':'Xin chào các bạn.'}],'vietnamese_subtitles':True})
print(launch['url'])
