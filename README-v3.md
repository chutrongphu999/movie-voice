# Movie Voice v3 — lồng tiếng đồng bộ

Player xử lý trước lời thoại, tạo giọng rồi ghép vào video. Trình duyệt phát một luồng đã có hình, tiếng gốc và tiếng Việt; không có hàng đợi âm thanh đọc đuổi theo phụ đề trên màn hình.

## Bắt đầu

1. Chạy `server/run_server.bat` (Python 3.10+). Lần đầu cần Internet để cài thư viện; FFmpeg đi kèm gói `imageio-ffmpeg`.
2. Mở **http://127.0.0.1:8765/player/** bằng Chrome hoặc Edge.
3. Vào **Cài đặt Gemini**, nhập API key từ Google AI Studio, lưu và kiểm tra key/tạo giọng thử. Không gửi key vào chat. Key nằm ở `server/.local-settings.json`, không trả ngược qua API và đã được bỏ qua trong `.gitignore`. File này lưu key dạng văn bản trên máy; không chia sẻ nó.
4. Nạp lại tiện ích từ thư mục `extension/` ở trang quản lý tiện ích rồi tải lại trang phim. Bấm **Mở phim này trong player đồng bộ**. Tiện ích chuyển nguồn phim và vị trí hiện tại tới player cục bộ, rồi tạm dừng trang gốc.
5. Bấm **Chuẩn bị & mở phim**. Chờ phần đầu có đủ hình/giọng rồi bấm **Phát phim**. Tua bằng thanh thời gian bên dưới player.

Cũng có thể dán link MP4/HLS trực tiếp hoặc chọn video trên máy (tối đa 4 GB). Link trang phim không phải link media; hãy dùng nút tiện ích để lấy nguồn. Nếu trang dùng link hết hạn, yêu cầu cookie đặc biệt hoặc DRM, việc đọc nguồn có thể thất bại; không có cơ chế vượt bảo vệ.

## Gemini và phụ đề

- Không có SRT: gửi phần âm thanh của từng đoạn tới Gemini để nhận diện/dịch thành câu tiếng Việt có timestamp; sau đó gọi Gemini TTS.
- Có SRT/VTT tiếng Việt: dùng trực tiếp câu và thời gian trong file, không OCR. Cần xác nhận phụ đề khớp bản phim. Phụ đề chồng mốc thời gian hoặc dài hơn phim bị từ chối.
- Model nhận diện/dịch mặc định `gemini-3.1-flash-lite`; TTS Gemini tùy chọn `gemini-3.8-flash-tts`, giọng `Kore`. Có thể đổi model theo quyền truy cập của key. Kiểm tra kết nối gọi một câu văn bản và tạo mẫu giọng cục bộ để nghe thử. Khi chọn Gemini TTS, model TTS chỉ được gọi trong xử lý phim.
- Giọng mặc định là **Piper tiếng Việt chạy cục bộ**, tạo âm thanh không cần mạng hoặc quota TTS. Gemini chỉ nhận diện/dịch khi thiếu SRT. Chất giọng cục bộ khác giọng Gemini và không clone người nói.
- Giọng Gemini là tùy chọn khi có đủ hạn mức TTS; trong kiểm thử phim thật, key đã qua câu thử nhưng vẫn gặp HTTP 429 khi tạo nhiều câu. Giọng Edge là đường thử nghiệm khác, vẫn phụ thuộc dịch vụ bên ngoài.
- Cài đặt/giọng mới có hiệu lực với phim mới; key/model được đọc lại khi bấm **Thử lại đoạn lỗi**.

Âm thanh không được gửi tới Google chỉ vì mở trang hoặc bấm mở player từ tiện ích; việc xử lý bắt đầu khi bấm **Chuẩn bị & mở phim**. Dùng hạn mức/thanh toán theo tài khoản Gemini của bạn; đây không phải chế độ AI miễn phí không giới hạn.

## Cách giữ đồng bộ

- Phim chia thành đoạn 20 giây; hai đoạn được xử lý song song, tối đa khoảng 60–80 giây phía trước vị trí phát. Player chờ ít nhất 20 giây sẵn sàng trước khi nạp vùng phát mới (hoặc phần còn lại nếu sắp hết phim).
- Mỗi đoạn chỉ được công bố vào playlist sau khi tạo giọng và ghép âm thanh thành công. Player không nhận file đang ghi dở.
- Giọng được chỉnh tốc độ bằng `atempo`, giữ cao độ. Nếu cần tăng quá 1,8 lần để vừa khung thoại, đoạn dừng với thông báo thay vì cắt câu. Câu SRT đi qua ranh giới được tạo một lần và cắt nối cùng một audio.
- Tua tới vùng chưa xử lý sẽ chờ chuẩn bị ở vùng đó; giọng cảnh cũ không thể tiếp tục vì nằm trong luồng video cũ đã bị hủy.
- Nếu AI, mạng hoặc CPU không theo kịp tốc độ phim, player có thể phải chờ thêm. Bộ đệm giúp giữ đồng bộ; không đảm bảo không dừng trên mọi máy/mạng. Giao diện hiển thị số giây sẵn sàng và cảnh báo khi xử lý chậm hơn thời gian thực.
- Thời gian Gemini nhận diện/dịch là ước lượng từ audio, không phải hệ thống khớp khẩu hình. Cần đối chiếu bản dịch trên phim thật; không tuyên bố chính xác từng khung hình.
- Đầu ra tối đa rộng 1280 px để giảm tải CPU. Đây là bản thuyết minh, tiếng gốc chỉ hạ nhỏ trong khung có lời Việt, không tách hoàn toàn lời gốc khỏi nhạc nền.

## Xem chung Google Meet

Mở **http://127.0.0.1:8765/player/** trong **cùng Chrome với Google Meet**. Nếu đã chuẩn bị phim trong trình duyệt tích hợp, tab Chrome vẫn nối lại phim từ server cục bộ; không cần tạo giọng lại. Trong Meet chọn **Trình bày → Một thẻ Chrome → tab Movie Voice**, bật **chia sẻ âm thanh thẻ**. Vì giọng Việt nằm trong audio của video, không phụ thuộc âm thanh hệ thống hay micro. Đã kiểm tra luồng media có cả hai loại âm thanh; vẫn cần một người ở đầu bên kia xác nhận việc nhận âm thanh thực tế qua Meet.

## Lưu trữ và vòng đời

- Chỉ một phiên phim xử lý tại một thời điểm. Mở phim mới hủy tác vụ phim cũ.
- Đóng phim hủy FFmpeg/các yêu cầu đang chờ và xóa media của phiên, kể cả bản sao file upload đã dùng. File gốc của bạn không bị chỉnh sửa.
- Cache quanh vị trí phát được giới hạn theo số đoạn; tua về xa có thể phải xử lý lại. Phiên nghỉ quá 30 phút ngừng chuẩn bị thêm. File upload chưa mở thành công có thể còn trong `server/.cache/uploads/`; có thể dọn cache khi server đã dừng.
- Trạng thái và các đoạn đã chuẩn bị được lưu cục bộ. Sau khi khởi động lại server, phiên gần nhất được khôi phục; tác vụ AI chỉ tiếp tục khi player kết nối lại. Mở lại cùng nguồn/giọng/phụ đề sẽ dùng lại phần đã chuẩn bị thay vì tự xử lý từ đầu.

## Kiểm tra

Chạy từ thư mục gốc:

```powershell
server/.venv/Scripts/python.exe test/test_vod.py
server/.venv/Scripts/python.exe -m pip install httpx
server/.venv/Scripts/python.exe test/test_vod_api.py
node test/playback_regression.cjs
node test/iframe_crop_regression.cjs
```

Các bài VOD kiểm tra dữ liệu phụ đề, mốc thời gian, lỗi provider, câu vượt ranh giới đoạn, vị trí giọng trong âm thanh đã ghép bằng phân tích tần số, tua sang vùng mới, bảo vệ API cục bộ, và không trả key. Chúng không thay thế kiểm thử dịch thuật/giọng Gemini trên phim thật hoặc kiểm thử hai đầu Meet.

`test/prepare_sync_demo.py` tạo clip/launch cục bộ để thử player trong trình duyệt bằng SRT và Edge TTS.

## Thành phần và tham khảo

- Player: [hls.js](https://github.com/video-dev/hls.js), bản đóng gói trong `server/web/vendor/`, kèm giấy phép Apache 2.0.
- FFmpeg: bản đi kèm [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg), chỉ dùng nội bộ trên máy.
- Gemini: [audio understanding](https://ai.google.dev/gemini-api/docs/audio), [speech generation](https://ai.google.dev/gemini-api/docs/speech-generation).
- Giọng cục bộ: [Piper](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0), model [vi_VN-vais1000-medium](https://huggingface.co/rhasspy/piper-voices/tree/main/vi/vi_VN/vais1000/medium). Dataset CC BY 4.0, thông tin được giữ trong `server/models/PIPER-MODEL-CARD.txt`. `run_server.bat` tải model lần đầu bằng `setup_voice.py`.
- Tham khảo cơ chế xử lý trước và player cùng timeline từ tài liệu [VietNote](https://vietnote.vn/huong-dan) và mã nguồn [Avorythm](https://github.com/msmahdinejad/avorythm). Không sao chép mã hoặc đóng gói các ứng dụng đó.
