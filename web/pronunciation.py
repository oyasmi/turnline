"""Bridge the packaged Matcha Chinese phones and the English pronunciation lexicon."""

import re
from shutil import copyfileobj

ENGLISH_LEXICON = "lexicon-en-us.txt"
HAN = re.compile(r"[㐀-鿿𠀀-𱍏]")
NUMBER = re.compile(r"(?<![\w.])([+-]?)(\d+)(?:\.(\d+))?(?!\w|\.\d)")
SMALL = ("zero one two three four five six seven eight nine ten eleven twelve thirteen "
         "fourteen fifteen sixteen seventeen eighteen nineteen").split()
TENS = ("zero ten twenty thirty forty fifty sixty seventy eighty ninety").split()
WORD = re.compile(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*")
NAMES = {
    "codex": "k ˈ o ʊ d ɛ k s",
    "kubernetes": "k uː b ɚ n ˈ ɛ t iː z",
    "matcha": "m ˈ ɑː tʃ ə",
    "openai": "ˌ o ʊ p ə n ˌ e ɪ ˈ a ɪ",
    "pipiclaw": "p ˈ iː p iː k l ɔː",
    "turnline": "t ˈ ɜː ɹ n l a ɪ n",
}


def add_english(output, english, tokens):
    with tokens.open(encoding="utf-8") as source:
        phones = {line.rsplit(maxsplit=1)[0].strip() for line in source if len(line.split()) == 2}

    def add(word, pronunciation):
        symbols = "".join(pronunciation.split())
        if symbols and set(symbols) <= phones:
            output.write(word + " " + " ".join(symbols) + "\n")
            words.add(word)

    words = set()
    for word, pronunciation in NAMES.items():
        add(word, pronunciation)
    with english.open(encoding="utf-8") as source:
        for line in source:
            word, delimiter, pronunciation = line.partition(" || ")
            if delimiter and WORD.fullmatch(word) and word not in words:
                add(word, pronunciation)
    if not set("abcdefghijklmnopqrstuvwxyz") <= words:
        raise ValueError("Matcha English lexicon does not contain the complete English alphabet.")
    return frozenset(words)


def build_lexicon(path, chinese, english, tokens):
    with path.open("w", encoding="utf-8") as output:
        with chinese.open(encoding="utf-8") as source:
            copyfileobj(source, output)
        output.write("\n")
        return add_english(output, english, tokens)


def english_integer(number):
    if number < 20:
        return SMALL[number]
    if number < 100:
        tens, ones = divmod(number, 10)
        return TENS[tens] + (" " + SMALL[ones] if ones else "")
    for scale, label in ((1_000_000, "million"), (1_000, "thousand"), (100, "hundred")):
        if number >= scale:
            high, low = divmod(number, scale)
            return english_integer(high) + " " + label + (" " + english_integer(low) if low else "")


def english_number(match):
    sign, whole, fraction = match.groups()
    if len(whole) >= 9 or (len(whole) > 1 and whole.startswith("0")):
        spoken = " ".join(SMALL[int(digit)] for digit in whole)
    else:
        spoken = english_integer(int(whole))
    if fraction:
        spoken += " point " + " ".join(SMALL[int(digit)] for digit in fraction)
    return {"-": "minus ", "+": "plus ", "": ""}[sign] + spoken


def spoken_english(text, words):
    def normalize(match):
        word = match.group().lower().replace("’", "'")
        if word in words:
            return word
        parts = [p if p in words else " ".join(p.replace("'", "")) for p in word.split("-")]
        return " " + " ".join(parts) + " "

    if not HAN.search(text):
        text = NUMBER.sub(english_number, text)
    return WORD.sub(normalize, text)
