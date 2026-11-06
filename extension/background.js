// Movie Voice - Background Service Worker Proxy (MV3)
// Proxies Engine API calls so HTTPS movie sites and cross-origin player iframes are never blocked by Mixed Content, PNA, or CSP.
const DEFAULT_ENGINE = "http://127.0.0.1:8765";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({
    enabled: true,
    voice: "vi-VN-HoaiMyNeural",
    ducking: 0.20,
    rate: 0
  }, (items) => {
    chrome.storage.sync.set(items);
  });
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

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  const tabTitle = (sender && sender.tab && sender.tab.title) ? sender.tab.title : "";
  const movieTitle = msg.movieTitle || tabTitle || "";

  if (msg.type === "DUB_AUDIO_B64") {
    (async () => {
      try {
        const bytes = base64ToUint8Array(msg.audioB64);
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: msg.mimeType || "audio/mp4" }), "stream.mp4");
        form.append("time_offset", String(msg.timeOffset || 0));
        form.append("voice", msg.voice || "vi-VN-HoaiMyNeural");
        form.append("rate", String(msg.rate || 0));
        form.append("pitch", String(msg.pitch || 0));
        form.append("movie_title", movieTitle);

        const resp = await fetch(`${DEFAULT_ENGINE}/api/dub/audio`, {
          method: "POST",
          body: form
        });
        if (!resp.ok) {
          const errText = await resp.text();
          sendResponse({ ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 120)}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ ok: true, cues: data.cues || [] });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "DUB_SUBTITLES") {
    (async () => {
      try {
        const payload = { ...(msg.payload || {}), movie_title: movieTitle };
        const resp = await fetch(`${DEFAULT_ENGINE}/api/dub/subtitles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ ok: true, cues: data.cues || [] });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "FETCH_VOICE_AUDIO") {
    (async () => {
      try {
        const resp = await fetch(`${DEFAULT_ENGINE}${msg.audioUrl}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, audioDataUrl: `data:audio/mpeg;base64,${b64}`, b64 });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "CLIENT_LOG") {
    fetch(`${DEFAULT_ENGINE}/api/dub/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: msg.event || "LOG", detail: msg.detail || "" })
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
