"""Normalize and phonemize bilingual text for Matcha's token-input interface."""

import re
from unicodedata import normalize

from kaldifst import TextNormalizer
from piper_phonemize import phonemize_espeak
from pypinyin import Style, lazy_pinyin

HAN = "㐀-鿿𠀀-𱍏"
CHINESE_RUN = re.compile(rf"[{HAN}]+")
CODE = re.compile(r"[A-Za-z0-9]+(?:[._\-‐‑–][A-Za-z0-9]+)*")
CODE_PART = re.compile(r"[A-Za-z]+|[0-9]+(?:\.[0-9]+)*")
DIGITS = "zero one two three four five six seven eight nine".split()
PUNCTUATION = dict(zip("，。！？；、", ",.!?;,"))
LANGUAGE_SPANS = re.compile(rf"([{HAN}]+|[，。！？；、])")
SCRIPT_BOUNDARY = re.compile(rf"(?<=[{HAN}])(?=[A-Za-z])|(?<=[A-Za-z])(?=[{HAN}])")
FULLWIDTH_CODE = re.compile(r"[Ａ-Ｚａ-ｚ０-９]+")
COLON_PAUSE = re.compile(r"(?<![0-9]):|:(?![0-9])")
CLOCK_TIME = re.compile(r"(?<![0-9:])([01]?[0-9]|2[0-3]):([0-5][0-9])(?![0-9:])")
LEADING_PUNCTUATION = re.compile(r"^[\s,.!?;]+")
# The bilingual Matcha model uses these English phones in its training input.
# Follow the model's Sherpa-ONNX frontend (k2-fsa/sherpa-onnx#2853).
MATCHA_ENGLISH_PHONES = {
    "eɪ": "A", "aɪ": "I", "ɔɪ": "Y", "oʊ": "O", "əʊ": "O", "aʊ": "W",
    "tʃ": "ʧ", "dʒ": "ʤ",
    "ɝ": "ɜɹ", "ɚ": "əɹ", "ː": "", "g": "ɡ", "r": "ɹ", "e": "ɛ",
}
ESPEAK_PHONES = re.compile("|".join(MATCHA_ENGLISH_PHONES))


def speech_text(text):
    """Clean streamed and HTTP text using the same pronunciation rules."""
    chinese = bool(CHINESE_RUN.search(text)) or not re.search(r"[A-Za-z]", text)
    units = dict(zip(
        ("TB", "GB", "MB", "KB"),
        ("太字节", "吉字节", "兆字节", "千字节") if chinese else
        (" terabytes", " gigabytes", " megabytes", " kilobytes"),
    ))
    text = re.sub(r"```[\s\S]*?(?:```|$)|!\[[^\]]*\]\([^)]+\)|https?://[^\s，。！？]+", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^[ \t]*(?:#+|>|[-*+]\s|\d+\.\s)", "", text, flags=re.M)
    text = re.sub(r"([+-]?\d+(?:\.\d+)?)\s*[%％]", r"百分之\1" if chinese else r"\1 percent", text)
    text = re.sub(r"(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b",
                  lambda match: match[1] + units[match[2].upper()], text, flags=re.I)
    text = re.sub(r"~/\.([a-z][a-z\d-]*)(?![\w/-])",
                  r"家目录的点 \1" if chinese else r"home directory dot \1", text, flags=re.I)
    text = re.sub(r"(?<![A-Za-z0-9])C#(?![A-Za-z0-9#])", "C sharp", text)
    text = re.sub(r"(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])", " ", text)
    text = re.sub(r'(?<=[A-Za-z0-9])["“”]+(?=[A-Za-z0-9])', " ", text)
    return re.sub(r'[`*#~_《》"“”]', "", text).strip()


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
        # A literal colon can become an extra syllable in Matcha.
        text = COLON_PAUSE.sub("，", text.replace("：", ":"))
        text = CODE.sub(expand_model_code, text)
        if CHINESE_RUN.search(text):
            text = CLOCK_TIME.sub(r"\1点\2分", text)
            for normalizer in self.normalizers:
                text = normalizer.normalize(text)
            text = SCRIPT_BOUNDARY.sub(" ", text)

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
                clauses = phonemize_espeak(span.strip(), "en-us")
                phones = " ".join("".join(clause) for clause in clauses)
                tokens.extend(ESPEAK_PHONES.sub(lambda match: MATCHA_ENGLISH_PHONES[match[0]], phones))
                if span[-1].isspace():
                    tokens.append(" ")
            else:
                tokens.extend(" " if char.isspace() else char for char in span)

        # Keep native token boundaries and collapse repeated spaces from the
        # text normalizer and the phonemizer's clause breaks.
        result = []
        for token in tokens:
            if token == ":":
                token = ","
            if token in self.symbols and (token != " " or (result and result[-1] != " ")):
                result.append(token)
        if result and result[-1] == " ":
            result.pop()
        return result
