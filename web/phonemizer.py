"""Normalize and phonemize bilingual text for Matcha's token-input interface."""

import re
from unicodedata import normalize

from kaldifst import TextNormalizer
from piper_phonemize import phonemize_espeak
from pypinyin import Style, lazy_pinyin

CHINESE_RUN = re.compile(r"([㐀-鿿𠀀-𱍏]+)")
CODE = re.compile(r"[A-Za-z0-9]+(?:[._\-‐‑–][A-Za-z0-9]+)*")
CODE_PART = re.compile(r"[A-Za-z]+|[0-9]+(?:\.[0-9]+)*")
DIGITS = "zero one two three four five six seven eight nine".split()
PUNCTUATION = dict(zip("，。！？；：、", ",.!?;:,"))
LANGUAGE_SPANS = re.compile(r"([㐀-鿿𠀀-𱍏]+|[，。！？；：、])")
FULLWIDTH_CODE = re.compile(r"[Ａ-Ｚａ-ｚ０-９]+")
LEADING_PUNCTUATION = re.compile(r"^[\s,.!?;:]+")


def speech_text(text):
    """Clean streamed and HTTP text using the same pronunciation rules."""
    chinese = bool(CHINESE_RUN.search(text)) or not re.search(r"[A-Za-z]", text)
    units = dict(zip(
        ("TB", "GB", "MB", "KB"),
        ("太字节", "吉字节", "兆字节", "千字节") if chinese else
        (" terabytes", " gigabytes", " megabytes", " kilobytes"),
    ))
    text = re.sub(r"```[\s\S]*?(?:```|$)|!\[[^\]]*\]\([^)]+\)|https?://[^\s，。！？]+", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^[ \t]*(?:#+|>|[-*+]\s|\d+\.\s)", "", text, flags=re.M)
    text = re.sub(r"([+-]?\d+(?:\.\d+)?)\s*[%％]", r"百分之\1" if chinese else r"\1 percent", text)
    text = re.sub(r"(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b",
                  lambda match: match[1] + units[match[2].upper()], text, flags=re.I)
    text = re.sub(r"~/\.([a-z][a-z\d-]*)(?![\w/-])",
                  r"家目录的点 \1" if chinese else r"home directory dot \1", text, flags=re.I)
    return re.sub(r"[`*#~_《》]", "", text).strip()


def expand_model_code(match):
    token = match[0]
    parts = CODE_PART.findall(token)
    has_letters = any(part[0].isalpha() for part in parts)
    has_digits = any(part[0].isdigit() for part in parts)
    if not (has_letters and has_digits):
        return token

    # Keep identifiers out of the Chinese number rules while retaining decimals
    # inside a version number and word boundaries inside a hyphenated label.
    words = []
    for part in parts:
        if part[0].isdigit():
            words.extend("point" if char == "." else DIGITS[int(char)] for char in part)
        else:
            words.append(part)
    return " ".join(words)


class MatchaFrontend:
    def __init__(self, token_file, rules):
        self.normalizers = [TextNormalizer(str(rule)) for rule in rules]
        self.symbols = {" "}
        for line in token_file.read_text(encoding="utf-8").splitlines():
            fields = line.split()
            if len(fields) == 2:
                self.symbols.add(fields[0])

    def tokens(self, text):
        text = FULLWIDTH_CODE.sub(lambda match: normalize("NFKC", match[0]), normalize("NFC", text))
        text = CODE.sub(expand_model_code, text)
        if CHINESE_RUN.search(text):
            for normalizer in self.normalizers:
                text = normalizer.normalize(text)

        tokens = []
        for span in LANGUAGE_SPANS.split(text):
            if not span:
                continue
            if span in PUNCTUATION:
                tokens.append(PUNCTUATION[span])
            elif CHINESE_RUN.fullmatch(span):
                tokens.extend(lazy_pinyin(span, style=Style.TONE3, neutral_tone_with_five=True, tone_sandhi=True))
            elif any(char.isalnum() for char in span):
                prefix = LEADING_PUNCTUATION.match(span)
                if prefix:
                    tokens.extend(" " if char.isspace() else char for char in prefix[0])
                    span = span[prefix.end():]
                for clause in phonemize_espeak(span.strip(), "en-us"):
                    tokens.extend(clause)
                if span[-1].isspace():
                    tokens.append(" ")
            else:
                tokens.extend(" " if char.isspace() else char for char in span)

        # Keep native token boundaries and collapse repeated spaces from the
        # text normalizer and the phonemizer's clause breaks.
        result = []
        for token in tokens:
            if token in self.symbols and (token != " " or (result and result[-1] != " ")):
                result.append(token)
        if result and result[-1] == " ":
            result.pop()
        return result
