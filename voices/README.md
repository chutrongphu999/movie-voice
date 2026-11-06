# Thư mục giọng mẫu (Voice Cloning)

Đặt các mẫu âm thanh HTV3 hoặc giọng bạn muốn lồng tiếng vào đây:

### Cấu trúc:
```
voices/
  nam_tre/
    ref.wav    (Đoạn âm thanh 5-8 giây, mono, rõ lời, không nhạc nền)
    ref.txt    (Chính xác từng từ ngữ mà nhân vật nói trong ref.wav)
  nu_tre/
    ref.wav
    ref.txt
  tre_con/     (Tùy chọn)
    ref.wav
    ref.txt
```

### Lưu ý quan trọng:
- `ref.wav` cắt sạch nhạc nền (dùng Ultimate Vocal Remover model Kim Vocal 2).
- `ref.txt` phải viết đúng 100% câu thoại trong đoạn audio để model trích xuất đặc trưng giọng chuẩn xác nhất.
