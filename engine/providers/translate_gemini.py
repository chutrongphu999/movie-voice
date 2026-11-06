"""Context-Aware Story Bible & Slot-Budget Translator for Real-Time Vietnamese Dubbing.
Directly adapts the Story Bible + asr_fixes + max_chars architecture from _refs/real-time-video-subs (rtsubs)
and _refs/VideoLingo, powered by Groq 120B/20B -> Gemini Flash -> Google Translate fallback.
"""
import os
import re
import json
import asyncio
import urllib.parse
from typing import List, Dict, Any, Optional, Tuple
import aiohttp
import groq

GROQ_MODELS = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
]

GEMINI_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
]

CHARS_PER_SEC = 17.5  # Vietnamese natural speaking rate budget for dubbing slots

SYSTEM_PROMPT = """Bạn là dịch giả thuyết minh/lồng tiếng phim chuyên nghiệp, dịch lời thoại sang tiếng Việt tự nhiên, chuẩn xác và trôi chảy. Bản dịch sẽ được đọc to (TTS) khớp vào khung thời gian của từng câu gốc.

# Dữ liệu bạn nhận:
1. TÊN PHIM & STORY BIBLE / THUẬT NGỮ: bối cảnh phim, nhân vật, cách xưng hô, thuật ngữ/địa danh và các lỗi nhận dạng giọng nói thường gặp (asr_fixes).
2. Yêu cầu dịch JSON gồm:
   - previous_lines: các câu thoại liền trước (src + vi) để nối mạch ngữ cảnh và xưng hô. KHÔNG dịch lại.
   - translate: các câu cần dịch theo thứ tự thoại, mỗi câu là {"id": số, "src": lời thoại gốc, "max_chars": giới hạn ký tự tối đa cho phép}.

# Quy tắc bắt buộc:
1. Nguồn là nhận dạng giọng nói (ASR) từ phim nên có thể bị nghe nhầm từ đồng âm hoặc tên riêng (ví dụ: 'Stard' -> 'Stark', 'Chico Thanos' -> 'Thanos'). Hãy dựa vào TÊN PHIM, STORY BIBLE và ngữ cảnh để tự hiệu đính về đúng nghĩa trong phim rồi dịch tự nhiên sang tiếng Việt.
2. Tuyệt đối KHÔNG dịch word-by-word máy móc. Dịch thoát ý, khẩu ngữ đời thực như phim chiếu rạp/HTV3 (ví dụ: 'Look,' -> 'Nghe này,'; 'What is wrong with you?' -> 'Cậu bị làm sao thế?'; 'I got this' -> 'Để tôi lo').
3. Xưng hô nhất quán theo vai và quan hệ nhân vật trong phim (anh - em, cậu - tớ, tôi - ông/bà, ngài - tôi, mày - tao).
4. Mỗi id được đọc to riêng lẻ nên phải là một câu/cụm trọn nghĩa, nghe tự nhiên khi đứng một mình. KHÔNG kết thúc bằng dấu phẩy, chấm phẩy hay hai chấm; bắt buộc kết thúc bằng . ? !
5. Súc tích, ưu tiên không vượt quá max_chars để vừa khít khẩu hình nhân vật; nếu câu gốc dài thì lược bỏ từ đệm, giữ trọn ý chính.
6. Mỗi id trả về đúng 1 bản dịch, không gộp, không tách, không bỏ sót id nào.
7. Chỉ trả về DUY NHẤT một JSON hợp lệ, không Markdown: {"items":[{"id":0,"vi":"..."},{"id":1,"vi":"..."}]}"""

UNDERSTAND_SYSTEM = """Bạn là biên tập viên kịch bản lồng tiếng phim chuyên nghiệp. Bạn nhận TÊN PHIM (nếu có) và TRANSCRIPT lời thoại của bộ phim/video sắp được thuyết minh sang tiếng Việt, và lập STORY BIBLE / BẢNG THUẬT NGỮ để người dịch dịch nhất quán, đúng ngữ cảnh.

Trả về DUY NHẤT một JSON object hợp lệ, không Markdown, với các khóa:
- synopsis: tóm tắt bối cảnh/cốt truyện phim và đoạn đang chiếu, tiếng Việt, tối đa 70 từ.
- genre_tone: thể loại và giọng điệu (ví dụ: "Phim hành động siêu anh hùng Marvel, kịch tính"), tối đa 20 từ.
- characters: tối đa 15 nhân vật chính trong phim/đoạn thoại. Mỗi mục {"name": tên gốc, "vi": cách gọi tiếng Việt, "gender": "nam"|"nữ"|"?", "role": vai trò, "calls": cách xưng hô điển hình}.
- terminology: object {"thuật ngữ/địa danh/tên riêng gốc": "cách dịch hoặc giữ nguyên chuẩn trong tiếng Việt"}, tối đa 30 mục (ví dụ: {"Tesseract": "khối Tesseract", "Avengers": "Biệt đội Avengers"}).
- asr_fixes: object {"từ ASR nghe nhầm": "từ đúng trong phim"}, tối đa 25 mục (ví dụ: {"Stard": "Stark", "Chico Thanos": "Thanos"})."""

BIBLE_KEYS = ("synopsis", "genre_tone", "characters", "terminology", "asr_fixes")


def clean_translated_line(text: str) -> str:
    """One line, and never end on a dangling comma: TTS would read it as an unfinished clause (from rtsubs)."""
    text = re.sub(r"\s+", " ", text or "").strip().strip("\"“”")
    text = re.sub(r"[,;:，；：、\s]+$", "", text)
    if text and text[-1].isalnum():
        text += "."
    return text


def extract_json_object(content: str) -> dict:
    raw = (content or "").strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    idx = raw.find("{")
    if idx < 0:
        raise ValueError("No JSON object found")
    return json.JSONDecoder().raw_decode(raw[idx:])[0]


class Translator:
    def __init__(
        self,
        gemini_key: str = None,
        groq_key: str = None,
        gemini_model: str = "gemini-3.1-flash-lite",
        groq_model: str = "openai/gpt-oss-120b"
    ):
        self.gemini_key = gemini_key or os.getenv("GEMINI_API_KEY", "")
        self.groq_key = groq_key or os.getenv("GROQ_API_KEY", "")
        self.gemini_model = gemini_model
        self.groq_model = groq_model
        self.groq_client = groq.Groq(api_key=self.groq_key) if self.groq_key else None

        # Story Bible state (from rtsubs)
        self.movie_title: str = ""
        self.bible: Dict[str, Any] = {}
        self.bible_text: str = "[STORY BIBLE]\n(chưa có)\n[HẾT STORY BIBLE]"
        self.source_lines: List[Tuple[float, str]] = []
        self._last_bible_line_count: int = 0
        self._bible_task: Optional[asyncio.Task] = None

    def update_keys(self, gemini_key: str = None, groq_key: str = None):
        if gemini_key:
            self.gemini_key = gemini_key
        if groq_key:
            self.groq_key = groq_key
            self.groq_client = groq.Groq(api_key=groq_key)

    def set_movie_title(self, title: str):
        clean_title = re.sub(r"\s+", " ", (title or "").strip())
        # Strip common streaming site suffixes
        clean_title = re.sub(
            r"(?i)\s*[-|–]\s*(xem phim|phimmoi|motchill|motphim|kkphim|ophim|phim4k|rophim|full hd|vietsub|thuyết minh).*$",
            "",
            clean_title
        ).strip()
        if not clean_title or len(clean_title) < 2:
            return
        if clean_title != self.movie_title:
            print(f"[StoryBible] Nhận diện tên phim: \"{clean_title}\"")
            self.movie_title = clean_title
            self.bible = {}
            self.bible_text = f"[TÊN PHIM]: {clean_title}\n[STORY BIBLE]\n(đang khởi tạo theo tên phim)\n[HẾT STORY BIBLE]"
            self._last_bible_line_count = 0
            self.trigger_bible_update_if_needed(force=True)

    def get_whisper_glossary_hint(self) -> str:
        """Returns character names & key terms to feed into Whisper's prompt so it recognizes proper nouns."""
        parts = []
        if self.movie_title:
            parts.append(self.movie_title)
        chars = self.bible.get("characters") or []
        char_names = [str(c.get("name", "")).strip() for c in chars if isinstance(c, dict) and c.get("name")]
        if char_names:
            parts.append(", ".join(char_names[:10]))
        terms = self.bible.get("terminology") or {}
        if isinstance(terms, dict) and terms:
            parts.append(", ".join(list(terms.keys())[:10]))
        return ". ".join(p for p in parts if p)[:180]

    def apply_asr_fixes(self, text: str) -> str:
        """Applies known ASR mishearing fixes from Story Bible before translation."""
        fixes = self.bible.get("asr_fixes")
        if not isinstance(fixes, dict) or not fixes or not text:
            return text
        out = text
        for wrong, right in fixes.items():
            if wrong and right and len(wrong) >= 3:
                out = re.sub(rf"\b{re.escape(str(wrong))}\b", str(right), out, flags=re.IGNORECASE)
        return out

    def record_source_cues(self, cues: List[Dict[str, Any]]):
        """Records transcribed cues and triggers background Story Bible creation/refresh when appropriate."""
        for c in cues:
            t = float(c.get("start", 0.0))
            txt = str(c.get("text", "")).strip()
            if txt:
                self.source_lines.append((t, txt))
        if len(self.source_lines) > 120:
            self.source_lines = self.source_lines[-80:]
        self.trigger_bible_update_if_needed(force=False)

    def trigger_bible_update_if_needed(self, force: bool = False):
        if self._bible_task and not self._bible_task.done():
            return
        total = len(self.source_lines)
        should_run = (
            force
            or (not self.bible and (total >= 3 or bool(self.movie_title)))
            or (total - self._last_bible_line_count >= 18)
        )
        if should_run:
            self._last_bible_line_count = total
            try:
                loop = asyncio.get_running_loop()
                self._bible_task = loop.create_task(self._update_story_bible())
            except RuntimeError:
                pass

    async def _update_story_bible(self):
        """Builds/updates the Story Bible asynchronously in the background (from rtsubs Translator.understand)."""
        await asyncio.sleep(1.2)
        if not self.movie_title and not self.source_lines:
            return

        lines_str = "\n".join(f"[{t:.1f}s] {txt}" for t, txt in self.source_lines[-40:])
        user_msg = f"TÊN PHIM / TIÊU ĐỀ TRANG: {self.movie_title or '(Chưa rõ)'}\n\n[TRANSCRIPT ĐOẠN HIỆN TẠI]\n{lines_str or '(Chưa có lời thoại, hãy lập Story Bible dựa trên Tên Phim)'}\n[HẾT TRANSCRIPT]"

        try:
            raw_resp = ""
            if self.groq_key:
                raw_resp = await self._call_groq_messages(
                    [{"role": "system", "content": UNDERSTAND_SYSTEM}, {"role": "user", "content": user_msg}],
                    model_name=GROQ_MODELS[0],
                    max_tokens=1200,
                    timeout=7.0
                )
            elif self.gemini_key:
                raw_resp = await self._translate_gemini(f"{UNDERSTAND_SYSTEM}\n\n{user_msg}", GEMINI_MODELS[0])

            if raw_resp:
                data = extract_json_object(raw_resp)
                norm: Dict[str, Any] = {}
                for k in BIBLE_KEYS:
                    v = data.get(k)
                    if k in ("synopsis", "genre_tone"):
                        norm[k] = str(v or "").strip()
                    elif k == "characters":
                        norm[k] = [c for c in (v or []) if isinstance(c, dict)][:15]
                    else:
                        norm[k] = dict(list(v.items())[:30]) if isinstance(v, dict) else {}
                self.bible = norm
                bible_json = json.dumps(norm, ensure_ascii=False, separators=(",", ":"))
                title_prefix = f"[TÊN PHIM]: {self.movie_title}\n" if self.movie_title else ""
                self.bible_text = f"{title_prefix}[STORY BIBLE]\n{bible_json}\n[HẾT STORY BIBLE]"
                print(
                    f"[StoryBible] Cập nhật thành công ({self.movie_title or 'video'}): "
                    f"{len(norm.get('characters', []))} nhân vật, "
                    f"{len(norm.get('terminology', {}))} thuật ngữ, "
                    f"{len(norm.get('asr_fixes', {}))} sửa lỗi ASR"
                )
        except Exception as e:
            print(f"[StoryBible] Bỏ qua cập nhật nền: {e}")

    def _parse_translation_output(self, response_text: str, expected_count: int, fallback_lines: List[str]) -> List[str]:
        """Parses JSON {"items":[{"id":0,"vi":"..."}]} OR fallback #N Translation> lines."""
        results_map: Dict[int, str] = {}

        # 1. Try JSON parsing (rtsubs format)
        try:
            data = extract_json_object(response_text)
            items = data.get("items", [])
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and "id" in item and item.get("vi"):
                        idx = int(item["id"])
                        results_map[idx] = clean_translated_line(str(item["vi"]))
        except Exception:
            pass

        # 2. Fallback regex parsing if model output #N lines
        if not results_map:
            for line in (response_text or "").splitlines():
                m = re.match(r"^#?(\d+)\s*(?:Translation|>)?[:>]?\s*(.+)$", line.strip())
                if m:
                    idx = int(m.group(1)) - 1  # 1-based -> 0-based
                    txt = re.sub(r"^Translation[:>]?\s*", "", m.group(2).strip(), flags=re.IGNORECASE).strip()
                    if txt:
                        results_map[idx] = clean_translated_line(txt)

        if not results_map:
            raise RuntimeError("No valid translated items parsed from LLM response")

        return [results_map.get(i, clean_translated_line(fallback_lines[i])) for i in range(expected_count)]

    async def _call_groq_messages(
        self,
        messages: List[Dict[str, str]],
        model_name: str,
        max_tokens: int = 1500,
        timeout: float = 5.5
    ) -> str:
        if not self.groq_client:
            raise RuntimeError("No Groq client configured")

        def _call():
            chat = self.groq_client.chat.completions.create(
                messages=messages,
                model=model_name,
                temperature=0.15,
                max_tokens=max_tokens
            )
            return chat.choices[0].message.content or ""

        return await asyncio.wait_for(asyncio.to_thread(_call), timeout=timeout)

    async def _translate_gemini(self, prompt: str, model_name: str) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.15, "maxOutputTokens": 1500}
        }
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5.5)) as session:
            async with session.post(url, headers={"x-goog-api-key": self.gemini_key}, json=payload) as resp:
                if resp.status != 200:
                    err_msg = await resp.text()
                    raise RuntimeError(f"Gemini {model_name} HTTP {resp.status}: {err_msg[:120]}")
                data = await resp.json()
                return data["candidates"][0]["content"]["parts"][0]["text"]

    async def _translate_google_free(self, lines: List[str]) -> List[str]:
        """Ultra-reliable fallback using Google Translate GTX endpoint."""
        joined = "\n".join(lines)
        q = urllib.parse.quote(joined)
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q={q}"
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=4.0)) as session:
            async with session.get(url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Google Translate HTTP {resp.status}")
                data = await resp.json(content_type=None)
                full_text = "".join(part[0] for part in data[0] if part and part[0])
                split_lines = [clean_translated_line(s) for s in full_text.splitlines() if s.strip()]
                if len(split_lines) == len(lines):
                    return split_lines
                tasks = [self._translate_google_single(session, l) for l in lines]
                return await asyncio.gather(*tasks)

    async def _translate_google_single(self, session: aiohttp.ClientSession, text: str) -> str:
        q = urllib.parse.quote(text)
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q={q}"
        async with session.get(url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
            if resp.status == 200:
                data = await resp.json(content_type=None)
                return clean_translated_line("".join(part[0] for part in data[0] if part and part[0]))
        return clean_translated_line(text)

    async def translate_batch(
        self,
        lines: List[str],
        context_hint: str = "",
        slots: Optional[List[float]] = None,
        previous_pairs: Optional[List[Dict[str, str]]] = None
    ) -> List[str]:
        """
        Translates a batch of lines into Vietnamese using Story Bible + slot-based max_chars budget
        (from rtsubs/translate.py).
        """
        if not lines:
            return []

        fixed_lines = [self.apply_asr_fixes(l.strip()) for l in lines]
        if not slots or len(slots) != len(fixed_lines):
            slots = [2.5] * len(fixed_lines)

        req_payload = {
            "previous_lines": previous_pairs or [],
            "translate": [
                {
                    "id": i,
                    "src": fixed_lines[i],
                    "max_chars": max(14, int(slots[i] * CHARS_PER_SEC))
                }
                for i in range(len(fixed_lines))
            ]
        }

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self.bible_text},
            {"role": "user", "content": json.dumps(req_payload, ensure_ascii=False)}
        ]

        # 1. Try Groq fast LLM models first (120B flagship -> 20B)
        if self.groq_key:
            for model in GROQ_MODELS:
                try:
                    resp = await self._call_groq_messages(messages, model_name=model)
                    return self._parse_translation_output(resp, len(fixed_lines), fixed_lines)
                except Exception as e:
                    print(f"[Translator] Groq {model} skipped ({e})")

        # 2. Try Gemini models
        if self.gemini_key:
            combined_prompt = (
                f"{SYSTEM_PROMPT}\n\n{self.bible_text}\n\n"
                f"Yêu cầu dịch JSON:\n{json.dumps(req_payload, ensure_ascii=False)}"
            )
            for model in GEMINI_MODELS:
                try:
                    resp = await self._translate_gemini(combined_prompt, model)
                    return self._parse_translation_output(resp, len(fixed_lines), fixed_lines)
                except Exception as e:
                    print(f"[Translator] Gemini {model} skipped ({e})")

        # 3. Guaranteed fallback to Google Translate GTX
        try:
            return await self._translate_google_free(fixed_lines)
        except Exception as e:
            print(f"[Translator] Google Translate fallback failed: {e}")

        return [clean_translated_line(l) for l in fixed_lines]
