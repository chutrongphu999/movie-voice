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

  // Enqueue cues and immediately prefetch their silence-trimmed MP3 audio bytes
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
      subtitleHistory.push({ start: cue.start, end: cue.slot_end || (cue.end + 0.35), text: cue.text });
      added++;
    }
    cueQueue.sort((a, b) => a.start - b.start);
    if (subtitleHistory.length > 150) {
      subtitleHistory = subtitleHistory.slice(-100);
    }
    if (added > 0 && !isSpeaking) {
      setStatus(`Sẵn sàng (${cueQueue.length} câu chờ đọc)`);
    }
  }

  // Zero-Drift Time-Stretching Playback (from LocalDub & real-time-video-subs)
  async function playCueNow(cue, slotEnd) {
    if (!config.enabled || !activeVideo || activeVideo.paused) return;
    isSpeaking = true;
    activeCueSlotEnd = slotEnd;
    activeSpeakingText = cue.text;
    renderSubBanner();

    try {
      const payload = await (cue.audioPromise || fetchVoicePayload(cue.audio_url));
      if (!payload || !payload.arrayBuf || !config.enabled || !activeVideo || activeVideo.paused) {
        isSpeaking = false;
        activeSpeakingText = "";
        renderSubBanner();
        return;
      }

      setStatus(`🎙️ ${cue.text}`);
      applyDucking();

      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        await Promise.race([
          ctx.resume().catch(() => {}),
          new Promise((r) => setTimeout(r, 200))
        ]);
      }

      const videoRate = activeVideo.playbackRate || 1.0;
      const baseSpeed = (1.0 + (config.rate || 0) / 100) * videoRate;

      let playedViaWebAudio = false;
      if (ctx && ctx.state === "running") {
        try {
          const decoded = await ctx.decodeAudioData(payload.arrayBuf.slice(0));
          const nowTime = activeVideo.currentTime;
          const availWindow = Math.max(0.45, slotEnd - Math.max(nowTime, cue.start));

          // Zero-Drift Time-Stretching: dynamically stretch/compress to fit exact remaining scene window
          const fitRate = decoded.duration / availWindow;
          const playbackRate = Math.max(0.95, Math.min(1.48, Math.max(baseSpeed, fitRate)));

          // If cue arrived slightly after cue.start and even 1.48x exceeds availWindow, offset slightly into audio
          let startOffset = 0;
          if (nowTime > cue.start + 0.55 && decoded.duration / playbackRate > availWindow + 0.3) {
            startOffset = Math.min(decoded.duration * 0.22, Math.max(0, (nowTime - cue.start - 0.55) * 0.35));
          }

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
            source.start(0, startOffset);
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
            const availWindow = Math.max(0.45, slotEnd - Math.max(nowTime, cue.start));
            const audioDur = fallbackAudioEl.duration || cue.duration || 2.0;
            const playbackRate = Math.max(0.95, Math.min(1.48, Math.max(baseSpeed, audioDur / availWindow)));
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
    }
  }

  // 50ms Zero-Drift Scheduler loop (from real-time-video-subs & LocalDub)
  setInterval(() => {
    renderSubBanner();
    if (!config.enabled || !activeVideo || activeVideo.paused || cueQueue.length === 0) {
      return;
    }

    const currTime = activeVideo.currentTime;

    // 1. Only drop cues that the video has completely passed (> 2.2s past cue.end)
    while (cueQueue.length > 0 && currTime > cueQueue[0].end + 2.2) {
      const dropped = cueQueue.shift();
      sendClientLog("CUE_SKIPPED_LATE", `Skipped stale ${dropped.start.toFixed(1)}s..${dropped.end.toFixed(1)}s at video=${currTime.toFixed(1)}s`);
    }
    if (cueQueue.length === 0) return;

    // 2. If multiple cues piled up and currTime is already past the next cue's midpoint, advance to the current one
    while (
      cueQueue.length >= 2 &&
      currTime >= cueQueue[1].start + Math.min(0.6, (cueQueue[1].end - cueQueue[1].start) * 0.4)
    ) {
      cueQueue.shift();
    }

    // 3. Do NOT cut off a speaking sentence early unless it has severely overrun its slot (+1.1s into next cue)
    if (isSpeaking) {
      if (cueQueue.length > 0 && currTime >= Math.max(activeCueSlotEnd + 0.9, cueQueue[0].start + 1.1)) {
        stopCurrentSpeechOnly();
      } else {
        return;
      }
    }

    const nextCue = cueQueue[0];

    // 4. Trigger playback when playhead reaches nextCue.start (with 0.22s pre-roll)
    if (currTime >= nextCue.start - 0.22 && currTime <= nextCue.end + 2.2) {
      cueQueue.shift();
      const slotEnd =
        cueQueue.length > 0
          ? Math.min(nextCue.slot_end || (nextCue.end + 0.35), cueQueue[0].start - 0.04)
          : (nextCue.slot_end || (nextCue.end + 0.5));

      playCueNow(nextCue, Math.max(nextCue.start + 0.7, slotEnd));
    }
  }, TICK_MS);

  // Playhead-synchronized MSE Batch Scheduler (up to 3 concurrent requests within +45s lookahead)
  async function processNextMseBatch() {
    if (!config.enabled || hasSoftSubtitles || inFlightUploads >= 3 || pendingMseBatches.length === 0) return;

    const currTime = activeVideo ? activeVideo.currentTime : 0;

    // 1. Prune batches that are far behind current playhead (> 60s old)
    pendingMseBatches = pendingMseBatches.filter((b) => b.endTime >= currTime - 60.0);

    // 2. Sort ascending by startTime so we ALWAYS process earliest segments first
    pendingMseBatches.sort((a, b) => a.startTime - b.startTime);

    // 3. Find the earliest batch that covers current playhead or is within the next 45 seconds
    let targetIdx = -1;
    for (let i = 0; i < pendingMseBatches.length; i++) {
      const b = pendingMseBatches[i];
      if (b.endTime >= currTime - 0.5) {
        if (currTime === 0 || b.startTime <= currTime + 45.0) {
          targetIdx = i;
        }
        break;
      }
    }

    if (targetIdx === -1) {
      return;
    }

    const [batch] = pendingMseBatches.splice(targetIdx, 1);

    inFlightUploads++;
    if (!isSpeaking && cueQueue.length === 0) {
      setStatus(`⚡ Đang dịch trước đoạn ${Math.floor(batch.startTime)}s...`);
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
      } else if (!isSpeaking && cueQueue.length === 0) {
        setStatus("Đang lắng nghe thoại...");
      }
    } catch (err) {
      if (!isSpeaking) setStatus("Chưa kết nối Engine (run.bat)");
    } finally {
      inFlightUploads--;
      if (pendingMseBatches.length > 0) {
        processNextMseBatch();
      }
    }
  }

  setInterval(() => {
    if (config.enabled && !hasSoftSubtitles && pendingMseBatches.length > 0 && inFlightUploads < 3) {
      processNextMseBatch();
    }
  }, 450);

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

  window.addEventListener("message", (event) => {
    if (!event.data) return;

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
      buffer: event.data.buffer
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
        stopCurrentSpeechOnly();
        setStatus("Đang đồng bộ vị trí mới...");
      }
    });

    video.addEventListener("seeked", () => {
      if (video === activeVideo) {
        lastSubBatchSentTo = video.currentTime - 0.5;
        sendClientLog("VIDEO_SEEKED", `currentTime=${video.currentTime.toFixed(1)}s, queuedBatches=${pendingMseBatches.length}`);
        processNextMseBatch();
        pumpSoftSubtitleFile();
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
