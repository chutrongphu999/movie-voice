document.addEventListener("DOMContentLoaded", () => {
  const SERVER_URL = "http://127.0.0.1:8765";

  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const btnRefresh = document.getElementById("btnRefresh");
  const toggleEnabled = document.getElementById("toggleEnabled");
  const toggleOcr = document.getElementById("toggleOcr");
  const selectPreset = document.getElementById("selectPreset");
  const sliderRate = document.getElementById("sliderRate");
  const rateVal = document.getElementById("rateVal");
  const sliderPitch = document.getElementById("sliderPitch");
  const pitchVal = document.getElementById("pitchVal");
  const sliderDucking = document.getElementById("sliderDucking");
  const duckVal = document.getElementById("duckVal");
  const btnTest = document.getElementById("btnTest");

  const SAMPLE_LINES = {
    review_male: "Người đàn ông này không hề biết rằng, quyết định bước vào căn phòng bí ẩn đêm nay, sẽ thay đổi hoàn toàn vận mệnh của cả thành phố.",
    review_female: "Cô gái trẻ nở một nụ cười đầy ẩn ý, hóa ra toàn bộ kế hoạch hoàn hảo kia, đều nằm trong lòng bàn tay của cô ngay từ giây phút đầu tiên.",
    story_male: "Đêm đã khuya, ngoài hiên chỉ còn tiếng mưa rơi rả rích. Ông lão chậm rãi mở cuốn nhật ký đã nhuốm màu thời gian, bắt đầu kể về một ký ức xa xôi.",
    story_female: "Có những ngày, chúng ta chỉ muốn tìm một góc bình yên, cùng người bạn thân xem một bộ phim hay và lắng nghe từng câu chuyện nhẹ nhàng trôi qua.",
    vtv_female: "Anh không thể tin được những gì đang diễn ra trước mắt mình, tất cả mọi manh mối đều dẫn về ngôi biệt thự cổ ở ngoại ô.",
    vtv_male: "Dừng lại ngay! Chúng ta không còn nhiều thời gian nữa, hãy mau rời khỏi đây trước khi cánh cổng đóng sập lại."
  };

  function formatSign(v, unit) {
    const n = parseInt(v, 10);
    return (n >= 0 ? `+${n}` : `${n}`) + unit;
  }

  // Nạp cấu hình đã lưu
  chrome.storage.sync.get({
    enabled: true,
    ocrMode: false,
    preset: "review_male",
    rateOffset: 0,
    pitchOffset: 0,
    ducking: 0.20
  }, (items) => {
    toggleEnabled.checked = items.enabled;
    toggleOcr.checked = items.ocrMode;
    selectPreset.value = items.preset;
    sliderRate.value = items.rateOffset;
    rateVal.textContent = formatSign(items.rateOffset, "%");
    sliderPitch.value = items.pitchOffset;
    pitchVal.textContent = formatSign(items.pitchOffset, "Hz");
    sliderDucking.value = Math.round(items.ducking * 100);
    duckVal.textContent = `${sliderDucking.value}%`;
  });

  // Kiểm tra trạng thái Server & OCR
  function checkServer() {
    statusDot.className = "dot";
    statusText.textContent = "Đang kết nối...";

    fetch(`${SERVER_URL}/ping`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "ok") {
          statusDot.className = "dot connected";
          statusText.textContent = data.ocr_ready
            ? "Server Pro + AI OCR sẵn sàng"
            : "Server Pro sẵn sàng";
        } else {
          throw new Error();
        }
      })
      .catch(() => {
        statusDot.className = "dot error";
        statusText.textContent = "Chưa bật run_server.bat";
      });
  }

  checkServer();
  btnRefresh.addEventListener("click", checkServer);

  // Lưu thay đổi tức thì
  toggleEnabled.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: toggleEnabled.checked });
  });

  toggleOcr.addEventListener("change", () => {
    chrome.storage.sync.set({ ocrMode: toggleOcr.checked });
  });

  selectPreset.addEventListener("change", () => {
    chrome.storage.sync.set({ preset: selectPreset.value });
  });

  sliderRate.addEventListener("input", () => {
    const val = parseInt(sliderRate.value, 10);
    rateVal.textContent = formatSign(val, "%");
    chrome.storage.sync.set({ rateOffset: val });
  });

  sliderPitch.addEventListener("input", () => {
    const val = parseInt(sliderPitch.value, 10);
    pitchVal.textContent = formatSign(val, "Hz");
    chrome.storage.sync.set({ pitchOffset: val });
  });

  sliderDucking.addEventListener("input", () => {
    duckVal.textContent = `${sliderDucking.value}%`;
    chrome.storage.sync.set({ ducking: parseInt(sliderDucking.value, 10) / 100 });
  });

  // Nghe thử giọng Preset đang chọn
  let previewAudio = null;
  btnTest.addEventListener("click", () => {
    if (previewAudio && !previewAudio.paused) {
      previewAudio.pause();
    }

    btnTest.textContent = "⏳ Đang tạo giọng Review...";
    const preset = selectPreset.value;
    const sampleText = SAMPLE_LINES[preset] || SAMPLE_LINES.review_male;

    const params = new URLSearchParams({
      text: sampleText,
      preset: preset,
      rate_offset: sliderRate.value,
      pitch_offset: sliderPitch.value
    });

    previewAudio = new Audio(`${SERVER_URL}/tts?${params.toString()}`);

    previewAudio.onplay = () => {
      btnTest.textContent = "▶️ Đang đọc thử...";
    };

    previewAudio.onended = () => {
      btnTest.textContent = "🔊 Nghe thử giọng Review / Kể Chuyện";
    };

    previewAudio.onerror = () => {
      alert("Không kết nối được Server! Bạn hãy khởi động lại file run_server.bat nhé.");
      btnTest.textContent = "🔊 Nghe thử giọng Review / Kể Chuyện";
    };

    previewAudio.play();
  });
});
