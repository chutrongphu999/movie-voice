// Movie Voice - In-Page Web Audio Dubbing Player v4.1
// Receives MSE audio batches & soft subtitles, prefetches TTS audio, and schedules non-overlapping dubbing with Smart Ducking
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
      if (!config.enabled) stopAllSpeech();
      updateUI();
    });
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

  function stopAllSpeech() {
    cueQueue = [];
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

  // Fetch voice audio bytes via background worker (or direct fetch fallback)
  async function fetchVoiceArrayBuffer(audioUrl) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "FETCH_VOICE_AUDIO", audioUrl }, (r) => resolve(r));
      });
      if (res && res.ok && res.b64) {
        return base64ToArrayBuffer(res.b64);
      }
    }
    const resp = await fetch(`${ENGINE_URL}${audioUrl}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.arrayBuffer();
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

      // Prefetch audio immediately so it's ready in memory before cue.start
      cue.audioPromise = fetchVoiceArrayBuffer(cue.audio_url).catch((err) => {
        console.warn("[Movie Voice] Prefetch voice failed:", err);
        return null;
      });
      cueQueue.push(cue);
      added++;
    }
    // Keep queue sorted by start time
    cueQueue.sort((a, b) => a.start - b.start);
    if (added > 0 && !isSpeaking) {
      setStatus(`Sẵn sàng (${cueQueue.length} câu chờ đọc)`);
    }
  }

  // Play a single cue using Web Audio API (with HTML5 Audio fallback)
  async function playCueNow(cue, playbackRate = 1.0) {
    if (!config.enabled || !activeVideo || activeVideo.paused) return;
    isSpeaking = true;

    try {
      const arrayBuf = await (cue.audioPromise || fetchVoiceArrayBuffer(cue.audio_url));
      if (!arrayBuf || !config.enabled || !activeVideo || activeVideo.paused) {
        isSpeaking = false;
        return;
      }

      setStatus(`🎙️ ${cue.text}`);
      applyDucking();

      const ctx = getAudioContext();
      if (ctx && ctx.state === "running") {
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
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
      } else {
        // Fallback to HTML5 Audio element if AudioContext is still suspended
        const blob = new Blob([arrayBuf], { type: "audio/mpeg" });
        const blobUrl = URL.createObjectURL(blob);
        try {
          await new Promise((resolve, reject) => {
            fallbackAudioEl.src = blobUrl;
            fallbackAudioEl.playbackRate = playbackRate;
            fallbackAudioEl.onended = () => resolve();
            fallbackAudioEl.onerror = (e) => reject(e);
            fallbackAudioEl.play().catch(reject);
          });
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        setStatus("🔊 Bấm vào khung video để cho phép âm thanh");
      } else {
        console.warn("[Movie Voice] Playback error:", err);
      }
    } finally {
      isSpeaking = false;
      restoreDucking(false);
    }
  }

  // Scheduler loop: checks cueQueue every 100ms and plays lines sequentially
  setInterval(() => {
    if (!config.enabled || !activeVideo || activeVideo.paused || isSpeaking || cueQueue.length === 0) {
      return;
    }

    const currTime = activeVideo.currentTime;

    // 1. Drop cues that are too old (ended more than 7s ago) or way in the past after a seek
    while (cueQueue.length > 0 && currTime > cueQueue[0].end + 7.0) {
      cueQueue.shift();
    }
    if (cueQueue.length === 0) return;

    const nextCue = cueQueue[0];

    // 2. If the next cue is due now (or arrived slightly late within the 7s grace window), play it!
    if (currTime >= nextCue.start - 0.25) {
      cueQueue.shift();
      // Speed up slightly if we are catching up or if more cues are waiting right behind
      let speed = 1.0 + (config.rate || 0) / 100;
      const lag = currTime - nextCue.start;
      if (lag > 1.5 || cueQueue.length >= 2) {
        speed = Math.min(1.28, Math.max(speed, 1.15));
      }
      playCueNow(nextCue, Math.max(0.8, Math.min(1.35, speed)));
    }
  }, 100);

  // Send MSE batch to Engine via background worker (or direct fetch fallback)
  async function processNextMseBatch() {
    if (!config.enabled || inFlightUploads >= 2 || pendingMseBatches.length === 0) return;

    const batch = pendingMseBatches.shift();
    // If activeVideo has already moved far past this batch, skip it
    if (activeVideo && activeVideo.currentTime > batch.endTime + 6.0 && batch.endTime > 0) {
      return;
    }

    inFlightUploads++;
    if (!isSpeaking) {
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
      if (pendingMseBatches.length > 0) {
        processNextMseBatch();
      }
    }
  }

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

    // Keep queue bounded
    if (pendingMseBatches.length > 8) {
      pendingMseBatches.shift();
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
  }

  function mountUI(video) {
    if (uiContainer && uiContainer.isConnected) return;
    uiContainer = document.createElement("div");
    uiContainer.className = "movie-voice-floating-bar";
    uiContainer.innerHTML = `
      <button class="mv-toggle-btn ${config.enabled ? 'active' : ''}">🎙️ LỒNG TIẾNG: BẬT</button>
      <span class="mv-status-text">Sẵn sàng</span>
    `;

    uiContainer.querySelector(".mv-toggle-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      getAudioContext();
      config.enabled = !config.enabled;
      if (!config.enabled) {
        stopAllSpeech();
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
    });

    video.addEventListener("pause", () => {
      if (video === activeVideo && currentSourceNode) {
        try { currentSourceNode.stop(); } catch (e) {}
      }
      restoreDucking(true);
    });

    video.addEventListener("seeking", () => {
      if (video === activeVideo) {
        stopAllSpeech();
        setStatus("Đang đồng bộ vị trí mới...");
      }
    });
  }

  // Initialize detector
  new window.MovieVoiceDetector(
    (video) => {
      activeVideo = video;
      bindVideoEvents(video);
      mountUI(video);
      // Re-signal ready in case video was dynamically created
      window.postMessage({ type: "__MOVIE_VOICE_PLAYER_READY__" }, "*");
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
