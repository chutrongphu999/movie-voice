// Movie Voice - In-Page Web Audio Dubbing Player
// Receives MSE audio chunks & soft subtitles, sends to Engine, and schedules dubbing playback with Smart Ducking
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
      updateUI();
    });
  }

  // Audio Context for low-latency playback independent of page CSP
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  let activeVideo = null;
  let audioChunksBuffer = [];
  let bufferTotalBytes = 0;
  let isUploadingChunk = false;
  let cueQueue = [];
  let currentPlayingSource = null;
  let isDucked = false;
  let baseVideoVolume = 1.0;
  let fadeInterval = null;
  let restoreTimeout = null;

  // Smart Ducking: smoothly adjusts video volume
  function rampVideoVolume(targetVolume, durationMs = 180) {
    if (!activeVideo) return;
    if (fadeInterval) clearInterval(fadeInterval);

    const startVol = activeVideo.volume;
    const diff = targetVolume - startVol;
    if (Math.abs(diff) < 0.01) {
      activeVideo.volume = targetVolume;
      return;
    }

    const steps = 10;
    const stepTime = durationMs / steps;
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
    if (!activeVideo || isDucked) return;
    if (restoreTimeout) clearTimeout(restoreTimeout);
    baseVideoVolume = activeVideo.volume > 0.05 ? activeVideo.volume : 1.0;
    isDucked = true;
    rampVideoVolume(baseVideoVolume * config.ducking, 150);
  }

  function restoreDucking() {
    if (!activeVideo || !isDucked) return;
    if (restoreTimeout) clearTimeout(restoreTimeout);
    restoreTimeout = setTimeout(() => {
      isDucked = false;
      rampVideoVolume(baseVideoVolume, 300);
    }, 450);
  }

  // Plays audio buffer through Web Audio API
  async function playDubCue(cue) {
    if (!config.enabled || !activeVideo || activeVideo.paused) return;

    try {
      const ctx = getAudioContext();
      setStatus(`🎙️ Lồng tiếng: ${cue.text}`);

      const audioUrl = `${ENGINE_URL}${cue.audio_url}`;
      const resp = await fetch(audioUrl);
      const arrayBuf = await resp.arrayBuffer();
      const decodedBuf = await ctx.decodeAudioData(arrayBuf);

      if (!activeVideo || activeVideo.paused) return;

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = decodedBuf;
      sourceNode.connect(ctx.destination);

      currentPlayingSource = sourceNode;
      applyDucking();

      sourceNode.onended = () => {
        currentPlayingSource = null;
        restoreDucking();
        setStatus("Sẵn sàng");
      };

      sourceNode.start(0);
    } catch (e) {
      console.warn("[Movie Voice] Audio playback error:", e);
      restoreDucking();
    }
  }

  // Periodic playback queue monitor synced to video.currentTime
  setInterval(() => {
    if (!config.enabled || !activeVideo || activeVideo.paused || cueQueue.length === 0) return;

    const currTime = activeVideo.currentTime;
    for (let i = 0; i < cueQueue.length; i++) {
      const cue = cueQueue[i];
      // If cue start time is within 0.4s of current video time, trigger playback
      if (Math.abs(currTime - cue.start) < 0.5 || (currTime >= cue.start && currTime <= cue.end)) {
        cueQueue.splice(i, 1);
        playDubCue(cue);
        break;
      }
      // Drop cues that have expired
      if (currTime > cue.end + 2.0) {
        cueQueue.splice(i, 1);
        i--;
      }
    }
  }, 150);

  // Send accumulated MSE audio chunks to Engine
  async function flushMseBuffer() {
    if (!config.enabled || isUploadingChunk || audioChunksBuffer.length === 0 || !activeVideo) return;
    if (bufferTotalBytes < 120000) return; // Wait for at least ~120KB of audio data

    isUploadingChunk = true;
    const chunksToSend = audioChunksBuffer.slice(0);
    audioChunksBuffer = [];
    bufferTotalBytes = 0;

    const totalLen = chunksToSend.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunksToSend) {
      merged.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }

    const timeOffset = Math.max(0, activeVideo.currentTime - 2.0);
    const formData = new FormData();
    formData.append("file", new Blob([merged], { type: "audio/mp4" }), "stream.mp4");
    formData.append("time_offset", String(timeOffset));
    formData.append("voice", config.voice);
    formData.append("rate", String(config.rate));
    formData.append("pitch", String(config.pitch));

    setStatus("⚡ Đang nhận diện & lồng tiếng...");

    try {
      const resp = await fetch(`${ENGINE_URL}/api/dub/audio`, {
        method: "POST",
        body: formData
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.cues && data.cues.length > 0) {
          for (const cue of data.cues) {
            cueQueue.push(cue);
          }
          setStatus(`Đã nạp ${data.cues.length} câu lồng tiếng`);
        } else {
          setStatus("Đang phát phim");
        }
      }
    } catch (err) {
      // Server not reachable or network issue
    } finally {
      isUploadingChunk = false;
    }
  }

  // Receive MSE chunks from MAIN world mse-hook.js
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "__MOVIE_VOICE_MSE_CHUNK__" && event.data.buffer) {
      audioChunksBuffer.push(event.data.buffer);
      bufferTotalBytes += event.data.byteLength;

      // Periodically trigger flush when enough data arrives
      if (bufferTotalBytes > 250000) {
        flushMseBuffer();
      }
    }
  });

  // UI elements
  let uiContainer = null;
  let statusTextEl = null;

  function setStatus(text) {
    if (statusTextEl) {
      statusTextEl.innerText = text;
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
      <span class="mv-status-text">Đang kết nối...</span>
    `;

    uiContainer.querySelector(".mv-toggle-btn").addEventListener("click", () => {
      config.enabled = !config.enabled;
      if (!config.enabled && currentPlayingSource) {
        try { currentPlayingSource.stop(); } catch (e) {}
        restoreDucking();
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

  // Initialize detector
  new window.MovieVoiceDetector(
    (video) => {
      activeVideo = video;
      mountUI(video);
    },
    async (sub) => {
      // Soft subtitle detected
      if (!config.enabled || !activeVideo) return;
      try {
        const resp = await fetch(`${ENGINE_URL}/api/dub/subtitles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cues: [{ start: sub.start, end: sub.end, text: sub.text }],
            voice: config.voice,
            rate: config.rate,
            pitch: config.pitch,
            is_vietnamese: true
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.cues && data.cues.length > 0) {
            for (const c of data.cues) {
              cueQueue.push(c);
            }
          }
        }
      } catch (e) {}
    }
  );

  // Periodically flush buffer every 3s if new chunks exist
  setInterval(flushMseBuffer, 3000);
})();
