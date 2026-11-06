# 🎬 Movie Voice v4 — Lồng Tiếng Phim AI Thời Gian Thực

Hệ thống tự động nhận diện lời thoại và lồng tiếng phim trực tiếp ngay trên trang web bạn đang xem, độ trễ cực thấp, tối ưu cho việc chia sẻ xem chung qua **Google Meet**.

---

## 🌟 Tính năng nổi bật

1. **Xem trên mọi trang web phim:** Không cần mở tab player phụ, không cần tải lại video. Extension đọc ké trực tiếp dòng âm thanh mà trình phát phim đã tải trước (MSE Buffer).
2. **Hỗ trợ phim Sub Cứng:** Trích xuất âm thanh gốc $\rightarrow$ nhận diện giọng nói siêu nhanh qua **Groq Whisper** $\rightarrow$ dịch ngữ cảnh theo lô qua **Gemini** $\rightarrow$ tạo giọng tiếng Việt qua **Edge TTS**.
3. **Smart Ducking:** Tự động hạ âm lượng video gốc êm ái khi nhân vật cất tiếng lồng tiếng và phục hồi mượt mà sau khi câu thoại kết thúc.
4. **Chia sẻ Google Meet hoàn hảo:** Toàn bộ âm thanh lồng tiếng phát ngay trong tab phim. Bạn chỉ cần chọn **Chia sẻ một thẻ Chrome** và tích **Chia sẻ âm thanh thẻ**.

---

## 🚀 Hướng dẫn khởi động & Dùng thử

### Bước 1: Khởi động Engine
1. Mở thư mục `engine/`.
2. Nhấp đúp vào file **`run.bat`**.
3. Cửa sổ dòng lệnh sẽ tự động kiểm tra thư viện và thông báo:
   ```
   INFO: Uvicorn running on http://127.0.0.1:8765
   ```
*(Giữ cửa sổ này mở trong lúc xem phim).*

---

### Bước 2: Cài đặt Extension vào Chrome / Edge / Cốc Cốc
1. Mở trình duyệt, truy cập `chrome://extensions` (hoặc `edge://extensions`).
2. Bật công tắc **Developer mode (Chế độ cho nhà phát triển)** ở góc trên bên phải.
3. Bấm vào nút **Load unpacked (Tải tiện ích đã giải nén)** ở góc trên bên trái.
4. Chọn thư mục: `F:\Movie Voice\extension`.
5. Bạn sẽ thấy tiện ích **"Movie Voice - Lồng tiếng phim AI"** xuất hiện.

---

### Bước 3: Xem phim & Chia sẻ Google Meet
1. Mở bất kỳ trang web phim nào bạn muốn xem (Phimmoi, Motchill, Phim4k, RoPhim, Youtube...).
2. Trên góc trên bên phải của video phim sẽ xuất hiện thanh điều khiển:
   ```
   [🎙️ LỒNG TIẾNG: BẬT]  Sẵn sàng
   ```
3. Bấm vào icon tiện ích trên thanh công cụ để chỉnh giọng (Hoài My / Nam Minh) hoặc mức ducking âm lượng.
4. Vào Google Meet $\rightarrow$ **Chia sẻ màn hình** $\rightarrow$ chọn **Một thẻ Chrome** (thẻ phim đang mở) $\rightarrow$ **Bật "Chia sẻ âm thanh thẻ"**.
