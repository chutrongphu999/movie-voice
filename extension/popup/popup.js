document.addEventListener("DOMContentLoaded", () => {
  const ENGINE_URL = "http://127.0.0.1:8765";

  const statusBadge = document.getElementById("statusBadge");
  const toggleEnabled = document.getElementById("toggleEnabled");
  const selectVoice = document.getElementById("selectVoice");
  const sliderDucking = document.getElementById("sliderDucking");
  const duckingVal = document.getElementById("duckingVal");
  const sliderRate = document.getElementById("sliderRate");
  const rateVal = document.getElementById("rateVal");
  const btnTestVoice = document.getElementById("btnTestVoice");

  // Load saved config
  chrome.storage.sync.get({
    enabled: true,
    voice: "vi-VN-HoaiMyNeural",
    ducking: 0.20,
    rate: 0
  }, (items) => {
    toggleEnabled.checked = items.enabled;
    selectVoice.value = items.voice;
    sliderDucking.value = Math.round(items.ducking * 100);
    duckingVal.innerText = `${sliderDucking.value}%`;
    sliderRate.value = items.rate;
    rateVal.innerText = `${sliderRate.value > 0 ? '+' : ''}${sliderRate.value}%`;
  });

  // Check engine health
  fetch(`${ENGINE_URL}/api/health`)
    .then(r => r.json())
    .then(data => {
      if (data.status === "online") {
        statusBadge.innerText = "Engine Sẵn sàng";
        statusBadge.className = "status-badge online";
      } else {
        throw new Error();
      }
    })
    .catch(() => {
      statusBadge.innerText = "Chưa bật run.bat";
      statusBadge.className = "status-badge offline";
    });

  // Save changes
  toggleEnabled.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: toggleEnabled.checked });
  });

  selectVoice.addEventListener("change", () => {
    chrome.storage.sync.set({ voice: selectVoice.value });
  });

  sliderDucking.addEventListener("input", () => {
    const val = parseInt(sliderDucking.value, 10);
    duckingVal.innerText = `${val}%`;
    chrome.storage.sync.set({ ducking: val / 100 });
  });

  sliderRate.addEventListener("input", () => {
    const val = parseInt(sliderRate.value, 10);
    rateVal.innerText = `${val > 0 ? '+' : ''}${val}%`;
    chrome.storage.sync.set({ rate: val });
  });

  // Test voice
  let testAudio = null;
  btnTestVoice.addEventListener("click", () => {
    btnTestVoice.innerText = "⏳ Đang tạo giọng...";
    btnTestVoice.disabled = true;

    if (testAudio) {
      testAudio.pause();
    }

    fetch(`${ENGINE_URL}/api/dub/subtitles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cues: [{ start: 0, end: 3, text: "Xin chào bạn, tính năng lồng tiếng phim AI đang hoạt động rất tốt!" }],
        voice: selectVoice.value,
        rate: parseInt(sliderRate.value, 10),
        is_vietnamese: true
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.cues && data.cues.length > 0) {
          testAudio = new Audio(`${ENGINE_URL}${data.cues[0].audio_url}`);
          testAudio.play();
          testAudio.onended = () => {
            btnTestVoice.innerText = "🔊 Nghe thử giọng";
            btnTestVoice.disabled = false;
          };
        } else {
          throw new Error();
        }
      })
      .catch(() => {
        alert("Không thể kết nối với Movie Voice Engine. Hãy đảm bảo bạn đã mở engine/run.bat!");
        btnTestVoice.innerText = "🔊 Nghe thử giọng";
        btnTestVoice.disabled = false;
      });
  });
});
