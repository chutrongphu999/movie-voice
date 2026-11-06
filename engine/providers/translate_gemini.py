"""Batch Subtitle Translator using Groq 120B LLM, Gemini, and Google Translate fallback.
Inspired by llm-subtrans & VideoLingo for cinematic Vietnamese dubbing with rolling context.
"""
import os
import re
import asyncio
import urllib.parse
from typing import List
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

    def update_keys(self, gemini_key: str = None, groq_key: str = None):
        if gemini_key:
            self.gemini_key = gemini_key
        if groq_key:
            self.groq_key = groq_key
            self.groq_client = groq.Groq(api_key=groq_key)

    def _build_batch_prompt(self, lines: List[str], context_hint: str = "") -> str:
        """Builds structured 1-to-1 dubbing script prompt."""
        prompt = (
            "Bạn là biên kịch lồng tiếng phim điện ảnh chuyên nghiệp sang tiếng Việt.\n"
            "Quy tắc vàng:\n"
            "1. Dịch thoát ý, tự nhiên như người Việt nói chuyện ngoài đời, ngắn gọn vừa khít khẩu hình và thời lượng câu thoại.\n"
            "2. Tuyệt đối KHÔNG dịch word-by-word ngô nghê (ví dụ: 'Look,' ở đầu câu phải dịch là 'Nghe này,' hoặc 'Nhìn xem,'; 'National Guard' là 'Vệ binh Quốc gia'; 'What's wrong with you?' là 'Cậu bị làm sao thế?').\n"
            "3. Giữ mạch xưng hô nhất quán với các câu trước đó trong phần <context>.\n"
            "4. Bắt buộc giữ nguyên số lượng dòng và mã số #1, #2... tương ứng. Chỉ trả về đúng định dạng:\n"
            "#{số thứ tự} Translation> {câu thoại tiếng Việt}\n\n"
        )
        if context_hint:
            prompt += f"<context>\nCác câu thoại vừa nói trước đó:\n{context_hint}\n</context>\n\n"

        prompt += "Danh sách các câu thoại cần dịch ngay:\n"
        for i, line in enumerate(lines, 1):
            prompt += f"#{i} Original> {line}\n"

        return prompt

    def _parse_batch_response(self, response_text: str, expected_count: int, fallback_lines: List[str]) -> List[str]:
        """Extracts translations matching #{index} Translation> {text}."""
        translations = {}
        for line in response_text.splitlines():
            m = re.match(r"^#?(\d+)\s*(?:Translation|>)?[:>]?\s*(.+)$", line.strip())
            if m:
                idx = int(m.group(1))
                text = m.group(2).strip()
                text = re.sub(r"^Translation[:>]?\s*", "", text, flags=re.IGNORECASE).strip()
                if text:
                    translations[idx] = text

        if not translations:
            raise RuntimeError("No valid #N lines parsed from LLM response")

        results = []
        for i in range(1, expected_count + 1):
            results.append(translations.get(i, fallback_lines[i - 1]))
        return results

    async def _translate_groq(self, prompt: str, model_name: str) -> str:
        if not self.groq_client:
            raise RuntimeError("No Groq client configured")

        def _call():
            chat = self.groq_client.chat.completions.create(
                messages=[
                    {
                        "role": "system",
                        "content": "You are a Vietnamese movie dubbing scriptwriter. Output ONLY the requested #N Translation> lines in natural spoken Vietnamese."
                    },
                    {"role": "user", "content": prompt}
                ],
                model=model_name,
                temperature=0.2,
                max_tokens=1500
            )
            return chat.choices[0].message.content or ""

        return await asyncio.wait_for(asyncio.to_thread(_call), timeout=6.0)

    async def _translate_gemini(self, prompt: str, model_name: str) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1500}
        }
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6.0)) as session:
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
                split_lines = [s.strip() for s in full_text.splitlines() if s.strip()]
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
                return "".join(part[0] for part in data[0] if part and part[0]).strip()
        return text

    async def translate_batch(self, lines: List[str], context_hint: str = "") -> List[str]:
        """Translates a batch of lines into Vietnamese with multi-tier fast fallback."""
        if not lines:
            return []

        clean_lines = [l.strip() for l in lines]
        prompt = self._build_batch_prompt(clean_lines, context_hint)

        # 1. Try Groq fast LLM models first (120B flagship -> 20B)
        if self.groq_key:
            for model in GROQ_MODELS:
                try:
                    resp = await self._translate_groq(prompt, model)
                    return self._parse_batch_response(resp, len(lines), clean_lines)
                except Exception as e:
                    print(f"[Translator] Groq {model} skipped ({e})")

        # 2. Try Gemini models
        if self.gemini_key:
            for model in GEMINI_MODELS:
                try:
                    resp = await self._translate_gemini(prompt, model)
                    return self._parse_batch_response(resp, len(lines), clean_lines)
                except Exception as e:
                    print(f"[Translator] Gemini {model} skipped ({e})")

        # 3. Guaranteed fallback to Google Translate GTX
        try:
            return await self._translate_google_free(clean_lines)
        except Exception as e:
            print(f"[Translator] Google Translate fallback failed: {e}")

        return clean_lines
