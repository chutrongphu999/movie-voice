# 🎬 Movie Voice Studio v6 — Lồng Tiếng & Thuyết Minh Phim AI

Hệ thống thuyết minh phim tự động **khớp 100% phụ đề trên hình (Hard-Sub Vietsub)** và phát trực tiếp trên **Web Cinema Player** hoặc chia sẻ qua **Google Meet**.

---

## 🌟 Tính năng nổi bật

1. **Movie Voice Studio v6 (`http://127.0.0.1:8765`):**
   - **Tải luồng `.m3u8` siêu tốc (24 luồng song song):** Chỉ cần bấm nút **`🎬 Studio`** trên trang xem phim (Motchill, RoPhim, Phimmoi...) hoặc chọn file `.mp4`/`.mkv` trên máy.
   - **Khớp 100% Phụ Đề Trên Hình (`Hard-Sub Vietsub`):** Quét vùng phụ đề đáy video bằng OpenCV + Contact-Sheet Vision OCR để lấy chính xác từng chữ Tiếng Việt và đúng từng mili-giây chữ xuất hiện/biến mất.
   - **Hỗ trợ File Phụ Đề Rời (`.srt` / `.vtt`) & Phim Raw (Groq Whisper ASR + Dịch ngữ cảnh Gemini).**
   - **Hòa âm chuẩn phòng thu (Auto-Ducking 24kHz) & Đóng gói `.mp4` (`-c:v copy`):** Tự động hạ nhạc nền xuống 22% khi có tiếng thuyết minh, giữ nguyên 100% độ nét gốc và cho phép tua bất kỳ vị trí nào (`0ms` độ trễ).

---

## 🚀 Hướng dẫn cài đặt khi Clone sang máy mới

### Bước 1: Clone dự án
```powershell
git clone https://github.com/chutrongphu999/movie-voice.git
cd movie-voice
```

### Bước 2: Khởi động Engine & Studio
1. Mở thư mục `engine/` và nhấp đúp vào **`run.bat`**.
2. Ở lần chạy đầu tiên, `run.bat` sẽ **tự động tạo môi trường Python `.venv` và cài đặt toàn bộ thư viện** trong `requirements.txt`.
3. Mở trình duyệt truy cập **[http://127.0.0.1:8765](http://127.0.0.1:8765)** (và điền `GEMINI_API_KEY` / `GROQ_API_KEY` vào file `engine/.env`).

### Bước 3: Cài đặt Extension vào Chrome / Edge / Cốc Cốc (Tùy chọn để bắt link `.m3u8` 1-Click)
1. Mở trình duyệt, truy cập `chrome://extensions` (hoặc `edge://extensions`).
2. Bật **Developer mode (Chế độ cho nhà phát triển)** ở góc trên bên phải.
3. Bấm **Load unpacked (Tải tiện ích đã giải nén)** và chọn thư mục `extension` trong dự án.
4. Khi mở trang web phim, bấm nút **`🎬 Studio`** trên thanh điều khiển video để chuyển thẳng link `.m3u8` sang Movie Voice Studio v6.
