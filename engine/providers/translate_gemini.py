"""Batch Subtitle Translator using Gemini (with Groq LLM fallback).
Inspired by llm-subtrans for strict 1-to-1 line correspondence and context retention.
"""
import os
import re
import json
import asyncio
from typing import List, Dict, Any
import aiohttp
import groq


class Translator:
    def __init__(
        self,
        gemini_key: str = None,
        groq_key: str = None,
        gemini_model: str = "gemini-2.5-flash-lite",
        groq_model: str = "llama-3.3-70b-versatile"
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
        """Builds structured 1-to-1 subtitle prompt inspired by llm-subtrans."""
        prompt = (
            "Bạn là dịch giả phụ đề và lồng tiếng phim chuyên nghiệp sang tiếng Việt.\n"
            "Quy tắc dịch:\n"
            "1. Dịch tự nhiên, ngắn gọn, súc tích, giữ đúng văn phong thoại đời thường để diễn viên lồng tiếng nói kịp thời gian.\n"
            "2. Xưng hô chuẩn theo bối cảnh phim (ví dụ: tôi/bạn, anh/em, cậu/tớ, ta/ngươi).\n"
            "3. Bắt buộc giữ nguyên số lượng dòng và mã số thứ tự #1, #2... tương ứng.\n"
            "4. Định dạng trả về duy nhất cho mỗi dòng:\n"
            "#{số thứ tự} Translation> {câu tiếng Việt}\n\n"
        )
        if context_hint:
            prompt += f"<context>{context_hint}</context>\n\n"

        prompt += "Danh sách các câu thoại cần dịch:\n"
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
                # Clean up any trailing / leading artifacts
                text = re.sub(r"^Translation[:>]?\s*", "", text, flags=re.IGNORECASE)
                translations[idx] = text

        results = []
        for i in range(1, expected_count + 1):
            results.append(translations.get(i, fallback_lines[i - 1]))
        return results

    async def _translate_gemini(self, prompt: str) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.gemini_model}:generateContent"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048}
        }
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
            async with session.post(url, headers={"x-goog-api-key": self.gemini_key}, json=payload) as resp:
                if resp.status != 200:
                    err_msg = await resp.text()
                    raise RuntimeError(f"Gemini error HTTP {resp.status}: {err_msg[:200]}")
                data = await resp.json()
                return data["candidates"][0]["content"]["parts"][0]["text"]

    async def _translate_groq(self, prompt: str) -> str:
        if not self.groq_client:
            raise RuntimeError("No Groq client configured")

        def _call():
            chat = self.groq_client.chat.completions.create(
                messages=[
                    {"role": "system", "content": "You are an expert movie dubbing translator into Vietnamese."},
                    {"role": "user", "content": prompt}
                ],
                model=self.groq_model,
                temperature=0.2,
                max_tokens=2048
            )
            return chat.choices[0].message.content

        return await asyncio.to_thread(_call)

    async def translate_batch(self, lines: List[str], context_hint: str = "") -> List[str]:
        """Translates a batch of lines into Vietnamese with fallback."""
        if not lines:
            return []

        # If already Vietnamese or empty, return as is
        clean_lines = [l.strip() for l in lines]
        prompt = self._build_batch_prompt(clean_lines, context_hint)

        # 1. Try Gemini first
        if self.gemini_key:
            try:
                resp = await self._translate_gemini(prompt)
                return self._parse_batch_response(resp, len(lines), clean_lines)
            except Exception as e:
                print(f"[Translator] Gemini translation failed ({e}), falling back to Groq...")

        # 2. Fallback to Groq LLM
        if self.groq_key:
            try:
                resp = await self._translate_groq(prompt)
                return self._parse_batch_response(resp, len(lines), clean_lines)
            except Exception as e:
                print(f"[Translator] Groq LLM translation failed: {e}")

        # If all fail, return original lines
        return clean_lines
