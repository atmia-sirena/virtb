"""Text normalization for scoring, per language.

WER/CER follow the Vistaar convention: punctuation and case are ignored,
Unicode is NFC, nukta and chandrabindu spellings are folded, and Indic
digits match ASCII ones. Romanized Hinglish also folds spelling variants
("nahin"/"nahi"/"nai", "hai"/"hae", "kya"/"kyaa"), since there is no
standard spelling and Wispr Flow-style output is judged by readers.
"""

from __future__ import annotations

import re
import unicodedata

INDIC_DIGITS = {ord(c): str(i) for block in ("०१२३४५६७८९", "০১২৩৪৫৬৭৮৯", "੦੧੨੩੪੫੬੭੮੯", "૦૧૨૩૪૫૬૭૮૯", "୦୧୨୩୪୫୬୭୮୯", "௦௧௨௩௪௫௬௭௮௯", "౦౧౨౩౪౫౬౭౮౯", "೦೧೨೩೪೫೬೭೮೯", "൦൧൨൩൪൫൬൭൮൯") for i, c in enumerate(block)}

FOLD = {
    "़": "",  # Devanagari nukta
    "਼": "",  # Gurmukhi nukta
    "়": "",  # Bengali nukta
    "ँ": "ं",  # chandrabindu -> anusvara
    "‌": "",  # ZWNJ
    "‍": "",  # ZWJ
}

# Kept inside a word (emails, times, URLs, "don't"); dropped elsewhere.
INNER = set(".:'/+-@_")
KEEP = {"₹", "%"}

# Spelling variants people use for the same romanized Hindi word.
HINGLISH_VARIANTS = {
    "nahin": "nahi", "nai": "nahi", "nhi": "nahi", "nahee": "nahi", "hae": "hai", "hain": "hai",
    "kyaa": "kya", "kia": "kya", "mein": "me", "mai": "main", "mujhey": "mujhe", "tum": "tum", "aap": "ap",
    "toh": "to", "woh": "wo", "voh": "wo", "vo": "wo", "yeh": "ye", "yah": "ye", "accha": "acha", "achha": "acha",
    "theek": "thik", "thick": "thik", "bohot": "bahut", "bahot": "bahut", "bhot": "bahut", "kyun": "kyu", "kyon": "kyu",
    "abhi": "abhi", "kal": "kal", "haan": "ha", "han": "ha", "okay": "ok", "ok": "ok", "okk": "ok",
}


def nfc(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    for source, target in FOLD.items():
        text = text.replace(source, target)
    return text.translate(INDIC_DIGITS)


def _wordish(character: str) -> bool:
    return unicodedata.category(character)[0] in "LMN"


def strip_punctuation(text: str) -> str:
    """Drops punctuation and symbols by Unicode category (Python's \\w misses Indic vowel signs)."""
    text = re.sub(r"(?<=\d),(?=\d)", "", text)  # 1,50,000 -> 150000
    output = []
    for index, character in enumerate(text):
        if _wordish(character) or character.isspace() or character in KEEP:
            output.append(character)
        elif character in INNER and 0 < index < len(text) - 1 and _wordish(text[index - 1]) and _wordish(text[index + 1]):
            output.append(character)
        else:
            output.append(" ")
    return re.sub(r"\s+", " ", "".join(output)).strip()


def for_wer(text: str, language: str = "en") -> str:
    text = strip_punctuation(nfc(text)).lower()
    if language == "hinglish":
        text = " ".join(romanized_key(word) for word in text.split())
    return text


def romanized_key(word: str) -> str:
    """A spelling-tolerant key for romanized Hindi: variants table, then doubled vowels, w/v, z/j, final h."""
    word = HINGLISH_VARIANTS.get(word, word)
    if not word.isascii() or any(character.isdigit() for character in word):
        return word
    key = word.replace("ee", "i").replace("oo", "u").replace("aa", "a").replace("w", "v").replace("z", "j")
    key = re.sub(r"(.)\1+", r"\1", key)
    if len(key) > 2 and key.endswith("h") and key[-2] in "aeiou":
        key = key[:-1]
    return key


def for_zero_edit(text: str) -> str:
    """Light normalization for 'would the user edit this?': whitespace, quotes, a final full stop."""
    text = nfc(text).replace("’", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text).strip()
    return re.sub(r"[.।]$", "", text)
