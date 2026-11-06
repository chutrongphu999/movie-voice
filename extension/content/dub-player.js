// Movie Voice - In-Page Web Audio Dubbing Player v4.4
// Uses a Playhead-Synchronized Lookahead Queue so MSE batches are always processed in chronological order right ahead of video.currentTime!
(function () {
  "use strict";

  if (window.__movieVoicePlayerLoaded) return;
  window.__movieVoicePlayerLoaded = true;

  const ENGINE_URL = "http://127.0.0.1:8765";

  let config = {
    enabled: true,
    voice: "vi-VN-HoaiMyNeural",
    ducking: 0.20,
    rate: 0,
    pitch: 0,
    mode: "audio" // "audio" = nghe tiếng gốc (Whisper) | "hardsub" = đọc chữ sub gắn cứng trên hình (Gemini Vision)
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
  let seenCueKeys = new Set();
  let isSpeaking = false;
  let currentSourceNode = null;
  let fallbackAudioEl = new Audio();
  let isDucked = false;
  let baseVideoVolume = 1.0;
  let fadeInterval = null;
  let restoreTimeout = null;
  let inFlightUploads = 0;
  let pendingMseBatches = [];

  // Dub-ahead gating: pause video briefly so the AI stays ~12s ahead of the playhead (no more lag / stale cues)
  let processedUpTo = 0;
  let gateWindowStart = Date.now();
  let autoPaused = false;
  let autoPauseStartedAt = 0;
  let lastGateEndedAt = 0;
  const GATE_MIN_AHEAD = 5.0;
  const GATE_RESUME_AHEAD = 12.0;

  function resetGate(time) {
    processedUpTo = time || 0;
    gateWindowStart = Date.now();
  }

  setInterval(() => {
    if (!config.enabled || !activeVideo || config.mode === "hardsub") return;
    const t = activeVideo.currentTime;
    const ahead = processedUpTo - t;
    const gateActive = (Date.now() - gateWindowStart) < 40000;

    if (autoPaused) {
      const waited = Date.now() - autoPauseStartedAt;
      if (ahead >= GATE_RESUME_AHEAD || waited > 25000 || !gateActive) {
        autoPaused = false;
        lastGateEndedAt = Date.now();
        sendClientLog("GATE_RESUME", `ahead=${ahead.toFixed(1)}s waited=${(waited / 1000).toFixed(1)}s`);
        activeVideo.play().catch(() => {});
      } else {
        setStatus(`⏳ Đang chuẩn bị lồng tiếng... (${Math.max(0, ahead).toFixed(0)}/${GATE_RESUME_AHEAD}s)`);
      }
      return;
    }

    if (
      !activeVideo.paused &&
      gateActive &&
      ahead < GATE_MIN_AHEAD &&
      Date.now() - lastGateEndedAt > 3000
    ) {
      autoPaused = true;
      autoPauseStartedAt = Date.now();
      activeVideo.pause();
      sendClientLog("GATE_PAUSE", `video=${t.toFixed(1)}s processedUpTo=${processedUpTo.toFixed(1)}s`);
    }
  }, 300);

  // Smart Ducking: smoothly lowers and restores original video volume
  function rampVideoVolume(targetVolume, durationMs = 180) {
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
    rampVideoVolume(baseVideoVolume * config.ducking, 140);
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
    }, 450);
  }

  function stopCurrentSpeechOnly() {
    isSpeaking = false;
    if (currentSourceNode) {
      try { currentSourceNode.stop(); } catch (e) {}
      currentSourceNode = null;
    }
    try {
      fallbackAudioEl.pause();
      fallbackAudioEl.removeAttribute("src");
    } catch (e) {}
    restoreDucking(true);
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

  // Enqueue cues and immediately prefetch their audio bytes
  function enqueueCues(newCues) {
    if (!newCues || !newCues.length) return;
    let added = 0;
    for (const cue of newCues) {
      const key = `${Math.round(cue.start * 2)}:${cue.text}`;
      if (seenCueKeys.has(key)) continue;
      seenCueKeys.add(key);
      if (seenCueKeys.size > 400) {
        const firstKey = seenCueKeys.values().next().value;
        seenCueKeys.delete(firstKey);
      }

      cue.audioPromise = fetchVoicePayload(cue.audio_url).catch((err) => {
        sendClientLog("PREFETCH_ERR", String(err));
        return null;
      });
      cueQueue.push(cue);
      added++;
    }
    cueQueue.sort((a, b) => a.start - b.start);
    if (added > 0 && !isSpeaking) {
      setStatus(`Sẵn sàng (${cueQueue.length} câu chờ đọc)`);
    }
  }

  // Play a single cue using Web Audio API (with data: URL HTML5 Audio fallback)
  async function playCueNow(cue, playbackRate = 1.0) {
    if (!config.enabled || !activeVideo || activeVideo.paused) return;
    isSpeaking = true;

    try {
      const payload = await (cue.audioPromise || fetchVoicePayload(cue.audio_url));
      if (!payload || !payload.arrayBuf || !config.enabled || !activeVideo || activeVideo.paused) {
        isSpeaking = false;
        return;
      }

      setStatus(`🎙️ ${cue.text}`);
      applyDucking();

      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        await Promise.race([
          ctx.resume().catch(() => {}),
          new Promise((r) => setTimeout(r, 250))
        ]);
      }

      let playedViaWebAudio = false;
      if (ctx && ctx.state === "running") {
        try {
          const decoded = await ctx.decodeAudioData(payload.arrayBuf.slice(0));
          playedViaWebAudio = true;
          sendClientLog("PLAY_OK (WebAudio)", `${cue.start.toFixed(1)}s (video=${activeVideo.currentTime.toFixed(1)}s) | "${cue.text}"`);
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
        sendClientLog("PLAY_FALLBACK (HTML5Audio)", `${cue.start.toFixed(1)}s (ctx=${ctx ? ctx.state : 'none'}) | "${cue.text}"`);
        await new Promise((resolve, reject) => {
          fallbackAudioEl.src = dataUrl;
          fallbackAudioEl.playbackRate = playbackRate;
          fallbackAudioEl.onended = () => resolve();
          fallbackAudioEl.onerror = () => reject(new Error("HTML5 Audio error"));
          fallbackAudioEl.play().catch(reject);
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
      restoreDucking(false);
    }
  }

  // Scheduler loop: checks cueQueue every 80ms and keeps strict real-time lip-sync (no domino lag!)
  setInterval(() => {
    if (!config.enabled || !activeVideo || activeVideo.paused || cueQueue.length === 0) {
      return;
    }

    const currTime = activeVideo.currentTime;

    // 1. Drop cues that have already passed (> 0.8s past cue.end or > 2.8s past cue.start) so we NEVER speak stale lines!
    while (
      cueQueue.length > 0 &&
      (currTime > cueQueue[0].end + 1.0 || currTime > cueQueue[0].start + 3.5)
    ) {
      const dropped = cueQueue.shift();
      sendClientLog("CUE_SKIPPED_LATE", `Skipped stale ${dropped.start.toFixed(1)}s..${dropped.end.toFixed(1)}s at video=${currTime.toFixed(1)}s`);
    }
    if (cueQueue.length === 0) return;

    // 2. If multiple cues are already due (e.g. two short lines back-to-back), skip to the one matching currTime
    while (cueQueue.length >= 2 && currTime >= cueQueue[1].start - 0.1) {
      cueQueue.shift();
    }

    // If currently speaking, check if the next cue is already overdue by >0.4s and cut off tail of old cue if needed
    if (isSpeaking) {
      if (cueQueue.length > 0 && currTime >= cueQueue[0].start + 0.6) {
        stopCurrentSpeechOnly();
      } else {
        return;
      }
    }

    const nextCue = cueQueue[0];

    // 3. Play when playhead reaches nextCue.start (with 0.25s pre-roll)
    if (currTime >= nextCue.start - 0.25 && currTime <= nextCue.end + 0.8) {
      cueQueue.shift();
      let baseSpeed = 1.0 + (config.rate || 0) / 100;
      // Time-fit: speed up slightly if TTS duration is longer than the available time window before the next cue
      const slotEnd = cueQueue.length > 0 ? Math.min(nextCue.end + 0.4, cueQueue[0].start) : (nextCue.end + 0.5);
      const availWindow = Math.max(1.0, slotEnd - Math.max(currTime, nextCue.start));
      const ttsDur = nextCue.duration || 2.0;
      const fitSpeed = ttsDur / availWindow;
      const finalSpeed = Math.max(0.9, Math.min(1.35, Math.max(baseSpeed, fitSpeed)));

      playCueNow(nextCue, finalSpeed);
    }
  }, 80);

  // Playhead-synchronized MSE Batch Scheduler:
  // Always picks the earliest batch right at/ahead of activeVideo.currentTime (within +32s lookahead)
  async function processNextMseBatch() {
    if (config.mode === "hardsub") { pendingMseBatches = []; return; }
    if (!config.enabled || inFlightUploads >= 2 || pendingMseBatches.length === 0) return;

    const currTime = activeVideo ? activeVideo.currentTime : 0;

    // 1. Prune batches that are far behind current playhead (> 60s old)
    pendingMseBatches = pendingMseBatches.filter((b) => b.endTime >= currTime - 60.0);

    // 2. Sort ascending by startTime so we ALWAYS process earliest segments first!
    pendingMseBatches.sort((a, b) => a.startTime - b.startTime);

    // 3. Find the earliest batch that covers current playhead or is within the next 32 seconds
    let targetIdx = -1;
    for (let i = 0; i < pendingMseBatches.length; i++) {
      const b = pendingMseBatches[i];
      if (b.endTime >= currTime - 0.5) {
        if (currTime === 0 || b.startTime <= currTime + 32.0) {
          targetIdx = i;
        }
        break;
      }
    }

    if (targetIdx === -1) {
      // All relevant batches within the next 32s are already processed; wait for playhead to advance
      return;
    }

    const [batch] = pendingMseBatches.splice(targetIdx, 1);

    inFlightUploads++;
    if (!isSpeaking && cueQueue.length === 0) {
      setStatus(`⚡ Đang dịch đoạn ${Math.floor(batch.startTime)}s...`);
    }

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
              pitch: config.pitch
            },
            (r) => resolve(r)
          );
        });
        if (res && res.ok) {
          cues = res.cues || [];
        } else if (res && res.error && !isSpeaking) {
          setStatus(`Lỗi Engine: ${res.error.slice(0, 45)}`);
        }
      } else {
        const formData = new FormData();
        formData.append("file", new Blob([batch.buffer], { type: batch.mimeType || "audio/mp4" }), "stream.mp4");
        formData.append("time_offset", String(batch.startTime || 0));
        formData.append("voice", config.voice);
        formData.append("rate", String(config.rate));
        formData.append("pitch", String(config.pitch));

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
      } else if (!isSpeaking && cueQueue.length === 0) {
        setStatus("Đang lắng nghe thoại...");
      }
    } catch (err) {
      if (!isSpeaking) setStatus("Chưa kết nối Engine (run.bat)");
    } finally {
      inFlightUploads--;
      if (batch && Number.isFinite(batch.endTime)) {
        processedUpTo = Math.max(processedUpTo, batch.endTime);
      }
      if (pendingMseBatches.length > 0) {
        processNextMseBatch();
      }
    }
  }

  // Periodically check if video playhead has advanced into the 32s lookahead window of buffered MSE batches
  setInterval(() => {
    if (config.enabled && pendingMseBatches.length > 0 && inFlightUploads < 2) {
      processNextMseBatch();
    }
  }, 600);

  // ---------- Hard-sub mode: read burned-in subtitle from the video frame (no OCR engine, Gemini Vision) ----------
  const MASK_W = 160;
  const MASK_H = 28;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = MASK_W;
  maskCanvas.height = MASK_H;
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  const cropCanvas = document.createElement("canvas");
  let hsPrevMask = null;      // mask of previous sample (to detect "stable" subtitle)
  let hsSentMask = null;      // mask of the last subtitle we sent
  let hsLastSendAt = 0;
  let hsInFlight = false;
  let hsWarnedTaint = false;

  // Subtitle band: bottom 28% of the frame, central 90% width
  function cropRect(v) {
    const w = v.videoWidth, h = v.videoHeight;
    return { sx: Math.round(w * 0.05), sy: Math.round(h * 0.72), sw: Math.round(w * 0.9), sh: Math.round(h * 0.28) };
  }

  function sampleMask(v) {
    const r = cropRect(v);
    maskCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, MASK_W, MASK_H);
    const px = maskCtx.getImageData(0, 0, MASK_W, MASK_H).data;
    const mask = new Uint8Array(MASK_W * MASK_H);
    let on = 0;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const g = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
      if (g > 215) { mask[j] = 1; on++; }
    }
    return { mask, ratio: on / mask.length };
  }

  function maskDiff(a, b) {
    if (!a || !b) return 1;
    let x = 0, u = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] || b[i]) { u++; if (a[i] !== b[i]) x++; }
    }
    return u === 0 ? 0 : x / u;
  }

  async function sendHardsubFrame(v) {
    const r = cropRect(v);
    const outW = Math.min(720, r.sw);
    cropCanvas.width = outW;
    cropCanvas.height = Math.round(outW * r.sh / r.sw);
    cropCanvas.getContext("2d").drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, cropCanvas.width, cropCanvas.height);
    const dataUrl = cropCanvas.toDataURL("image/jpeg", 0.72);
    const b64 = dataUrl.split(",")[1];
    const videoTime = v.currentTime;
    hsInFlight = true;
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "DUB_HARDSUB", imageB64: b64, videoTime, voice: config.voice, rate: config.rate, pitch: config.pitch },
          (r2) => resolve(r2)
        );
      });
      if (res && res.ok && res.cues && res.cues.length) {
        // cue.start = time the subtitle appeared; speak as soon as it arrives
        res.cues.forEach((c) => { c.start = Math.min(c.start, v.currentTime); });
        enqueueCues(res.cues);
      } else if (res && !res.ok && !isSpeaking) {
        setStatus(`Lỗi Engine: ${String(res.error).slice(0, 40)}`);
      }
    } catch (e) {
    } finally {
      hsInFlight = false;
    }
  }

  setInterval(() => {
    if (!config.enabled || config.mode !== "hardsub" || !activeVideo || activeVideo.paused) return;
    const v = activeVideo;
    if (!v.videoWidth || v.readyState < 2) return;
    let cur;
    try {
      cur = sampleMask(v);
    } catch (e) {
      if (!hsWarnedTaint) {
        hsWarnedTaint = true;
        sendClientLog("HARDSUB_CANVAS_BLOCKED", String(e));
        setStatus("⚠️ Trang chặn đọc khung hình video");
      }
      return;
    }
    const present = cur.ratio > 0.004 && cur.ratio < 0.3;
    const stable = present && hsPrevMask && maskDiff(hsPrevMask, cur.mask) < 0.25;
    hsPrevMask = cur.mask;

    if (!present) {
      hsSentMask = null; // subtitle gone -> the next one counts as new
      return;
    }
    if (!stable || hsInFlight) return;
    if (Date.now() - hsLastSendAt < 1500) return;
    if (hsSentMask && maskDiff(hsSentMask, cur.mask) < 0.4) return; // same subtitle already sent

    hsSentMask = cur.mask;
    hsLastSendAt = Date.now();
    sendHardsubFrame(v);
  }, 300);

  // Listen for MSE audio batches from mse-hook.js
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "__MOVIE_VOICE_MSE_BATCH__" || !event.data.buffer) {
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
      buffer: event.data.buffer
    });

    // Sort by startTime ascending and cap at 45 batches (removing from the far future, NEVER removing near batches!)
    pendingMseBatches.sort((a, b) => a.startTime - b.startTime);
    if (pendingMseBatches.length > 45) {
      pendingMseBatches.pop();
    }

    processNextMseBatch();
  });

  // Notify mse-hook.js that dub-player.js is ready to receive batches
  window.postMessage({ type: "__MOVIE_VOICE_PLAYER_READY__" }, "*");

  // UI elements
  let uiContainer = null;
  let statusTextEl = null;

  function setStatus(text) {
    if (statusTextEl) {
      statusTextEl.innerText = text;
      statusTextEl.title = text;
    }
  }

  function updateUI() {
    if (!uiContainer) return;
    const btn = uiContainer.querySelector(".mv-toggle-btn");
    if (btn) {
      btn.innerText = config.enabled ? "🎙️ LỒNG TIẾNG: BẬT" : "🎙️ LỒNG TIẾNG: TẮT";
      btn.classList.toggle("active", Boolean(config.enabled));
    }
    const modeBtn = uiContainer.querySelector(".mv-mode-btn");
    if (modeBtn) {
      modeBtn.innerText = config.mode === "hardsub" ? "📝 Đọc sub trên hình" : "🔊 Nghe tiếng gốc";
    }
  }

  function mountUI(video) {
    if (uiContainer && uiContainer.isConnected) return;
    uiContainer = document.createElement("div");
    uiContainer.className = "movie-voice-floating-bar";
    uiContainer.innerHTML = `
      <button class="mv-toggle-btn ${config.enabled ? 'active' : ''}">🎙️ LỒNG TIẾNG: BẬT</button>
      <button class="mv-mode-btn">🔊 Nghe tiếng gốc</button>
      <span class="mv-status-text">Sẵn sàng</span>
    `;

    uiContainer.querySelector(".mv-mode-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      getAudioContext();
      config.mode = config.mode === "hardsub" ? "audio" : "hardsub";
      cueQueue = [];
      stopCurrentSpeechOnly();
      autoPaused = false;
      hsSentMask = null;
      hsPrevMask = null;
      if (config.mode === "audio") resetGate(activeVideo ? activeVideo.currentTime : 0);
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ mode: config.mode });
      }
      setStatus(config.mode === "hardsub" ? "Đang đọc sub trên hình..." : "Đang nghe tiếng gốc...");
      updateUI();
    });

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

    statusTextEl = uiContainer.querySelector(".mv-status-text");

    const parent = video.parentElement || document.body;
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(uiContainer);
    setStatus("Sẵn sàng");
  }

  function bindVideoEvents(video) {
    if (video.__mvDubEvents) return;
    video.__mvDubEvents = true;

    video.addEventListener("play", () => {
      getAudioContext();
      processNextMseBatch();
    });

    video.addEventListener("pause", () => {
      if (video === activeVideo) {
        // Only the user's own pause stops speech; our gate pause keeps queued cues intact
        if (!autoPaused) stopCurrentSpeechOnly();
      }
    });

    video.addEventListener("play", () => {
      // User pressed play manually while gate was holding: release gate
      if (video === activeVideo && autoPaused && Date.now() - autoPauseStartedAt > 800) {
        autoPaused = false;
        lastGateEndedAt = Date.now();
      }
    });

    video.addEventListener("seeking", () => {
      if (video === activeVideo) {
        stopCurrentSpeechOnly();
        cueQueue = [];
        autoPaused = false;
        resetGate(video.currentTime);
        setStatus("Đang đồng bộ vị trí mới...");
      }
    });

    video.addEventListener("seeked", () => {
      if (video === activeVideo) {
        sendClientLog("VIDEO_SEEKED", `currentTime=${video.currentTime.toFixed(1)}s, queuedBatches=${pendingMseBatches.length}`);
        processNextMseBatch();
      }
    });
  }

  // Initialize detector
  new window.MovieVoiceDetector(
    (video) => {
      activeVideo = video;
      resetGate(video.currentTime || 0);
      bindVideoEvents(video);
      mountUI(video);
      sendClientLog("VIDEO_DETECTED", `duration=${(video.duration || 0).toFixed(1)}s, currentTime=${(video.currentTime || 0).toFixed(1)}s`);
      window.postMessage({ type: "__MOVIE_VOICE_PLAYER_READY__" }, "*");
      processNextMseBatch();
    },
    async (sub) => {
      // Soft subtitle detected
      if (!config.enabled || !activeVideo) return;
      const payload = {
        cues: [{ start: sub.start, end: sub.end, text: sub.text }],
        voice: config.voice,
        rate: config.rate,
        pitch: config.pitch,
        is_vietnamese: true
      };
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "DUB_SUBTITLES", payload }, (res) => {
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
