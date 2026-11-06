const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { Blob } = require('buffer');

function setup() {
  const requests = [], played = [], revoked = [];
  class Audio extends EventTarget {
    constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; }
    play() { this.paused = false; this.ended = false; played.push(this.src); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
    finish() { this.paused = true; this.ended = true; this.dispatchEvent(new Event('ended')); }
  }
  const context = {
    Audio, Event, console, URLSearchParams, Uint8Array, ArrayBuffer, Blob,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    URL: { createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL: url => revoked.push(url) },
    window: {}, location: {origin:'https://fixture.test'}, document: { querySelectorAll: () => [], documentElement: {} },
    MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: (msg, callback) => requests.push({msg, callback}) } },
  };
  let source = fs.readFileSync('extension/content.js', 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, `config.syncMode = false; window.test = {
    speakSubtitle, stopSpeech, isOcrSubtitle, acceptOcrSubtitle, audio: currentTtsAudio,
    setVideo(video) { activeVideo = video; },
    get queue() { return speechQueue; }, get status() { return statusMessage; }
  };})();`);
  vm.runInNewContext(source, context);
  const api = context.window.test;
  const video = { paused: false, ended: false, currentTime: 10, playbackRate: 1, volume: 0 };
  api.setVideo(video);
  return {api, video, requests, played, revoked};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const respond = req => req.callback({ok:true, audioDataUrl:'data:audio/mpeg;base64,YQ=='});

(async () => {
  {
    const {api} = setup();
    assert(!api.isOcrSubtitle('19032749675012 - Techcombank'));
    assert(!api.isOcrSubtitle('9922.com'));
    assert(!api.isOcrSubtitle('Vùng quét Sub Cứng AI OCR'));
    assert(!api.isOcrSubtitle('Hρ bn các nhà báo δ phía thủ đô.'));
    assert(api.isOcrSubtitle('Họ bắn các nhà báo ở phía thủ đô.'));
    assert.equal(api.acceptOcrSubtitle('Họ bắn các nhà báo.',96,10),'');
    assert.equal(api.acceptOcrSubtitle('Họ bắn các nhà báo.',96,10.4),'Họ bắn các nhà báo.');
    assert.equal(api.acceptOcrSubtitle('Câu khác hoàn toàn.',96,10.8),'');
    assert.equal(api.acceptOcrSubtitle('Câu khác hoàn toàn.',42,11.2),'');
  }
  {
    const {api, requests, video, played} = setup();
    api.speakSubtitle('Câu tải quá chậm');
    video.currentTime += 4;
    respond(requests[0]); await flush();
    assert.equal(played.length,0,'outdated line must not be spoken after scene changes');
    video.duration = 30;
    api.speakSubtitle('Lời thoại quảng cáo');
    assert.equal(requests.length,1,'short advertisement video must not be dubbed');
  }
  {
    const {api, requests, played} = setup();
    api.speakSubtitle('Câu thứ nhất'); api.speakSubtitle('Câu thứ hai');
    respond(requests[1]); await flush();
    assert.equal(played.length, 0, 'later response must wait for earlier subtitle');
    respond(requests[0]); await flush();
    assert.equal(played.length, 1);
    assert.equal(api.audio.paused, false, 'new cue must not cut off current speech');
    api.audio.finish(); await flush();
    assert.equal(played.length, 2, 'next cue plays only after current cue ends');
    api.audio.finish(); await flush();
  }
  {
    const {api, requests, played, revoked} = setup();
    api.speakSubtitle('Lời thoại cũ'); api.stopSpeech();
    respond(requests[0]); await flush();
    assert.equal(played.length, 0, 'seek/disable must invalidate in-flight response');
    assert.equal(revoked.length, 1, 'stale blob must be released');
    api.speakSubtitle('Lời thoại mới'); respond(requests[1]); await flush();
    assert.equal(played.length, 1);
    api.stopSpeech(); await flush();
    assert.equal(api.queue.length, 0);
  }
  {
    const {api, requests, video, played} = setup();
    api.speakSubtitle('Câu đang hiện'); api.speakSubtitle('Câu đang hiện');
    assert.equal(requests.length, 1, 'DOM polling must not repeat a static subtitle');
    video.paused = true; respond(requests[0]); await flush();
    assert.equal(played.length, 0, 'pending request must not start audio while movie is paused');
  }
  {
    const {api, requests} = setup();
    api.speakSubtitle('Thử khi mất server');
    requests[0].callback({ok:false,error:'Connection refused'}); await flush();
    assert(api.status.includes('Connection refused'), 'server failures must be visible');
    api.speakSubtitle('Thử khi mất server');
    assert.equal(requests.length, 1, 'failure must back off instead of hammering server');
  }
  console.log('PASS: ordered playback, no interruption, seek cancellation, blob cleanup, pause, deduplication, visible errors/backoff');
})().catch(error => { console.error(error); process.exitCode = 1; });
