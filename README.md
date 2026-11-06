# 🎬 Movie Voiceover - AI Video Dubbing & Voiceover

> **Bản hiện tại: v3 — Player xử lý trước và ghép giọng vào video.** Bắt đầu ở [hướng dẫn v3](README-v3.md). Các ghi chú OCR bên dưới mô tả bản cũ; OCR không còn là đường phát mặc định.

Hệ thống tự động phát hiện phụ đề và lồng tiếng / thuyết minh phim theo thời gian thực bằng giọng AI tiếng Việt tự nhiên (Microsoft Edge TTS: Hoài My / Nam Minh), tối ưu cho việc xem phim trên web và chia sẻ qua Google Meet.

## Bản sửa ổn định phát giọng (05/11/2026)

- Server dùng Python riêng trong `server/.venv`; `run_server.bat` tự cài thư viện từ `requirements.txt` khi chạy. Giữ server hoạt động lúc xem phim.
- Sau khi cập nhật mã: mở trang quản lý tiện ích Chrome/Edge, bấm **Tải lại** Movie Voiceover rồi tải lại trang phim. Bản này dùng thêm quyền `webNavigation` để xác định vị trí iframe khi OCR.
- Phim có chữ gắn sẵn trong hình (như player phimapi trên phim4k được kiểm tra) cần bật **📷 Sub Cứng**. Giữ tab phim đang được chọn và vùng phụ đề trong màn hình để chụp OCR đúng.
- Thanh AI hiển thị lỗi tạo giọng/OCR hoặc yêu cầu tương tác để cho phép âm thanh. Trình duyệt tích hợp không tự cài tiện ích Chrome từ thư mục project; không có thanh AI nghĩa là cần kiểm tra việc tải tiện ích vào trình duyệt đang dùng.
- Các câu được tải trước và phát theo thứ tự; tua/tắt AI hủy câu cũ. Hàng đợi giới hạn hai câu; câu OCR quá 2,5 giây và câu DOM quá 3 giây bị bỏ thay vì đọc sang cảnh khác.
- Edge TTS phụ thuộc mạng/dịch vụ bên ngoài. Lần thử cuối dùng cùng giọng với tốc độ/cao độ chuẩn nếu thông số tùy chỉnh thất bại. OCR có thể mất dấu hoặc nhận sai chữ; bản này chưa nhận diện/dịch trực tiếp lời thoại trong âm thanh.

### Sửa nhận chữ và đọc nhầm

OCR dùng Tesseract tiếng Việt chạy cục bộ qua Node.js, thay cho bộ nhận chữ Trung/Anh trước đây. Cần Node.js; `run_server.bat` cài `server/ocr/package-lock.json` và kiểm tra model tiếng Việt. Model lấy từ [tessdata_best chính thức](https://github.com/tesseract-ocr/tessdata_best/blob/main/vie.traineddata), giữ nguyên điều khoản Apache 2.0 của nguồn.

Chỉ nhận chữ có độ tin cậy từ 75 và ổn định hai lần quét; bỏ chữ quảng cáo, địa chỉ web, chuỗi số dài, chữ Hy Lạp/Cyrillic/Hán lẫn vào kết quả. Video ngắn dưới 90 giây bị bỏ qua để tránh đọc quảng cáo; vì vậy chế độ này dành cho phim, không dành cho clip ngắn. Khi có phụ đề mềm, OCR nhường cho nguồn phụ đề đó. Đã bỏ bộ chọn DOM quá rộng có thể đọc nhầm menu caption.

Thanh AI hiển thị thêm chính câu đang đọc để đối chiếu. OCR vẫn có thể nhầm dấu trên font phụ đề hẹp; bài kiểm tra ảnh thật hiện nhận đúng phần lớn câu, còn nhầm “Sự” thành “Sư”. Không tự đoán hoặc dịch nội dung nhận sai.

Chạy kiểm tra từ thư mục gốc (server đang hoạt động cho bài smoke):

```powershell
node test/playback_regression.cjs
node test/iframe_crop_regression.cjs
server/.venv/Scripts/python.exe test/ocr_vietnamese_regression.py
server/.venv/Scripts/python.exe test/server_smoke.py
```

Đã kiểm tra server tạo MP3 cho giọng nam/nữ và câu thoại dài, OCR ảnh phụ đề có dấu và ảnh phim thật, cùng các tình huống bất đồng bộ trong hàng đợi. Đã quan sát tiện ích chạy trong player thật; sau mỗi lần sửa content script vẫn cần tải lại tiện ích và trang phim để kiểm tra bản mới đầu-cuối.

---

## 🚀 Hướng dẫn cài đặt & Dùng thử (Chỉ mất 1 phút)

### Bước 1: Khởi động Server TTS
1. Mở thư mục `server/`.
2. Nhấp đúp vào file **`run_server.bat`**.
3. Cửa sổ dòng lệnh hiện thông báo:
   ```
   Khởi động Movie Voiceover TTS Server tại http://127.0.0.1:8765...
   INFO: Uvicorn running on http://127.0.0.1:8765
   ```
*(Giữ cửa sổ này mở trong lúc xem phim).*

---

### Bước 2: Cài Extension vào trình duyệt (Chrome / Edge / Cốc Cốc)
1. Mở trình duyệt, truy cập vào: `chrome://extensions` (hoặc `edge://extensions`).
2. Bật công tắc **Developer mode (Chế độ cho nhà phát triển)** ở góc trên bên phải.
3. Bấm vào nút **Load unpacked (Tải tiện ích đã giải nén)** ở góc trên bên trái.
4. Chọn thư mục: `E:\Movie Voice\extension`.
5. Bạn sẽ thấy tiện ích **"Movie Voiceover - Lồng tiếng phim AI"** xuất hiện.

---

### Bước 3: Dùng thử ngay
1. Mở file `E:\Movie Voice\test\test_player.html` bằng Chrome:
   * Kéo thả file `test/test_player.html` vào tab trình duyệt.
2. Bấm vào icon tiện ích trên thanh công cụ để mở bảng cài đặt (chọn giọng Nữ Hoài My hoặc Nam Minh, chỉnh âm lượng ducking).
3. Bấm Play video trên trang thử nghiệm:
   * Giọng thuyết minh sẽ tự động cất lên theo từng dòng phụ đề.
   * Tiếng video gốc sẽ tự động nhỏ lại để nghe rõ giọng thuyết minh!

---

### Bước 4: Xem chung trên Google Meet với bạn bè
1. Mở web phim bất kỳ bạn muốn xem.
2. Vào phòng **Google Meet**.
3. Bấm nút **Chia sẻ màn hình** $\rightarrow$ chọn mục **Thẻ Chrome (A Chrome tab)** $\rightarrow$ chọn thẻ đang mở web phim.
4. **Quan trọng:** Tích chọn ô **"Chia sẻ âm thanh thẻ" (Also share tab audio)**.
5. Cả bạn và bạn của bạn sẽ cùng thưởng thức bộ phim có giọng thuyết minh tiếng Việt stereo sắc nét!
