// Movie Voice - In-Page Web Audio Dubbing Player & Draggable Subtitle Banner
// Combines the Zero-Drift Time-Stretching from LocalDub with the Draggable Subtitle Bar & Sync from real-time-video-subs (rtsubs).
(function () {
  "use strict";

  if (window.__movieVoicePlayerLoaded) return;
  window.__movieVoicePlayerLoaded = true;

  const ENGINE_URL = "http://127.0.0.1:8765";
  const TICK_MS = 50;

  let config = {
    enabled: true,
    voice: "vi-VN-HoaiMyNeural",
    ducking: 0.20,
    rate: 0,
    pitch: 0
  };

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(config, (saved) => {
      config = { ...config, ...saved };
      updateUI();
    });
    chrome.storage.onChanged.addListener((changes) => {
      for (const [key, val] of Object.entries(changes)) {
        config[key] = val.newValue;
      }
      if (!config.enabled) stopAllSpeech(true);
      updateUI();
    });
  }

  function extractMovieTitle() {
    try {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content && og.content.trim().length > 3) return og.content.trim();
      const h1 = document.querySelector("h1");
      if (h1 && h1.textContent && h1.textContent.trim().length > 2) return h1.textContent.trim();
      if (document.title && !/^(player|embed|video|iframe)$/i.test(document.title.trim())) {
        return document.title.trim();
      }
    } catch (e) {}
    return "";
  }

  function sendClientLog(event, detail) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "CLIENT_LOG", event, detail }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch (e) {}
  }

  // AudioContext for low-latency playback (exempt from page media-src CSP)
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Unlock AudioContext on any user interaction in the frame
  ["click", "pointerdown", "keydown", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, () => getAudioContext(), { passive: true, capture: true });
  });

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 0x8000;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes.buffer;
  }

  let activeVideo = null;
  let cueQueue = [];
  let subtitleHistory = [];
  let seenCueKeys = new Set();
  let isSpeaking = false;
  let activeCueSlotEnd = 0;
  let activeSpeakingText = "";
  let currentSourceNode = null;
  let fallbackAudioEl = new Audio();
  fallbackAudioEl.preservesPitch = true;
  let isDucked = false;
  let baseVideoVolume = 1.0;
  let fadeInterval = null;
  let restoreTimeout = null;
  let inFlightUploads = 0;
  let seekGeneration = 0;
  let pendingMseBatches = [];
  let hasSoftSubtitles = false;

  // Smart Ducking: smoothly lowers and restores original video volume
  function rampVideoVolume(targetVolume, durationMs = 160) {
    if (!activeVideo) return;
    if (fadeInterval) clearInterval(fadeInterval);

    const startVol = activeVideo.volume;
    const diff = targetVolume - startVol;
    if (Math.abs(diff) < 0.01) {
      activeVideo.volume = targetVolume;
      return;
    }

    const steps = 8;
    const stepTime = Math.max(15, durationMs / steps);
    let currentStep = 0;

    fadeInterval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;
      try {
        activeVideo.volume = Math.max(0, Math.min(1, startVol + diff * progress));
      } catch (e) {}

      if (currentStep >= steps) {
        clearInterval(fadeInterval);
        fadeInterval = null;
      }
    }, stepTime);
  }

  function applyDucking() {
    if (!activeVideo) return;
    if (restoreTimeout) {
      clearTimeout(restoreTimeout);
      restoreTimeout = null;
    }
    if (!isDucked) {
      baseVideoVolume = activeVideo.volume > 0.05 ? activeVideo.volume : 1.0;
      isDucked = true;
    }
    rampVideoVolume(baseVideoVolume * config.ducking, 130);
  }

  function restoreDucking(immediate = false) {
    if (!activeVideo || !isDucked) return;
    if (restoreTimeout) clearTimeout(restoreTimeout);
    if (immediate) {
      isDucked = false;
      rampVideoVolume(baseVideoVolume, 120);
      return;
    }
    restoreTimeout = setTimeout(() => {
      if (!isSpeaking) {
        isDucked = false;
        rampVideoVolume(baseVideoVolume, 320);
      }
    }, 420);
  }

  function stopCurrentSpeechOnly() {
    isSpeaking = false;
    activeSpeakingText = "";
    if (currentSourceNode) {
      try { currentSourceNode.stop(); } catch (e) {}
      currentSourceNode = null;
    }
    try {
      fallbackAudioEl.pause();
      fallbackAudioEl.removeAttribute("src");
    } catch (e) {}
    restoreDucking(true);
    renderSubBanner();
  }

  function stopAllSpeech(clearQueues = false) {
    if (clearQueues) {
      cueQueue = [];
    }
    stopCurrentSpeechOnly();
  }

  // Fetch voice audio bytes via background worker (or direct fetch fallback)
  async function fetchVoicePayload(audioUrl) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "FETCH_VOICE_AUDIO", audioUrl }, (r) => resolve(r));
      });
      if (res && res.ok && res.b64) {
        return {
          b64: res.b64,
          arrayBuf: base64ToArrayBuffer(res.b64)
        };
      }
    }
    const resp = await fetch(`${ENGINE_URL}${audioUrl}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    return {
      b64: arrayBufferToBase64(arrayBuf),
      arrayBuf
    };
  }

  function formatMMSS(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? "0" : ""}${rem}`;
  }

  function updateReadyStatus() {
    if (isSpeaking) return;
    if (cueQueue.length > 0) {
      const readyCount = cueQueue.filter((c) => c.audioReady).length;
      setStatus(`Sẵn sàng (${readyCount}/${cueQueue.length} câu · kế: ${formatMMSS(cueQueue[0].start)})`);
    } else if (inFlightUploads > 0) {
      setStatus("⚡ Đang dịch thoại...");
    } else {
      setStatus("Đang lắng nghe thoại...");
    }
  }

  const masterCueCache = new Map();

  function restoreCuesAround(t) {
    cueQueue = [];
    seenCueKeys.clear();
    for (const [key, cue] of masterCueCache.entries()) {
      if (!cue.audioFailed && cue.end >= t - 0.8 && cue.start <= t + 75.0) {
        cueQueue.push(cue);
        seenCueKeys.add(key);
      }
    }
    cueQueue.sort((a, b) => a.start - b.start);
  }

  // Enqueue cues and immediately prefetch + pre-decode their silence-trimmed MP3 audio in background
  function enqueueCues(newCues) {
    if (!newCues || !newCues.length) return;
    const currTime = activeVideo ? activeVideo.currentTime : 0;
    let added = 0;
    for (const rawCue of newCues) {
      const key = `${Math.round(rawCue.start * 2)}:${rawCue.text}`;
      let cue = masterCueCache.get(key);
      if (!cue) {
        cue = rawCue;
        cue.audioReady = false;
        cue.audioFailed = false;
        cue.payload = null;
        cue.decodedBuffer = null;

        cue.audioPromise = (async () => {
          try {
            const payload = await fetchVoicePayload(cue.audio_url);
            if (!payload || !payload.arrayBuf) throw new Error("Empty voice payload");
            cue.payload = payload;
            const ctx = getAudioContext();
            if (ctx) {
              try {
                cue.decodedBuffer = await ctx.decodeAudioData(payload.arrayBuf.slice(0));
              } catch (_) {}
            }
            cue.audioReady = true;
            if (!isSpeaking) updateReadyStatus();
            return payload;
          } catch (err) {
            cue.audioFailed = true;
            sendClientLog("PREFETCH_ERR", String(err));
            return null;
          }
        })();

        masterCueCache.set(key, cue);
        if (masterCueCache.size > 350) {
          const oldestKey = masterCueCache.keys().next().value;
          masterCueCache.delete(oldestKey);
        }
        subtitleHistory.push({ start: cue.start, end: cue.slot_end || (cue.end + 1.5), text: cue.text });
      }

      if (activeVideo && currTime > 0.5 && (cue.end < currTime - 1.8 || cue.start > currTime + 75.0)) {
        continue;
      }
      if (seenCueKeys.has(key)) continue;
      seenCueKeys.add(key);
      cueQueue.push(cue);
      added++;
    }
    cueQueue.sort((a, b) => a.start - b.start);
    if (subtitleHistory.length > 150) {
      subtitleHistory = subtitleHistory.slice(-100);
    }
    if (added > 0 && !isSpeaking) {
      updateReadyStatus();
    }
  }

  // Pitch-Preserved Playback (Server FFmpeg WSOLA atempo handles primary fitting; WebAudio stays in 0.98x..1.12x natural range)
  async function playCueNow(cue, slotEnd) {
    if (!config.enabled || !activeVideo || activeVideo.paused) return;
    const playGen = seekGeneration;
    isSpeaking = true;
    activeCueSlotEnd = slotEnd;
    activeSpeakingText = cue.text;
    renderSubBanner();

    try {
      const payload = cue.payload || (await cue.audioPromise);
      if (!payload || !payload.arrayBuf || !config.enabled || !activeVideo || activeVideo.paused || playGen !== seekGeneration) {
        return;
      }

      setStatus(`🎙️ ${cue.text}`);
      applyDucking();

      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        await Promise.race([
          ctx.resume().catch(() => {}),
          new Promise((r) => setTimeout(r, 150))
        ]);
      }

      const videoRate = activeVideo.playbackRate || 1.0;
      const baseSpeed = (1.0 + (config.rate || 0) / 100) * videoRate;

      let playedViaWebAudio = false;
      if (ctx && ctx.state === "running") {
        try {
          const decoded = cue.decodedBuffer || (await ctx.decodeAudioData(payload.arrayBuf.slice(0)));
          const nowTime = activeVideo.currentTime;
          const availWindow = Math.max(0.65, slotEnd - Math.max(nowTime, cue.start));

          // Server FFmpeg atempo already time-fitted the MP3 with pitch preservation;
          // keep WebAudio rate within 0.98x..1.12x so voice pitch and speed stay 100% natural and steady!
          const fitRate = decoded.duration / availWindow;
          const playbackRate = Math.max(0.98, Math.min(1.12, Math.max(baseSpeed, fitRate)));

          playedViaWebAudio = true;
          sendClientLog(
            "PLAY_OK (WebAudio)",
            `${cue.start.toFixed(1)}s..${slotEnd.toFixed(1)}s (video=${nowTime.toFixed(1)}s, rate=${playbackRate.toFixed(2)}x, dur=${decoded.duration.toFixed(2)}s) | "${cue.text}"`
          );

          await new Promise((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = decoded;
            source.playbackRate.value = playbackRate;
            source.connect(ctx.destination);
            currentSourceNode = source;
            source.onended = () => {
              currentSourceNode = null;
              resolve();
            };
            source.start(0);
          });
        } catch (webAudioErr) {
          sendClientLog("WEBAUDIO_ERR", String(webAudioErr));
        }
      }

      if (!playedViaWebAudio) {
        const dataUrl = `data:audio/mpeg;base64,${payload.b64}`;
        await new Promise((resolve, reject) => {
          fallbackAudioEl.src = dataUrl;
          fallbackAudioEl.onloadedmetadata = () => {
            const nowTime = activeVideo ? activeVideo.currentTime : cue.start;
            const availWindow = Math.max(0.65, slotEnd - Math.max(nowTime, cue.start));
            const audioDur = fallbackAudioEl.duration || cue.duration || 2.0;
            const playbackRate = Math.max(0.98, Math.min(1.22, Math.max(baseSpeed, audioDur / availWindow)));
            fallbackAudioEl.preservesPitch = true;
            fallbackAudioEl.playbackRate = playbackRate;
            sendClientLog("PLAY_FALLBACK (HTML5Audio)", `${cue.start.toFixed(1)}s (rate=${playbackRate.toFixed(2)}x) | "${cue.text}"`);
            fallbackAudioEl.play().catch(reject);
          };
          fallbackAudioEl.onended = () => resolve();
          fallbackAudioEl.onerror = () => reject(new Error("HTML5 Audio error"));
        });
      }
    } catch (err) {
      const errMsg = err && err.name ? `${err.name}: ${err.message}` : String(err);
      sendClientLog("PLAY_FAILED", `${cue.start.toFixed(1)}s | ${errMsg}`);
      if (err && err.name === "NotAllowedError") {
        setStatus("🔊 Bấm 1 lần vào video để mở khóa tiếng!");
      }
    } finally {
      isSpeaking = false;
      activeSpeakingText = "";
      restoreDucking(false);
      renderSubBanner();
      updateReadyStatus();
    }
  }

  // 50ms Zero-Drift Scheduler loop (from real-time-video-subs & LocalDub)
  setInterval(() => {
    renderSubBanner();
    if (!config.enabled || !activeVideo || activeVideo.paused || cueQueue.length === 0) {
      return;
    }

    const currTime = activeVideo.currentTime;

    // 1. Check speaking state FIRST so we NEVER silently shift/drop upcoming cues while a line is speaking!
    if (isSpeaking) {
      if (cueQueue.length > 0 && cueQueue[0].audioReady && currTime >= Math.max(activeCueSlotEnd + 0.65, cueQueue[0].start + 0.95)) {
        stopCurrentSpeechOnly();
      } else {
        return;
      }
    }

    // 2. Drop cues that failed synthesis or that the video has completely passed (> 1.8s past cue.end)
    let droppedAny = false;
    while (
      cueQueue.length > 0 &&
      (cueQueue[0].audioFailed || currTime > cueQueue[0].end + 1.8)
    ) {
      const dropped = cueQueue.shift();
      droppedAny = true;
      if (!dropped.audioFailed) {
        sendClientLog("CUE_SKIPPED_LATE", `Skipped stale ${dropped.start.toFixed(1)}s..${dropped.end.toFixed(1)}s at video=${currTime.toFixed(1)}s`);
      }
    }
    if (cueQueue.length === 0) {
      if (droppedAny) updateReadyStatus();
      return;
    }

    // 3. Only skip cueQueue[0] if currTime is already past cueQueue[0].end + 0.6 AND cueQueue[1] is ready and due
    while (
      cueQueue.length >= 2 &&
      currTime > cueQueue[0].end + 0.6 &&
      currTime >= cueQueue[1].start &&
      cueQueue[1].audioReady
    ) {
      cueQueue.shift();
      droppedAny = true;
    }
    if (droppedAny) updateReadyStatus();

    const nextCue = cueQueue[0];

    // 4. Trigger playback when playhead reaches nextCue.start (with 0.20s pre-roll)
    if (currTime >= nextCue.start - 0.20 && currTime <= nextCue.end + 1.8) {
      if (!nextCue.audioReady) {
        // Do NOT shift or block with isSpeaking=true while audio is still downloading; wait for audioReady
        setStatus(`⚡ Đang tải giọng đọc (${formatMMSS(nextCue.start)})...`);
        return;
      }
      cueQueue.shift();
      const slotEnd =
        cueQueue.length > 0
          ? Math.min(nextCue.slot_end || (nextCue.end + 1.6), cueQueue[0].start - 0.05)
          : (nextCue.slot_end || (nextCue.end + 1.6));

      playCueNow(nextCue, Math.max(nextCue.start + 0.85, slotEnd));
    }
  }, TICK_MS);

  let inFlightBatch = null;

  // Strict Playhead-Ordered MSE Batch Scheduler
  async function processNextMseBatch() {
    if (!config.enabled || hasSoftSubtitles || inFlightUploads >= 1 || pendingMseBatches.length === 0) return;

    const currTime = activeVideo ? activeVideo.currentTime : 0;
    const nowMs = Date.now();

    // 1. Prune batches that have already passed (> 1.5s behind current playhead), unless just appended (< 8s ago) for a seek
    if (!activeVideo || !activeVideo.seeking) {
      pendingMseBatches = pendingMseBatches.filter(
        (b) => b.endTime >= currTime - 1.5 || (nowMs - (b.appendedAt || 0) < 8000)
      );
    }

    // 2. Sort ascending by startTime so we ALWAYS process earliest segments first
    pendingMseBatches.sort((a, b) => a.startTime - b.startTime);

    // 3. Find the earliest batch that covers current playhead or is within the next 45 seconds
    let targetIdx = -1;
    for (let i = 0; i < pendingMseBatches.length; i++) {
      const b = pendingMseBatches[i];
      if (b.endTime >= currTime - 0.5 && (currTime <= 1.0 || b.startTime <= currTime + 45.0)) {
        targetIdx = i;
        break;
      }
    }

    // Fallback: if hls.js just appended segments for a seek target before video.currentTime updated, pick the earliest fresh batch
    if (targetIdx === -1) {
      for (let i = 0; i < pendingMseBatches.length; i++) {
        if (nowMs - (pendingMseBatches[i].appendedAt || 0) < 8000) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      return;
    }

    const [batch] = pendingMseBatches.splice(targetIdx, 1);

    inFlightUploads = 1;
    inFlightBatch = batch;
    if (!isSpeaking && cueQueue.length === 0) {
      setStatus(`⚡ Đang dịch đoạn ${formatMMSS(batch.startTime)}...`);
    }

    const movieTitle = extractMovieTitle();

    try {
      let cues = [];
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        const b64 = arrayBufferToBase64(batch.buffer);
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: "DUB_AUDIO_B64",
              audioB64: b64,
              mimeType: batch.mimeType || "audio/mp4",
              timeOffset: batch.startTime || 0,
              voice: config.voice,
              rate: config.rate,
              pitch: config.pitch,
              movieTitle
            },
            (r) => resolve(r)
          );
        });
        if (res && res.ok) {
          cues = res.cues || [];
        } else if (res && res.error && !isSpeaking && inFlightBatch === batch) {
          setStatus(`Lỗi Engine: ${res.error.slice(0, 45)}`);
        }
      } else {
        const formData = new FormData();
        formData.append("file", new Blob([batch.buffer], { type: batch.mimeType || "audio/mp4" }), "stream.mp4");
        formData.append("time_offset", String(batch.startTime || 0));
        formData.append("voice", config.voice);
        formData.append("rate", String(config.rate));
        formData.append("pitch", String(config.pitch));
        formData.append("movie_title", movieTitle);

        const resp = await fetch(`${ENGINE_URL}/api/dub/audio`, {
          method: "POST",
          body: formData
        });
        if (resp.ok) {
          const data = await resp.json();
          cues = data.cues || [];
        }
      }

      if (cues.length > 0) {
        enqueueCues(cues);
      } else if (!isSpeaking) {
        updateReadyStatus();
      }
    } catch (err) {
      if (!isSpeaking && inFlightBatch === batch) setStatus("Chưa kết nối Engine (run.bat)");
    } finally {
      if (inFlightBatch === batch) {
        inFlightBatch = null;
        inFlightUploads = 0;
      }
      if (pendingMseBatches.length > 0) {
        processNextMseBatch();
      }
    }
  }

  setInterval(() => {
    if (config.enabled && !hasSoftSubtitles && pendingMseBatches.length > 0 && inFlightUploads < 1) {
      processNextMseBatch();
    }
  }, 350);

  // Listen for MSE audio batches & intercepted .vtt/.srt subtitle files from mse-hook.js
  let fullSubFileCues = [];
  let lastSubBatchSentTo = -1;

  function pumpSoftSubtitleFile() {
    if (!config.enabled || !hasSoftSubtitles || fullSubFileCues.length === 0 || !activeVideo) return;
    const curr = activeVideo.currentTime;
    if (curr < lastSubBatchSentTo - 10.0 && curr >= 0 && lastSubBatchSentTo > curr + 30.0) {
      lastSubBatchSentTo = curr - 1.0;
    }
    if (lastSubBatchSentTo >= curr + 20.0) return;

    const winStart = Math.max(curr - 0.5, lastSubBatchSentTo);
    const winEnd = curr + 30.0;
    const slice = fullSubFileCues.filter((c) => c.start >= winStart && c.start <= winEnd).slice(0, 12);
    lastSubBatchSentTo = winEnd;
    if (slice.length === 0) return;

    const sampleText = slice.map((c) => c.text).join(" ");
    const isViet = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(sampleText);

    const payload = {
      cues: slice,
      voice: config.voice,
      rate: config.rate,
      pitch: config.pitch,
      is_vietnamese: isViet,
      movie_title: extractMovieTitle()
    };
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "DUB_SUBTITLES", payload, movieTitle: payload.movie_title }, (res) => {
        if (res && res.ok && res.cues) enqueueCues(res.cues);
      });
    }
  }

  setInterval(pumpSoftSubtitleFile, 1000);

  let detectedStreamUrl = "";

  window.addEventListener("message", (event) => {
    if (!event.data) return;

    if (event.data.type === "__MOVIE_VOICE_STREAM_URL__" && event.data.url) {
      detectedStreamUrl = event.data.url;
      return;
    }

    if (event.data.type === "__MOVIE_VOICE_SUBTITLE_FILE__" && Array.isArray(event.data.cues)) {
      hasSoftSubtitles = true;
      fullSubFileCues = event.data.cues;
      lastSubBatchSentTo = -1;
      pendingMseBatches = [];
      sendClientLog("SOFT_SUB_FILE_DETECTED", `Loaded ${fullSubFileCues.length} cues from ${event.data.url || "stream"}`);
      setStatus(`Đã nạp ${fullSubFileCues.length} câu phụ đề mềm`);
      pumpSoftSubtitleFile();
      return;
    }

    if (event.data.type !== "__MOVIE_VOICE_MSE_BATCH__" || !event.data.buffer || hasSoftSubtitles) {
      return;
    }
    const startTime = Number.isFinite(event.data.startTime)
      ? event.data.startTime
      : (activeVideo ? activeVideo.currentTime : 0);
    const endTime = Number.isFinite(event.data.endTime)
      ? event.data.endTime
      : (startTime + 6.0);

    pendingMseBatches.push({
      mimeType: event.data.mimeType,
      startTime,
      endTime,
      buffer: event.data.buffer,
      appendedAt: Date.now()
    });

    pendingMseBatches.sort((a, b) => a.startTime - b.startTime);
    if (pendingMseBatches.length > 45) {
      pendingMseBatches.pop();
    }

    processNextMseBatch();
  });

  window.postMessage({ type: "__MOVIE_VOICE_PLAYER_READY__" }, "*");

  // UI elements & Draggable Subtitle Bar (from real-time-video-subs)
  let uiContainer = null;
  let statusTextEl = null;
  let subBarEl = null;
  let subBarFontSize = 18;

  function setStatus(text) {
    if (statusTextEl) {
      statusTextEl.innerText = text;
      statusTextEl.title = text;
    }
  }

  function renderSubBanner() {
    if (!subBarEl || !config.enabled || !activeVideo) {
      if (subBarEl) subBarEl.style.display = "none";
      return;
    }
    let textToShow = activeSpeakingText;
    if (!textToShow) {
      const t = activeVideo.currentTime;
      const match = subtitleHistory.find((s) => t >= s.start - 0.1 && t <= s.end + 0.25);
      if (match) textToShow = match.text;
    }
    if (textToShow) {
      if (subBarEl.textContent !== textToShow) {
        subBarEl.textContent = textToShow;
      }
      subBarEl.style.display = "inline-block";
    } else {
      subBarEl.style.display = "none";
    }
  }

  function updateUI() {
    if (!uiContainer) return;
    const btn = uiContainer.querySelector(".mv-toggle-btn");
    if (btn) {
      btn.innerText = config.enabled ? "🇻🇳 VI · Thuyết minh: BẬT" : "🇻🇳 VI · Thuyết minh: TẮT";
      btn.classList.toggle("active", Boolean(config.enabled));
    }
    renderSubBanner();
  }

  function mountUI(video) {
    if (uiContainer && uiContainer.isConnected) return;
    const parent = video.parentElement || document.body;
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    uiContainer = document.createElement("div");
    uiContainer.className = "movie-voice-floating-bar";
    uiContainer.innerHTML = `
      <button class="mv-toggle-btn ${config.enabled ? 'active' : ''}">🇻🇳 VI · Thuyết minh: BẬT</button>
      <button class="mv-studio-btn" title="Mở Movie Voice Studio v6 (Tải & xử lý trước toàn tập khớp 100% sub trên hình)" style="background:#3b82f6;color:#fff;border:none;border-radius:999px;padding:4px 10px;font-size:11.5px;font-weight:700;cursor:pointer;">🎬 Studio</button>
      <span class="mv-status-text">Sẵn sàng</span>
    `;

    uiContainer.querySelector(".mv-toggle-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      getAudioContext();
      config.enabled = !config.enabled;
      if (!config.enabled) {
        stopAllSpeech(true);
      }
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ enabled: config.enabled });
      }
      updateUI();
    });

    uiContainer.querySelector(".mv-studio-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeVideo) activeVideo.pause();
      const title = encodeURIComponent(extractMovieTitle() || "Phim Thuyết Minh");
      const stream = encodeURIComponent(detectedStreamUrl || "");
      window.open(`${ENGINE_URL}/?title=${title}&stream_url=${stream}`, "_blank");
    });

    statusTextEl = uiContainer.querySelector(".mv-status-text");
    parent.appendChild(uiContainer);

    // Mount draggable Vietnamese subtitle banner (from real-time-video-subs)
    subBarEl = document.createElement("div");
    subBarEl.className = "mv-sub-bar";
    subBarEl.title = "Kéo để di chuyển • Cuộn chuột để đổi cỡ chữ • Nháy đúp để đặt lại";

    let dragState = null;
    subBarEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = subBarEl.getBoundingClientRect();
      const pRect = parent.getBoundingClientRect();
      dragState = {
        dx: e.clientX - (rect.left + rect.width / 2),
        dy: e.clientY - (rect.top + rect.height / 2),
        pRect
      };
      subBarEl.setPointerCapture(e.pointerId);
    });
    subBarEl.addEventListener("pointermove", (e) => {
      if (!dragState) return;
      const pRect = parent.getBoundingClientRect();
      const cx = Math.min(0.95, Math.max(0.05, (e.clientX - dragState.dx - pRect.left) / Math.max(1, pRect.width)));
      const cy = Math.min(0.95, Math.max(0.05, (e.clientY - dragState.dy - pRect.top) / Math.max(1, pRect.height)));
      subBarEl.style.left = `${(cx * 100).toFixed(1)}%`;
      subBarEl.style.top = `${(cy * 100).toFixed(1)}%`;
      subBarEl.style.bottom = "auto";
      subBarEl.style.transform = "translate(-50%, -50%)";
    });
    subBarEl.addEventListener("pointerup", () => {
      dragState = null;
    });
    subBarEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      subBarEl.style.left = "50%";
      subBarEl.style.top = "auto";
      subBarEl.style.bottom = "9%";
      subBarEl.style.transform = "translateX(-50%)";
      subBarFontSize = 18;
      subBarEl.style.fontSize = `${subBarFontSize}px`;
    });
    subBarEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      subBarFontSize = Math.min(34, Math.max(13, subBarFontSize + (e.deltaY < 0 ? 1.5 : -1.5)));
      subBarEl.style.fontSize = `${subBarFontSize}px`;
    }, { passive: false });

    parent.appendChild(subBarEl);
    setStatus("Sẵn sàng");
  }

  function bindVideoEvents(video) {
    if (video.__mvDubEvents) return;
    video.__mvDubEvents = true;

    video.addEventListener("play", () => {
      getAudioContext();
      processNextMseBatch();
      pumpSoftSubtitleFile();
    });

    video.addEventListener("pause", () => {
      if (video === activeVideo) {
        stopCurrentSpeechOnly();
      }
    });

    video.addEventListener("seeking", () => {
      if (video === activeVideo) {
        seekGeneration++;
        const t = video.currentTime;
        stopCurrentSpeechOnly();
        restoreCuesAround(t);
        if (
          inFlightBatch &&
          Date.now() - (inFlightBatch.appendedAt || 0) >= 6000 &&
          (inFlightBatch.endTime < t - 2.0 || inFlightBatch.startTime > t + 50.0)
        ) {
          inFlightBatch = null;
          inFlightUploads = 0;
        }
        if (cueQueue.length > 0) {
          updateReadyStatus();
        } else {
          setStatus("Đang đồng bộ vị trí mới...");
        }
      }
    });

    video.addEventListener("seeked", () => {
      if (video === activeVideo) {
        seekGeneration++;
        const t = video.currentTime;
        stopCurrentSpeechOnly();
        restoreCuesAround(t);
        if (
          inFlightBatch &&
          Date.now() - (inFlightBatch.appendedAt || 0) >= 6000 &&
          (inFlightBatch.endTime < t - 2.0 || inFlightBatch.startTime > t + 50.0)
        ) {
          inFlightBatch = null;
          inFlightUploads = 0;
        }
        const nowMs = Date.now();
        pendingMseBatches = pendingMseBatches.filter(
          (b) => (b.endTime >= t - 1.5 && b.startTime <= t + 45.0) || (nowMs - (b.appendedAt || 0) < 8000)
        );
        lastSubBatchSentTo = t - 0.5;
        sendClientLog("VIDEO_SEEKED", `currentTime=${t.toFixed(1)}s, queuedBatches=${pendingMseBatches.length}, restoredCues=${cueQueue.length}`);
        processNextMseBatch();
        pumpSoftSubtitleFile();
        updateReadyStatus();
      }
    });
  }

  // Initialize detector
  new window.MovieVoiceDetector(
    (video) => {
      activeVideo = video;
      bindVideoEvents(video);
      mountUI(video);
      sendClientLog("VIDEO_DETECTED", `duration=${(video.duration || 0).toFixed(1)}s, currentTime=${(video.currentTime || 0).toFixed(1)}s, title="${extractMovieTitle()}"`);
      window.postMessage({ type: "__MOVIE_VOICE_PLAYER_READY__" }, "*");
      processNextMseBatch();
    },
    async (sub) => {
      if (!config.enabled || !activeVideo) return;
      hasSoftSubtitles = true;
      const isViet = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(sub.text);
      const movieTitle = extractMovieTitle();
      const payload = {
        cues: [{ start: sub.start, end: sub.end, text: sub.text }],
        voice: config.voice,
        rate: config.rate,
        pitch: config.pitch,
        is_vietnamese: isViet,
        movie_title: movieTitle
      };
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "DUB_SUBTITLES", payload, movieTitle }, (res) => {
            if (res && res.ok && res.cues) enqueueCues(res.cues);
          });
        } else {
          const resp = await fetch(`${ENGINE_URL}/api/dub/subtitles`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.cues) enqueueCues(data.cues);
          }
        }
      } catch (e) {}
    }
  );
})();
