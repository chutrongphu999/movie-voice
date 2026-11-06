/* Audio is mixed into each video segment on the server: a single media clock. */
const $ = id => document.getElementById(id);
const movie = $('movie');
let session = null, hls = null, base = 0, revision = 0, loadedRevision = -1;
let wantedPlaying = false, seeking = false, polling = false, uploading = false;
let subtitleText = '', launchCues = [], lastPositionSent = 0;
const launchToken = () => new URLSearchParams(location.search).get('launch') || new URLSearchParams(location.hash.slice(1)).get('launch') || '';
const instanceToken=crypto.randomUUID();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('movie-voice-playback') : null;
if(channel)channel.onmessage=event=>{if(event.data?.type==='playing'&&event.data.instance!==instanceToken){wantedPlaying=false;movie.pause();}};

function formatTime(value) {
  value = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(value / 3600), m = Math.floor(value / 60) % 60, s = value % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function parseTime(value) {
  if (!/^\d+:\d{2}$/.test(value) || Number(value.split(':')[1]) > 59) throw Error('Vị trí bắt đầu cần có dạng phút:giây, ví dụ 12:30.');
  const [m,s] = value.split(':').map(Number); return m * 60 + s;
}
async function api(path, options = {}) {
  const response = await fetch('/api' + path, {cache:'no-store', ...options, headers:{...(options.body && !(options.body instanceof Blob) ? {'Content-Type':'application/json'} : {}), ...options.headers}});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(typeof result.detail === 'string' ? result.detail : `Yêu cầu thất bại (${response.status}).`);
  return result;
}
const post = (path, body = {}) => api(path, {method:'POST', body:JSON.stringify(body)});
function overlay(title, message, play = false) {
  $('overlay').hidden = false; $('overlayTitle').textContent = title; $('overlayText').textContent = message;
  $('playButton').hidden = !play; $('overlay').querySelector('.loader').hidden = play;
}
async function settings() {
  const value = await api('/settings');
  $('textModel').value = value.text_model; $('ttsModel').value = value.tts_model; $('voice').value = value.voice;
  $('keyNote').textContent = value.key_configured ? 'Gemini đã có key. Phim không có SRT sẽ được nhận diện và dịch từ âm thanh.' : 'Chưa có Gemini API key. Mở Cài đặt Gemini để nhập key. Hoặc dùng SRT tiếng Việt + giọng Edge để thử player.';
  return value;
}
$('settingsButton').onclick = () => $('settingsDialog').showModal();
$('closeSettings').onclick = () => $('settingsDialog').close();
$('settingsForm').onsubmit = async event => {
  event.preventDefault(); $('settingsStatus').textContent = 'Đang lưu…';
  try {
    await api('/settings', {method:'PUT',body:JSON.stringify({api_key:$('apiKey').value,text_model:$('textModel').value.trim(),tts_model:$('ttsModel').value.trim(),voice:$('voice').value})});
    $('apiKey').value = ''; await settings(); $('settingsStatus').textContent = 'Đã lưu trên máy này.';
  } catch(error) { $('settingsStatus').textContent = error.message; }
};
$('checkKey').onclick = async () => {
  $('checkKey').disabled = true; $('settingsStatus').textContent = 'Đang kiểm tra key đã lưu…';
  try { const result = await post('/settings/check'); $('settingsStatus').textContent = result.message; if(result.audio_url){$('voicePreview').src=result.audio_url+'?t='+Date.now();$('voicePreview').hidden=false;} }
  catch(error) { $('settingsStatus').textContent = error.message; }
  finally { $('checkKey').disabled = false; }
};
$('videoFile').onchange = () => {
  const file = $('videoFile').files[0];
  $('fileName').textContent = file?.name || 'Chưa chọn file';
  if (file) { $('source').value = ''; $('title').value = file.name.replace(/\.[^.]+$/, ''); }
};
$('subtitleFile').onchange = async () => {
  const file = $('subtitleFile').files[0]; subtitleText = file ? await file.text() : '';
  launchCues = []; $('subtitleName').textContent = file?.name || '';
};
$('source').oninput = () => { if ($('source').value) { $('videoFile').value = ''; $('fileName').textContent = 'Chưa chọn file'; } };
$('startForm').onsubmit = async event => {
  event.preventDefault(); if (uploading) return;
  $('setupError').textContent = ''; $('startButton').disabled = true; uploading = true;
  try {
    let source = $('source').value.trim(); const file = $('videoFile').files[0];
    if (file) { $('startButton').textContent = 'Đang mở file cục bộ…'; source = (await api('/uploads',{method:'POST',body:file})).source; }
    if (!source) throw Error('Dán link MP4/HLS hoặc chọn video trên máy. Link trang xem phim cần mở từ tiện ích.');
    $('startButton').textContent = 'Đang kiểm tra nguồn phim…';
    const result = await post('/sessions', {source,title:$('title').value,start:parseTime($('startAt').value),subtitles:subtitleText,cues:launchCues,vietnamese_subtitles:$('vietnamese').checked,provider:$('provider').value,ducking:Number($('ducking').value)});
    begin(result);
  } catch(error) { $('setupError').textContent = error.message; }
  finally { uploading = false; $('startButton').disabled = false; $('startButton').textContent = 'Chuẩn bị & mở phim'; }
};
function destroyMedia() {
  if (hls) { hls.destroy(); hls = null; }
  movie.pause(); movie.removeAttribute('src'); movie.load(); loadedRevision = -1;
}
function begin(value) {
  session = value; revision++; base = Math.floor(value.playhead / value.chunk_seconds) * value.chunk_seconds;
  wantedPlaying = false; $('setup').hidden = true; $('watch').hidden = false;
  $('movieTitle').textContent = value.title; $('duration').textContent = formatTime(value.duration); $('seek').max = value.duration - .1;
  $('seek').value = value.playhead; $('time').textContent = formatTime(value.playhead); $('playError').textContent = '';
  localStorage.setItem('movie-voice-session', value.id);
  localStorage.setItem('movie-voice-launch', launchToken());
  overlay('Đang chuẩn bị phần phim sắp xem', 'Đọc trước nguồn phim, tạo giọng Việt và ghép đồng bộ. Chỉ phát khi cả hình và giọng đã sẵn sàng.');
  if (!polling) poll();
}
async function loadMedia() {
  if (!session || loadedRevision === revision) return;
  const minimumLead = Math.min(20, session.duration - session.playhead);
  if (session.ready_until - session.playhead < minimumLead - .1) return;
  const epoch = revision, id = session.id, at = Math.max(0, session.playhead - base);
  loadedRevision = epoch;
  const url = `/api/sessions/${id}/playlist.m3u8?start=${Math.floor(base/session.chunk_seconds)}`;
  const ready = () => {
    if (epoch !== revision || session?.id !== id) return;
    if (at > .1) movie.currentTime = at;
    overlay('Phim đã sẵn sàng', 'Giọng Việt đã được ghép vào âm thanh của phim.', true);
    if (wantedPlaying) void play();
  };
  if (window.Hls?.isSupported()) {
    hls = new Hls({startPosition:at,maxBufferLength:60,backBufferLength:90,liveSyncDurationCount:100000,liveMaxLatencyDurationCount:100001,enableWorker:true});
    hls.on(Hls.Events.MANIFEST_PARSED,ready);
    hls.on(Hls.Events.ERROR,(_event,data) => {
      if (epoch !== revision || !data.fatal) return;
      movie.pause(); $('playError').textContent = 'Luồng phim bị gián đoạn. Bấm Thử lại để nạp lại đúng vị trí hiện tại.';
      $('retryButton').hidden = false; overlay('Đã giữ vị trí phim', 'Đang chờ luồng hình và tiếng sẵn sàng trở lại.');
    });
    hls.loadSource(url); hls.attachMedia(movie);
  } else if (movie.canPlayType('application/vnd.apple.mpegurl')) {
    movie.src = url; movie.addEventListener('loadedmetadata',ready,{once:true});
  } else {
    $('playError').textContent = 'Trình duyệt không hỗ trợ player HLS. Hãy mở bằng Chrome hoặc Edge mới.';
  }
}
async function play() {
  wantedPlaying = true;
  if (!session?.ready || loadedRevision !== revision) return;
  try {
    session=await post(`/sessions/${session.id}/position`,{seconds:Math.min(session.duration-.1,base+(movie.currentTime||0))});
    await movie.play(); $('overlay').hidden = true;
  }
  catch { overlay('Bấm phát để bắt đầu', 'Trình duyệt cần một lần bấm để cho phép âm thanh.',true); }
}
$('playButton').onclick = play;
$('togglePlay').onclick = () => { if (movie.paused) play(); else { wantedPlaying=false; movie.pause(); } };
movie.onplay = () => { channel?.postMessage({type:'playing',instance:instanceToken}); wantedPlaying=true; $('overlay').hidden=true; $('togglePlay').textContent='Ⅱ Tạm dừng'; };
movie.onpause = () => { if(!seeking)wantedPlaying=false; $('togglePlay').textContent='▶ Phát'; };
movie.onwaiting = () => { if (wantedPlaying && session) overlay('Đang chuẩn bị đoạn tiếp theo', 'Hình và tiếng cùng dừng để giữ đúng đồng bộ. Player sẽ tiếp tục khi đoạn đã xử lý xong.'); };
movie.onplaying = () => { $('overlay').hidden = true; };
movie.onended = () => { if (base+movie.currentTime >= (session?.duration||0)-.5) {wantedPlaying=false;overlay('Đã xem hết phim','Bạn có thể tua lại hoặc mở phim khác.');} };
$('fullscreen').onclick = () => {
  const toggle = document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen();
  toggle.catch(()=>{});
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'Thoát toàn màn hình':'Toàn màn hình';});
$('volume').oninput = () => { movie.volume=Number($('volume').value); };
movie.onclick = () => { if(movie.paused)play();else{wantedPlaying=false;movie.pause();} };
async function seek(seconds) {
  if (!session) return;
  const id = session.id, resume = wantedPlaying; revision++; const epoch=revision;
  seeking=true; destroyMedia(); $('caption').textContent='';
  base=Math.floor(seconds/session.chunk_seconds)*session.chunk_seconds;
  overlay('Đang chuẩn bị vị trí vừa tua', 'Những câu ở cảnh cũ sẽ không được phát sang cảnh mới.');
  try {
    const result=await post(`/sessions/${id}/position`,{seconds});
    if (epoch!==revision||session?.id!==id)return;
    session=result; wantedPlaying=resume; $('seek').value=seconds; $('time').textContent=formatTime(seconds);
  } catch(error) { $('playError').textContent=error.message; }
  finally { if(epoch===revision)seeking=false; }
}
$('seek').onchange = () => seek(Number($('seek').value));
$('seek').oninput = () => { $('time').textContent=formatTime($('seek').value); };
$('retryButton').onclick = async () => {
  if(!session)return;
  try { await post(`/sessions/${session.id}/retry`); $('playError').textContent=''; await seek(Math.min(session.duration-.1,base+(movie.currentTime||0))); }
  catch(error) { $('playError').textContent=error.message; }
};
$('stopButton').onclick = async () => {
  const id=session?.id; revision++; session=null; wantedPlaying=false; destroyMedia(); localStorage.removeItem('movie-voice-session');
  localStorage.removeItem('movie-voice-launch');
  $('watch').hidden=true; $('setup').hidden=false;
  if(id) await api(`/sessions/${id}`,{method:'DELETE'}).catch(()=>{});
};
movie.ontimeupdate = () => {
  if(!session||seeking)return;
  const absolute=Math.min(session.duration,base+movie.currentTime);
  $('time').textContent=formatTime(absolute); $('seek').value=absolute;
  const cues=session.cues.filter(cue=>cue.start<=absolute&&cue.end>absolute);
  $('caption').textContent=$('showCaptions').checked?[...new Set(cues.map(c=>c.text))].join('\n'):'';
};
async function poll() {
  polling=true;
  while(session) {
    const id=session.id,epoch=revision;
    try {
      if(!seeking&&!movie.paused&&loadedRevision===revision&&Date.now()-lastPositionSent>4000) {
        lastPositionSent=Date.now();
        await post(`/sessions/${id}/position`,{seconds:Math.min(session.duration-.1,base+(movie.currentTime||0))});
      }
      const value=await api(`/sessions/${id}`);
      if(epoch!==revision||session?.id!==id)continue;
      session=value;
      if($('playError').dataset.network==='true') { $('playError').textContent='';delete $('playError').dataset.network; }
      const ahead=Math.max(0,value.ready_until-value.playhead);
      $('phase').textContent=value.phase; $('bufferBadge').textContent=`Đã chuẩn bị trước ${Math.floor(ahead)} giây`;
      const speeds=value.segments.map(s=>s.processing_seconds/s.seconds);
      const average=speeds.length?speeds.reduce((a,b)=>a+b)/speeds.length:0;
      $('progressText').textContent=average/2>1?'Xử lý đang chậm hơn tốc độ xem. Player sẽ giữ đồng bộ và chờ khi cần.':`Đọc trước khoảng 60 giây · ${value.segments.length} đoạn đã sẵn sàng`;
      $('retryButton').hidden=!value.errors.length&&!$('playError').textContent;
      if(value.errors.length) { $('playError').textContent=value.errors[0].message;$('playError').dataset.backend='true'; }
      else if($('playError').dataset.backend==='true') { $('playError').textContent='';delete $('playError').dataset.backend; }
      if(value.ready&&!seeking) await loadMedia();
    } catch(error) { if(epoch===revision) {$('playError').textContent=error.message==='Failed to fetch'?'Mất kết nối server. Đang thử kết nối lại…':error.message;$('playError').dataset.network='true';$('retryButton').hidden=false;} }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  polling=false;
}
(async()=>{
  try {
    await settings();
    const launch=launchToken();
    const resumeId=localStorage.getItem('movie-voice-session');
    if(resumeId && (!localStorage.getItem('movie-voice-launch') || localStorage.getItem('movie-voice-launch')===(launch||''))) {
      try {begin(await api(`/sessions/${resumeId}`));return;}catch{localStorage.removeItem('movie-voice-session');}
    }
    if(launch) {
      const value=await api(`/launch/${encodeURIComponent(launch)}`);
      $('source').value=value.source; $('title').value=value.title; $('startAt').value=`${Math.floor(value.start/60)}:${String(Math.floor(value.start%60)).padStart(2,'0')}`;
      launchCues=value.cues||[]; $('vietnamese').checked=value.vietnamese_subtitles;
      if(value.provider)$('provider').value=value.provider;
      if(value.subtitles)subtitleText=value.subtitles;
      if(value.ducking!==undefined)$('ducking').value=String(value.ducking);
      if(launchCues.length)$('subtitleName').textContent=`${launchCues.length} câu từ trình phát`;
    } else {
      const active=await api('/session/current');
      if(active)begin(active);
    }
  }catch(error){$('setupError').textContent=error.message;}
})();
