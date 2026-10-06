"""Language codes Pip uses, and how they map onto each engine's names."""

from __future__ import annotations

# The 22 scheduled languages of India plus English and Hinglish.
INDIC = ["as", "bn", "brx", "doi", "gu", "hi", "kn", "kok", "ks", "mai", "ml", "mni", "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur"]
ALL = ["en", "hinglish", *INDIC]

NAMES = {
    "en": "English", "hi": "Hindi", "hinglish": "Hinglish", "ta": "Tamil", "te": "Telugu", "pa": "Punjabi",
    "bn": "Bengali", "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada", "ml": "Malayalam", "or": "Odia",
    "as": "Assamese", "ur": "Urdu", "ne": "Nepali", "sa": "Sanskrit", "sd": "Sindhi", "ks": "Kashmiri",
    "kok": "Konkani", "mai": "Maithili", "mni": "Manipuri", "brx": "Bodo", "doi": "Dogri", "sat": "Santali",
}

# Script ranges, used to tell what a model actually wrote.
SCRIPTS = {
    "latin": ("A", "ɏ"),
    "devanagari": ("ऀ", "ॿ"),
    "bengali": ("ঀ", "৿"),
    "gurmukhi": ("਀", "੿"),
    "gujarati": ("઀", "૿"),
    "odia": ("଀", "୿"),
    "tamil": ("஀", "௿"),
    "telugu": ("ఀ", "౿"),
    "kannada": ("ಀ", "೿"),
    "malayalam": ("ഀ", "ൿ"),
    "arabic": ("؀", "ۿ"),
}


def normalize(code: str | None) -> str:
    """en-IN -> en, hi-Latn / hi_en -> hinglish, HI -> hi."""
    if not code:
        return "en"
    value = code.strip().lower().replace("_", "-")
    if value in {"hinglish", "hi-latn", "hi-en", "en-hi"}:
        return "hinglish"
    return value.split("-")[0]


def base(code: str) -> str:
    """The spoken language an acoustic model sees: Hinglish is Hindi audio."""
    return "hi" if code == "hinglish" else code


def script_of(word: str) -> str | None:
    for character in word:
        for name, (low, high) in SCRIPTS.items():
            if low <= character <= high and character.isalpha():
                return name
    return None


def latin_share(text: str) -> float:
    """Share of words written in Latin script (how much English is in a Hindi utterance)."""
    words = [word for word in text.split() if script_of(word)]
    if not words:
        return 0.0
    return sum(1 for word in words if script_of(word) == "latin") / len(words)
