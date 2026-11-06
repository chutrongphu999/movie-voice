(function () {
  "use strict";

  if (['http://127.0.0.1:8765','http://localhost:8765'].includes(location.origin)) return;

  if (window.__movieVoiceoverLoaded) return;
  window.__movieVoiceoverLoaded = true;

  const PRESET_LABELS = {
    review_male: "🔥 Review Nam",
    review_female: "✨ Review Nữ",
    story_male: "📖 Kể Chuyện Nam",
    story_female: "🌙 Kể Chuyện Nữ",
    vtv_female: "📺 VTV Nữ",
    vtv_male: "📺 VTV Nam"
  };

  let config = {
    enabled: true,
    syncMode: true,
    preset: "review_male",
    ducking: 0.20,
    rateOffset: 0,
    pitchOffset: 0,
    ocrMode: false,
    serverUrl: "http://127.0.0.1:8765"
  };

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(config, (saved) => {
      config = { ...config, ...saved };
      updateBarUI();
      toggleOcrLoop();
    });

    chrome.storage.onChanged.addListener((changes) => {
      for (const [key, val] of Object.entries(changes)) {
        config[key] = val.newValue;
      }
      if (!config.enabled || changes.preset || changes.rateOffset || changes.pitchOffset || changes.ocrMode) stopSpeech();
      updateBarUI();
      toggleOcrLoop();
    });
  }

  let currentTtsAudio = new Audio();
  currentTtsAudio.id = "movie-voiceover-audio";
  let currentBlobUrl = null;
  let activeVideo = null;
  let baseVolume = 1.0;
  let isDucked = false;
  let fadeInterval = null;
  let restoreTimeout = null;
  let lastSpokenText = "";
  let lastSpokenTime = 0;
  let generation = 0;
  let speechQueue = [];
  let pumping = false;
  let cancelPlayback = null;
  let statusMessage = "Đang chờ phụ đề";
  let retryAfter = 0;
  let ocrCandidate = '';
  let ocrCandidateTime = 0;
  let lastSoftSubtitleAt = 0;
  let currentPlaybackItem = null;

  function isOcrSubtitle(text) {
    const clean = cleanSubtitle(text).normalize('NFC');
    if (clean.length < 2 || clean.length > 220) return false;
    if (/[\p{Script=Han}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(clean)) return false;
    if (/(?:https?:|www\.|\.(?:com|net|top|tv)\b|\d[\d\s.-]{5,}\d)/i.test(clean)) return false;
    if (/(?:techcombank|vietcombank|vietinbank|mbbank|\bbet\b|khuy[eế]n m[aã]i|n[aạ]p ti[eề]n|v[uù]ng qu[eé]t|AI OCR|review nam|đang tạo giọng)/iu.test(clean)) return false;
    const letters = (clean.match(/\p{L}/gu) || []).length;
    return letters >= 2 && letters / clean.length > 0.55;
  }

  function acceptOcrSubtitle(text, confidence, videoTime) {
    const clean = cleanSubtitle(text).normalize('NFC');
    if (confidence < 75 || !Number.isFinite(confidence) || !isOcrSubtitle(clean)) {
      ocrCandidate = '';
      return '';
    }
    const key = clean.toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]/gu, '');
    const previous = ocrCandidate.toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]/gu, '');
    if (key !== previous || videoTime - ocrCandidateTime > 2 || videoTime < ocrCandidateTime) {
      ocrCandidate = clean;
      ocrCandidateTime = videoTime;
      return '';
    }
    return clean;
  }

  function isMovieVideo(video) {
    if (!video || video.paused || video.ended || document.hidden) return false;
    if (Number.isFinite(video.duration) && video.duration < 90) return false;
    if (video.getClientRects && !video.getClientRects().length) return false;
    if (video.closest?.('.video-ad, .vast-container, .ima-ad-container')) return false;
    return true;
  }

  function hasNativeSubtitle() {
    return [...(activeVideo?.textTracks || [])].some(t => ['subtitles', 'captions'].includes(t.kind) && t.activeCues?.length);
  }

  function setStatus(message) {
    statusMessage = message;
    if (barElement) {
      barElement.title = message;
      const status = barElement.querySelector('.mv-status');
      if (status) status.textContent = message;
    }
  }

  function stopSpeech() {
    generation++;
    ocrCandidate = '';
    lastSoftSubtitleAt = 0;
    currentPlaybackItem = null;
    cancelPlayback?.();
    speechQueue = [];
    currentTtsAudio.pause();
    currentTtsAudio.removeAttribute('src');
    currentTtsAudio.load();
    if (currentBlobUrl?.startsWith('blob:')) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
    lastSpokenText = '';
    scheduleRestoreVolume(true);
    barElement?.classList.remove('speaking');
  }

  let barElement = null;
  let ocrBoxElement = null;
  let ocrInterval = null;
  let isOcrBusy = false;
  let idleTimer = null;

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message.type === 'EXTRACT_SYNC_SOURCE') {
        const videos = [...document.querySelectorAll('video')].filter(v => v.duration >= 90 || !Number.isFinite(v.duration)).sort((a,b) => (b.duration || 0) - (a.duration || 0));
        const video = videos[0];
        if (!video) { respond(null); return false; }
        let source = /^https?:/i.test(video.currentSrc) ? video.currentSrc : '';
        if (!source) {
          const params = new URL(location.href).searchParams;
          source = ['url','file','src'].map(key=>params.get(key)).find(value=>/^https?:\/\//i.test(value || '') && /\.(m3u8|mp4|webm)(?:[?#]|$)/i.test(value)) || '';
        }
        if (!source) source = [...performance.getEntriesByType('resource')].reverse().map(entry=>entry.name).find(value=>/^https?:/i.test(value)&&/\.m3u8(?:[?#]|$)/i.test(value)) || '';
        const track = [...video.textTracks].find(t=>['subtitles','captions'].includes(t.kind)&&/^vi(?:-|$)/i.test(t.language));
        const cues = track?.cues ? [...track.cues].map(c=>({start:c.startTime,end:c.endTime,text:c.text})).filter(c=>c.text) : [];
        respond(source ? {source,title:document.title||'Phim của bạn',start:video.currentTime||0,duration:video.duration||0,cues,vietnamese_subtitles:!!cues.length,provider:'local'} : null);
        return false;
      }
      if (message.type === 'PAUSE_FOR_SYNC') {
        config.enabled = false;
        stopSpeech();
        document.querySelectorAll('video').forEach(video=>video.pause());
        respond({ok:true});
        return false;
      }
      if (message.type !== 'MAP_OCR_CROP') return false;
      const frames = [...document.querySelectorAll('iframe, frame')].filter(frame => {
        try { return new URL(frame.src, location.href).href === message.childUrl; } catch { return false; }
      });
      if (frames.length !== 1) {
        respond({ ok: false, error: 'Không xác định được vùng iframe để quét phụ đề' });
        return false;
      }
      const frame = frames[0];
      const rect = frame.getBoundingClientRect();
      if (!frame.getClientRects().length || getComputedStyle(frame).visibility === 'hidden' || getComputedStyle(frame).display === 'none' || rect.width < 100 || rect.height < 100) {
        respond({ ok: false, error: 'Iframe phim đang ẩn; đã bỏ qua OCR' });
        return false;
      }
      const scaleX = rect.width / (frame.offsetWidth || rect.width);
      const scaleY = rect.height / (frame.offsetHeight || rect.height);
      const c = message.crop;
      respond({ ok: true, crop: {
        x: rect.left + (frame.clientLeft + c.x) * scaleX,
        y: rect.top + (frame.clientTop + c.y) * scaleY,
        w: c.w * scaleX, h: c.h * scaleY
      }, dpr: window.devicePixelRatio || 1 });
      return false;
    });
  }

  // Danh sách các bộ chọn phụ đề chính xác của các trình phát phim phổ biến
  const PLAYER_SUBTITLE_SELECTORS = [
    ".art-subtitle",                       // ArtPlayer (RoPhim, Motchill, KKPhim, OPhim...)
    ".jw-text-track-cue",                  // JWPlayer (Phimmoi, Subnhanh, Anime...)
    ".jw-captions",
    ".dplayer-subtitle",                   // DPlayer
    ".vjs-text-track-display",             // VideoJS
    ".vjs-text-track-cue",
    ".plyr__captions",                     // Plyr
    ".shaka-text-container",               // Shaka Player
    ".bpx-player-subtitle-panel-text",     // Bilibili
    ".player-timedtext-text-container",    // Netflix
    ".ytp-caption-window-container",       // YouTube
    ".caption-window",
    ".subtitle-text",
    ".vp-captions"
  ];

  function cleanSubtitle(text) {
    if (!text) return "";
    return text
      .replace(/<[^>]*>/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^\)]*\)/g, " ")
      .replace(/[♪♫♬♩]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isDuplicateSubtitle(a, b) {
    if (!a || !b) return false;
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (s1 === s2) return true;
    if (s1.includes(s2) || s2.includes(s1)) {
      const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
      if (ratio > 0.72) return true;
    }
    return false;
  }

  function dataUrlToBlobUrl(dataUrl) {
    try {
      const parts = dataUrl.split(",");
      const byteString = atob(parts[1]);
      const mimeString = parts[0].split(":")[1].split(";")[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });
      return URL.createObjectURL(blob);
    } catch (e) {
      return dataUrl;
    }
  }

  function smoothRampVolume(targetVol, durationMs = 250) {
    if (!activeVideo) return;
    const video = activeVideo;
    if (fadeInterval) clearInterval(fadeInterval);

    const startVol = activeVideo.volume;
    const diff = targetVol - startVol;
    if (Math.abs(diff) < 0.01) {
      activeVideo.volume = targetVol;
      return;
    }

    const steps = Math.max(5, Math.floor(durationMs / 25));
    let currentStep = 0;

    fadeInterval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;
      const nextVol = Math.max(0, Math.min(1, startVol + diff * progress));
      try {
        video.volume = nextVol;
      } catch (e) {}

      if (currentStep >= steps) {
        clearInterval(fadeInterval);
        fadeInterval = null;
      }
    }, 25);
  }

  function engageDucking() {
    if (!activeVideo) return;
    if (restoreTimeout) {
      clearTimeout(restoreTimeout);
      restoreTimeout = null;
    }
    if (!isDucked) {
      baseVolume = activeVideo.volume;
      isDucked = true;
    }
    const target = Math.max(0, Math.min(1, baseVolume * config.ducking));
    smoothRampVolume(target, 200);
  }

  function scheduleRestoreVolume(immediate = false) {
    if (!activeVideo || !isDucked) return;
    if (restoreTimeout) clearTimeout(restoreTimeout);

    if (immediate) {
      isDucked = false;
      smoothRampVolume(baseVolume, 150);
      return;
    }

    restoreTimeout = setTimeout(() => {
      if (currentTtsAudio.paused || currentTtsAudio.ended) {
        isDucked = false;
        smoothRampVolume(baseVolume, 400);
      }
    }, 650);
  }

  // Lấy âm thanh qua Background Proxy (vượt mọi rào cản HTTPS Mixed Content / CSP)
  function fetchTtsAudioSource(params) {
    return new Promise((resolve, reject) => {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          {
            type: "FETCH_TTS",
            serverUrl: config.serverUrl,
            params: params
          },
          (response) => {
            if (chrome.runtime.lastError || !response || !response.ok) {
              reject(new Error(chrome.runtime.lastError?.message || response?.error || 'Server không phản hồi'));
            } else {
              resolve(dataUrlToBlobUrl(response.audioDataUrl));
            }
          }
        );
      } else {
        const q = new URLSearchParams(params).toString();
        resolve(`${config.serverUrl}/tts?${q}`);
      }
    });
  }

  function speakSubtitle(rawText, options = {}) {
    if (config.syncMode || !config.enabled || !rawText || !isMovieVideo(activeVideo) || Date.now() < retryAfter) return;
    const clean = cleanSubtitle(rawText);
    if (!clean || clean.length < 2) return;

    const now = Date.now();
    if (isDuplicateSubtitle(clean, lastSpokenText)) {
      return;
    }
    lastSpokenText = clean;
    lastSpokenTime = now;

    const params = {
      text: clean,
      preset: config.preset,
      rate_offset: config.rateOffset,
      pitch_offset: config.pitchOffset,
      boost: 0
    };
    // Prefetch immediately, but consume in subtitle order. Never cut off a playing line.
    const item = { text: clean, generation, time: activeVideo.currentTime, expiresAt: options.expiresAt ?? activeVideo.currentTime + 3, source: null };
    item.ready = fetchTtsAudioSource(params).then(source => {
      if (item.generation !== generation || !speechQueue.includes(item)) {
        if (source.startsWith('blob:')) URL.revokeObjectURL(source);
        return;
      }
      item.source = source;
    }).catch(error => { item.error = error; });
    speechQueue.push(item);
    // Bound latency during rapid dialogue; keep the current line and two upcoming lines.
    while (speechQueue.length > 2) {
      const dropped = speechQueue.splice(1, 1)[0];
      if (dropped.source?.startsWith('blob:')) URL.revokeObjectURL(dropped.source);
    }
    pumpSpeech();
  }

  async function pumpSpeech() {
    if (pumping) return;
    pumping = true;
    try {
      while (speechQueue.length && config.enabled) {
        const item = speechQueue[0];
        const epoch = generation;
        setStatus('Đang tạo giọng…');
        await item.ready;
        if (epoch !== generation) continue;
        if (item.error) {
          setStatus(`Lỗi tạo giọng: ${item.error.message}`);
          lastSpokenText = '';
          retryAfter = Date.now() + 3000;
          speechQueue.shift();
          break;
        }
        if (!item.source || !isMovieVideo(activeVideo) || activeVideo.currentTime > item.expiresAt) {
          if (item.source?.startsWith('blob:')) URL.revokeObjectURL(item.source);
          speechQueue.shift();
          continue;
        }
        currentBlobUrl = item.source;
        currentPlaybackItem = item;
        currentTtsAudio.src = item.source;
        currentTtsAudio.playbackRate = Math.min(1.35, activeVideo.playbackRate * (speechQueue.length > 1 ? 1.12 : 1));
        try {
          await new Promise((resolve, reject) => {
            const finish = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error('Không phát được âm thanh (CSP hoặc định dạng)')); };
            const cleanup = () => {
              currentTtsAudio.removeEventListener('ended', finish);
              currentTtsAudio.removeEventListener('error', fail);
              cancelPlayback = null;
            };
            currentTtsAudio.addEventListener('ended', finish);
            cancelPlayback = finish;
            currentTtsAudio.addEventListener('error', fail);
            currentTtsAudio.play().then(() => {
              if (epoch !== generation) return;
              engageDucking();
              barElement?.classList.add('speaking');
              setStatus('Đang đọc phụ đề');
              const transcript = barElement?.querySelector('.mv-transcript');
              if (transcript) { transcript.textContent = item.text; transcript.title = item.text; }
            }).catch(error => { cleanup(); reject(error); });
          });
          if (epoch === generation) setStatus('Đang chờ phụ đề');
        } catch (error) {
          if (epoch === generation) {
            setStatus(error.name === 'NotAllowedError' ? 'Bấm vào phim rồi bật lại AI để cho phép âm thanh' : error.message);
            lastSpokenText = '';
            retryAfter = Date.now() + 3000;
          }
        } finally {
          if (item.source.startsWith('blob:')) URL.revokeObjectURL(item.source);
          if (epoch === generation) {
            currentBlobUrl = null;
            currentPlaybackItem = null;
            speechQueue.shift();
            barElement?.classList.remove('speaking');
            scheduleRestoreVolume(false);
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  // Chế độ Quét Sub Cứng (Hardsub OCR) hỗ trợ cả Cross-Origin Video
  function toggleOcrLoop() {
    ocrCandidate = '';
    if (ocrBoxElement) {
      ocrBoxElement.classList.toggle("active", Boolean(config.enabled && config.ocrMode));
    }
    if (ocrInterval) {
      clearInterval(ocrInterval);
      ocrInterval = null;
    }
    if (config.syncMode || !config.enabled || !config.ocrMode) return;
    const ocrGeneration = generation;

    const cropCanvas = document.createElement("canvas");
    const cropCtx = cropCanvas.getContext("2d");

    ocrInterval = setInterval(async () => {
      if (!isMovieVideo(activeVideo) || isOcrBusy || hasNativeSubtitle() || Date.now() - lastSoftSubtitleAt < 1600) return;
      isOcrBusy = true;
      const video = activeVideo;
      const epoch = generation;
      const startedAt = video.currentTime;

      try {
        const vw = activeVideo.videoWidth;
        const vh = activeVideo.videoHeight;

        let ocrText = "";
        let confidence = 0;
        let canvasSucceeded = false;

        // Thử cắt trực tiếp từ thẻ video trước (nhanh nhất)
        if (vw > 0 && vh > 0) {
          try {
            const sx = Math.floor(vw * 0.12);
            const sy = Math.floor(vh * 0.79);
            const sw = Math.floor(vw * 0.76);
            const sh = Math.floor(vh * 0.16);

            cropCanvas.width = sw;
            cropCanvas.height = sh;
            cropCtx.drawImage(activeVideo, sx, sy, sw, sh, 0, 0, sw, sh);
            const dataUrl = cropCanvas.toDataURL("image/jpeg", 0.75);
            canvasSucceeded = true;

            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
              ocrText = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                  { type: "DIRECT_OCR", serverUrl: config.serverUrl, image_base64: dataUrl },
                  (res) => {
                    const error = chrome.runtime.lastError?.message || (!res?.ok && res?.error);
                    if (error) setStatus(`Lỗi OCR: ${error}`);
                    confidence = res?.confidence || 0;
                    resolve(res?.ok ? res.text : '');
                  }
                );
              });
            }
          } catch (corsErr) {
            canvasSucceeded = false;
          }
        }

        // Nếu video khác tên miền chặn CORS Canvas -> dùng Background Tab Capture
        if (!canvasSucceeded && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          const rect = activeVideo.getBoundingClientRect();
          const crop = {
            x: rect.left + rect.width * 0.12,
            y: rect.top + rect.height * 0.79,
            w: rect.width * 0.76,
            h: rect.height * 0.16
          };
          ocrText = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: "CAPTURE_OCR", serverUrl: config.serverUrl, crop, dpr: window.devicePixelRatio || 1 },
              (res) => {
                const error = chrome.runtime.lastError?.message || (!res?.ok && res?.error);
                if (error) setStatus(`Lỗi OCR: ${error}`);
                confidence = res?.confidence || 0;
                resolve(res?.ok ? res.text : '');
              }
            );
          });
        }

        if (epoch !== generation || ocrGeneration !== generation || !config.ocrMode || video !== activeVideo || video.paused || Math.abs(video.currentTime - startedAt) > 3) return;
        if (hasNativeSubtitle() || Date.now() - lastSoftSubtitleAt < 1600) return;
        const confirmed = acceptOcrSubtitle(ocrText, confidence, startedAt);
        if (confirmed) {
          speakSubtitle(confirmed, { expiresAt: startedAt + 2.5 });
        }
      } catch (e) {
      } finally {
        isOcrBusy = false;
      }
    }, 350);
  }

  function attachToVideo(video) {
    if (video.__mvAttached) return;
    video.__mvAttached = true;
    if (!activeVideo || activeVideo.paused || !activeVideo.isConnected) activeVideo = video;

    if (activeVideo === video) {
      createFloatingUI(video);
      toggleOcrLoop();
    }

    video.addEventListener("pause", () => {
      if (video !== activeVideo) return;
      if (!currentTtsAudio.paused) currentTtsAudio.pause();
      scheduleRestoreVolume(true);
    });

    video.addEventListener("play", () => {
      if (activeVideo !== video) stopSpeech();
      activeVideo = video;
      createFloatingUI(video);
      toggleOcrLoop();
      if (currentTtsAudio.paused && currentTtsAudio.currentTime > 0 && !currentTtsAudio.ended) {
        currentTtsAudio.play().catch(() => {});
      }
    });

    video.addEventListener("seeking", () => {
      if (video !== activeVideo) return;
      stopSpeech();
      toggleOcrLoop();
    });
    video.addEventListener('ended', () => { if (video === activeVideo) stopSpeech(); });
    video.addEventListener('emptied', () => { if (video === activeVideo) stopSpeech(); });
    video.addEventListener('timeupdate', () => {
      if (video !== activeVideo || !currentPlaybackItem || video.currentTime <= currentPlaybackItem.expiresAt + 1) return;
      currentTtsAudio.pause();
      cancelPlayback?.();
      scheduleRestoreVolume(true);
    });

    // Tầng 1: Bắt HTML5 TextTracks
    if (video.textTracks) {
      const bindTrack = (track) => {
        if (!['subtitles', 'captions'].includes(track.kind)) return;
        if (track.mode === 'disabled') track.mode = 'hidden';
        track.addEventListener("cuechange", () => {
          if (video !== activeVideo || video.paused) return;
          const tracks = [...video.textTracks].filter(t => ['subtitles', 'captions'].includes(t.kind) && t.mode !== 'disabled');
          const selected = tracks.find(t => t.mode === 'showing') || tracks.find(t => /^vi\b/i.test(t.language)) || tracks[0];
          if (track !== selected) return;
          if (!track.activeCues || track.activeCues.length === 0) return;
          const texts = [];
          for (let i = 0; i < track.activeCues.length; i++) {
            if (track.activeCues[i].text) texts.push(track.activeCues[i].text);
          }
          if (texts.length > 0) {
            lastSoftSubtitleAt = Date.now();
            const expiresAt = Math.max(...[...track.activeCues].map(cue => cue.endTime)) + 0.25;
            speakSubtitle(texts.join(', '), { expiresAt });
          }
        });
      };
      for (let i = 0; i < video.textTracks.length; i++) {
        bindTrack(video.textTracks[i]);
      }
      video.textTracks.addEventListener("addtrack", (e) => bindTrack(e.track));
    }

    // Tầng 2: Bắt DOM Subtitle Containers
    observeDomSubtitles();
  }

  let domObserverStarted = false;
  function observeDomSubtitles() {
    if (domObserverStarted) return;
    domObserverStarted = true;

    const checkCurrentDomSubtitles = () => {
      if (!config.enabled || !activeVideo || activeVideo.paused || activeVideo.ended) return;
      if (hasNativeSubtitle()) return;
      const subtitleRoot = activeVideo.closest('.plyr, .video-js, .jwplayer, .art-video-player, .dplayer') || activeVideo.parentElement;
      if (!subtitleRoot) return;

      // 1. Kiểm tra các selector chuẩn của trình phát phim
      for (const selector of PLAYER_SUBTITLE_SELECTORS) {
        const els = subtitleRoot.querySelectorAll(selector);
        for (const el of els) {
          if (el.closest && el.closest(".movie-voiceover-bar, .mv-ocr-region")) continue;
          if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') continue;
          const txt = (el.innerText || el.textContent || "").trim();
          if (txt && txt.length >= 2 && txt.length < 350) {
            lastSoftSubtitleAt = Date.now();
            speakSubtitle(txt);
            return;
          }
        }
      }

      const hasNativeCue = [...activeVideo.textTracks].some(track => ['subtitles', 'captions'].includes(track.kind) && track.activeCues?.length);
      if (!hasNativeCue && !config.ocrMode) lastSpokenText = '';
      if (!hasNativeCue && !config.ocrMode && Date.now() - lastSpokenTime > 8000 && statusMessage === 'Đang chờ phụ đề') {
        setStatus('Chưa thấy phụ đề mềm • thử bật Sub Cứng');
      }
    };

    const observer = new MutationObserver(checkCurrentDomSubtitles);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Quét định kỳ nhẹ mỗi 300ms để không bỏ sót phụ đề trên mọi loại player
    setInterval(checkCurrentDomSubtitles, 300);
  }

  function createFloatingUI(video) {
    if (barElement?.isConnected && barElement.parentNode === video.parentElement) return;
    barElement?.remove();
    ocrBoxElement?.remove();

    const container = video.parentElement || document.body;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    ocrBoxElement = document.createElement("div");
    ocrBoxElement.className = "mv-ocr-region";
    ocrBoxElement.innerHTML = `<span class="mv-ocr-region-label">📷 Vùng quét Sub Cứng (AI OCR)</span>`;
    container.appendChild(ocrBoxElement);

    barElement = document.createElement("div");
    barElement.className = "movie-voiceover-bar";
    barElement.innerHTML = `
      <div class="mv-btn-main" title="Bật / Tắt Thuyết Minh AI">
        <span class="movie-voiceover-indicator"></span>
        <span class="movie-voiceover-text">🎙️ BẬT</span>
      </div>
      <button class="mv-ocr-btn" title="Bật quét chữ trực tiếp trên hình cho web dùng Sub Cứng">📷 Sub Cứng</button>
      <span class="mv-status" role="status"></span>
      <span class="mv-transcript" title="Phụ đề đang đọc"></span>
    `;

    const mainBtn = barElement.querySelector(".mv-btn-main");
    const ocrBtn = barElement.querySelector(".mv-ocr-btn");

    mainBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (config.syncMode) {
        setStatus('Đang mở player đồng bộ…');
        chrome.runtime.sendMessage({type:'OPEN_SYNC_PLAYER'}, response => {
          if (chrome.runtime.lastError || !response?.ok) setStatus(response?.error || 'Không mở được player. Kiểm tra server.');
        });
        return;
      }
      config.enabled = !config.enabled;
      saveConfig({ enabled: config.enabled });
      if (!config.enabled) {
        stopSpeech();
      }
      updateBarUI();
      toggleOcrLoop();
    });

    ocrBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      config.ocrMode = !config.ocrMode;
      stopSpeech();
      saveConfig({ ocrMode: config.ocrMode });
      updateBarUI();
      toggleOcrLoop();
    });

    container.addEventListener("mousemove", () => {
      barElement.classList.remove("idle-fade");
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (config.enabled) barElement.classList.add("idle-fade");
      }, 3500);
    });

    container.appendChild(barElement);
    updateBarUI();
    setStatus(statusMessage);
  }

  function saveConfig(partial) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set(partial);
    }
  }

  function updateBarUI() {
    if (!barElement) return;
    const textSpan = barElement.querySelector(".movie-voiceover-text");
    const ocrBtn = barElement.querySelector(".mv-ocr-btn");
    const presetLabel = PRESET_LABELS[config.preset] || "Review";
    if (config.syncMode) {
      if (textSpan) textSpan.innerText = '🎬 Mở player đồng bộ';
      if (ocrBtn) ocrBtn.hidden = true;
      setStatus('Xử lý trước lời thoại • chia sẻ âm thanh qua Meet');
      return;
    }

    if (config.enabled) {
      barElement.classList.remove("disabled");
      if (textSpan) textSpan.innerText = `🎙️ ${presetLabel}`;
    } else {
      barElement.classList.add("disabled");
      if (textSpan) textSpan.innerText = "🎙️ TẮT";
    }

    if (ocrBtn) {
      ocrBtn.classList.toggle("active", Boolean(config.ocrMode));
    }
  }

  function scanVideos() {
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      attachToVideo(v);
    }
  }

  scanVideos();
  const videoScanner = new MutationObserver(() => scanVideos());
  videoScanner.observe(document.documentElement, { childList: true, subtree: true });
})();
