"""Build the bilingual lexicon consumed by Android's Matcha asset preparation."""

import re
from shutil import copyfileobj

ENGLISH_LEXICON = "lexicon-en-us.txt"
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
