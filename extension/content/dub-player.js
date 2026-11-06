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

  // Scheduler loop: checks cueQueue every 100ms and plays lines sequentially
  setInterval(() => {
    if (!config.enabled || !activeVideo || activeVideo.paused || isSpeaking || cueQueue.length === 0) {
      return;
    }

    const currTime = activeVideo.currentTime;

    // 1. Drop cues that are too old (ended more than 12s before current playhead)
    while (cueQueue.length > 0 && currTime > cueQueue[0].end + 12.0) {
      const dropped = cueQueue.shift();
      sendClientLog("CUE_EXPIRED", `Cue ${dropped.start.toFixed(1)}s..${dropped.end.toFixed(1)}s dropped at video=${currTime.toFixed(1)}s`);
    }
    if (cueQueue.length === 0) return;

    const nextCue = cueQueue[0];

    // 2. If the next cue is due now (and not >12s in the future after a backward seek), play it!
    if (currTime >= nextCue.start - 0.35 && currTime <= nextCue.end + 12.0) {
      cueQueue.shift();
      let speed = 1.0 + (config.rate || 0) / 100;
      const lag = currTime - nextCue.start;
      if (lag > 1.5 || cueQueue.length >= 2) {
        speed = Math.min(1.30, Math.max(speed, 1.15));
      }
      playCueNow(nextCue, Math.max(0.8, Math.min(1.35, speed)));
    }
  }, 100);

  // Playhead-synchronized MSE Batch Scheduler:
  // Always picks the earliest batch right at/ahead of activeVideo.currentTime (within +32s lookahead)
  async function processNextMseBatch() {
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
        sendClientLog("VIDEO_SEEKED", `currentTime=${video.currentTime.toFixed(1)}s, queuedBatches=${pendingMseBatches.length}`);
        processNextMseBatch();
      }
    });
  }

  // Initialize detector
  new window.MovieVoiceDetector(
    (video) => {
      activeVideo = video;
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
