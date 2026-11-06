// Movie Voiceover Pro - Background Service Worker Proxy
// Giúp vượt qua hoàn toàn rào cản HTTPS Mixed Content, CORS và CSP trên mọi web phim thực tế

const DEFAULT_SERVER = "http://127.0.0.1:8765";

async function openSyncPlayer(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({tabId});
  const results = await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(tabId, {type:'EXTRACT_SYNC_SOURCE'}, {frameId:frame.frameId})));
  const candidates = results.filter(result=>result.status==='fulfilled'&&result.value?.source).map(result=>result.value).sort((a,b)=>(b.duration||0)-(a.duration||0));
  if (!candidates.length) {
    await chrome.tabs.create({url:`${DEFAULT_SERVER}/player/`});
    return {ok:true};
  }
  const response = await fetchWithTimeout(`${DEFAULT_SERVER}/api/launch`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(candidates[0])});
  const launch = await response.json();
  await chrome.tabs.create({url:launch.url});
  await Promise.allSettled(frames.map(frame=>chrome.tabs.sendMessage(tabId,{type:'PAUSE_FOR_SYNC'},{frameId:frame.frameId})));
  return {ok:true};
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 180)}`);
    }
    return response;
  } finally { clearTimeout(timeout); }
}

async function mapCaptureCrop(sender, crop, dpr) {
  let frameId = sender.frameId;
  while (frameId > 0) {
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId });
    if (!frame || frame.parentFrameId < 0) throw new Error('Iframe đã thay đổi, hãy thử lại');
    const result = await chrome.tabs.sendMessage(sender.tab.id, {
      type: 'MAP_OCR_CROP', childUrl: frame.url, crop
    }, { frameId: frame.parentFrameId });
    if (!result?.ok) throw new Error(result?.error || 'Không lấy được vị trí iframe');
    crop = result.crop;
    dpr = result.dpr;
    frameId = frame.parentFrameId;
  }
  return { x: crop.x * dpr, y: crop.y * dpr, w: crop.w * dpr, h: crop.h * dpr };
}

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  const serverUrl = msg.serverUrl || DEFAULT_SERVER;
  if (msg.type === 'OPEN_SYNC_PLAYER') {
    (async()=>{
      const tabId = sender.tab?.id ?? (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id;
      if (tabId == null) throw new Error('Không tìm thấy tab phim');
      return openSyncPlayer(tabId);
    })().then(sendResponse).catch(()=>sendResponse({ok:false,error:'Không mở được player. Hãy chạy server/run_server.bat rồi thử lại.'}));
    return true;
  }

  // 1. Proxy lấy âm thanh TTS từ Local Server trả về dạng Data URL (không bao giờ bị chặn bởi CSP/HTTPS)
  if (msg.type === "FETCH_TTS") {
    const query = new URLSearchParams(msg.params).toString();
    fetchWithTimeout(`${serverUrl}/tts?${query}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, audioDataUrl: `data:audio/mpeg;base64,${b64}` });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true; // Async response
  }

  // 2. Proxy chụp màn hình Tab (vượt qua lỗi Tainted Canvas CORS trên các luồng HLS/Iframe) và gửi OCR
  if (msg.type === "CAPTURE_OCR") {
    if (!sender.tab || sender.tab.windowId == null) {
      sendResponse({ ok: false, error: "No tab context" });
      return false;
    }

    (async () => {
      const [active] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
      if (active?.id !== sender.tab.id) throw new Error('Hãy mở tab phim để quét Sub Cứng');
      const crop = await mapCaptureCrop(sender, msg.crop, msg.dpr || 1);
      return crop;
    })().then((crop) => chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 78 }, async (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "Capture failed" });
        return;
      }

      try {
        let imageToSend = dataUrl;
        if (!crop || typeof OffscreenCanvas === 'undefined') throw new Error('Không cắt được vùng phụ đề; đã bỏ qua ảnh toàn tab');

        // Nếu có tọa độ vùng phụ đề, cắt (crop) bằng OffscreenCanvas ngay trong Background Worker
        if (crop && typeof OffscreenCanvas !== "undefined") {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob);

          const sx = Math.max(0, Math.floor(crop.x));
          const sy = Math.max(0, Math.floor(crop.y));
          const sw = Math.min(bitmap.width, Math.floor(crop.x + crop.w)) - sx;
          const sh = Math.min(bitmap.height, Math.floor(crop.y + crop.h)) - sy;
          if (sw <= 20 || sh <= 10) throw new Error('Vùng phụ đề nằm ngoài màn hình');

          if (sw > 20 && sh > 10) {
            const canvas = new OffscreenCanvas(sw, sh);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
            const croppedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
            const buf = await croppedBlob.arrayBuffer();
            imageToSend = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
          }
          bitmap.close();
        }

        const ocrRes = await fetchWithTimeout(`${serverUrl}/ocr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_base64: imageToSend })
        });
        const ocrData = await ocrRes.json();
        sendResponse({ ok: !ocrData.error, error: ocrData.error, text: ocrData.text || "", confidence: ocrData.confidence });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // 3. Proxy gửi ảnh base64 đã cắt sẵn từ Canvas sang OCR Server
  if (msg.type === "DIRECT_OCR") {
    fetchWithTimeout(`${serverUrl}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: msg.image_base64 })
    })
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: !data.error, error: data.error, text: data.text || "", confidence: data.confidence }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
