// Movie Voice - Background Service Worker (Manifest V3)
const DEFAULT_ENGINE = "http://127.0.0.1:8765";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Movie Voice] Extension installed successfully.");
  chrome.storage.sync.set({
    enabled: true,
    voice: "vi-VN-HoaiMyNeural",
    ducking: 0.20,
    rate: 0
  });
});
