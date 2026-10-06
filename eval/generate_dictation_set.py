"""Builds the Pip Dictation Set: realistic dictation in each language, with
fillers, self-corrections, spoken commands, names, numbers, ₹ amounts and
emails, each with the text Pip should type. It measures what Wispr Flow is
judged on (zero-edit output, commands, entities), which public ASR sets don't.

    # 1. scripts, written by a large local model through Ollama (no API keys)
    python generate_dictation_set.py scripts --model qwen3:235b --per-language 600
    # 2. voices: Indic Parler-TTS (Apache-2.0) on the GPU, many speakers per language
    uv run --extra tts python generate_dictation_set.py voice
    # 3. rooms: noise, fan, babble, reverb, laptop-mic EQ, at 5-25 dB SNR
    python generate_dictation_set.py augment

`--split train` writes a disjoint set (other topics, other speaker descriptions)
for training/recipes; the eval split is never trained on.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import urllib.request
from pathlib import Path

import numpy as np
import soundfile

from pip_eval.manifest import data_dir
from pip_eval.normalize import for_wer

LANGUAGES = {
    "en": "Indian English",
    "hinglish": "Hinglish (Hindi-English code-switching). `spoken` and `final` in romanized Latin script, the way people type on WhatsApp",
    "hi": "Hindi in Devanagari",
    "ta": "Tamil in Tamil script (colloquial spoken Tamil, English words as people say them)",
    "te": "Telugu in Telugu script (colloquial, English words as people say them)",
    "pa": "Punjabi in Gurmukhi script",
}

CATEGORIES = [
    ("message", "a casual chat message to a friend or family member", []),
    ("work", "a work message on Slack or Teams about a task, deadline or meeting", []),
    ("email", "a short formal email body", []),
    ("time", "plans with dates and times (5 baje, 6:30 pm, next Monday)", ["entity"]),
    ("money", "money amounts in rupees, lakh and crore", ["entity"]),
    ("names", "Indian person, company and place names", ["entity"]),
    ("contact", "a phone number, email address or website said aloud ('at the rate', 'dot com')", ["entity", "command"]),
    ("fillers", "hesitant speech with um, uh, hmm and repeated words", ["filler"]),
    ("correction", "a self-correction mid-sentence ('no wait', 'sorry I mean', 'nahi nahi', 'actually') where the later version wins", ["backtrack"]),
    ("scratch", "a sentence followed by an explicit delete command ('scratch that', 'pichhla hata do') and a new sentence", ["command"]),
    ("format", "spoken formatting: 'new line', 'comma', 'full stop', 'question mark', a numbered list", ["command"]),
    ("long", "a long, rambling voice note (3-5 sentences)", []),
]

PROMPT = """Write {count} realistic voice dictations for this situation: {category}.
Language: {language}.
For each, give:
- "spoken": exactly what the person says out loud, including any fillers, false starts and spoken commands;
- "tts": the same words written so a text-to-speech voice reads them naturally in that language's script (for Hinglish: Devanagari for Hindi words, Latin for English words);
- "final": exactly what a perfect dictation app should type: fillers removed, corrections and delete commands applied, spoken punctuation turned into marks, ₹ for rupees with Indian grouping (₹1,50,000), digits for numbers and times, emails written as emails. Never add a word that wasn't said.
Vary speakers, topics and length. Use names and places from all over India. Topics this time: {topics}.
Return JSON: {{"items": [{{"spoken": "...", "tts": "...", "final": "..."}}]}}"""

TOPICS = {
    "eval": ["family", "office", "college", "shopping", "travel", "health", "cricket", "festivals", "rent", "food delivery", "banking", "a doctor's appointment"],
    "train": ["weddings", "movies", "cooking", "startups", "farming", "trains", "exams", "gym", "politics news", "pets", "car repair", "a job interview"],
}

SPEAKERS = {
    "eval": [
        "A female speaker with a clear, moderately expressive voice speaks at a moderate pace in a quiet room.",
        "A male speaker with a deep voice speaks quickly and casually, recorded close to the microphone.",
        "An older male speaker speaks slowly and calmly with a slightly monotone delivery.",
        "A young female speaker speaks fast and animatedly with a high-pitched voice.",
        "A male speaker speaks at a moderate pace with a slightly muffled, distant-sounding recording.",
        "A female speaker speaks softly and slowly, recorded in a slightly echoey room.",
    ],
    "train": [
        "A male speaker with a moderate pitch speaks clearly at a brisk pace.",
        "A female speaker with a warm voice speaks slowly and expressively.",
        "A young male speaker speaks quickly with a slightly nasal voice in a noisy room.",
        "An older female speaker speaks deliberately with a low-pitched voice.",
    ],
}


def ollama_json(model: str, prompt: str, host: str) -> dict:
    body = json.dumps({"model": model, "stream": False, "format": "json", "think": False, "options": {"temperature": 0.9, "num_ctx": 16384}, "messages": [{"role": "user", "content": prompt}]}).encode()
    request = urllib.request.Request(f"{host}/api/chat", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.loads(json.loads(response.read())["message"]["content"])


def faithful(spoken: str, final: str, language: str) -> bool:
    """The reference must not contain words that were never said (digits and joined forms aside)."""
    said = set(for_wer(spoken, language).split())
    said_joined = for_wer(spoken, language).replace(" ", "")
    for word in for_wer(final, language).split():
        if word in said or any(character.isdigit() for character in word) or "@" in word or "." in word or word.startswith("₹"):
            continue
        if word in said_joined:
            continue
        return False
    return True


def scripts(args: argparse.Namespace) -> None:
    target = data_dir() / args.name
    target.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    seen: set[str] = set()
    rng = random.Random(args.seed)
    for language, description in LANGUAGES.items():
        if args.languages and language not in args.languages.split(","):
            continue
        per_category = max(1, args.per_language // len(CATEGORIES))
        for category, situation, tags in CATEGORIES:
            made = 0
            attempts = 0
            while made < per_category and attempts < per_category // 5 + 4:
                attempts += 1
                topics = ", ".join(rng.sample(TOPICS[args.split], 3))
                try:
                    reply = ollama_json(args.model, PROMPT.format(count=min(10, per_category - made), category=situation, language=description, topics=topics), args.ollama)
                except Exception as error:
                    print(f"  {language}/{category}: {error}")
                    continue
                for item in reply.get("items", []):
                    spoken, final, tts = (item.get("spoken") or "").strip(), (item.get("final") or "").strip(), (item.get("tts") or item.get("spoken") or "").strip()
                    key = hashlib.sha1(spoken.encode()).hexdigest()[:12]
                    if not spoken or not final or key in seen or not faithful(spoken, final, language):
                        continue
                    seen.add(key)
                    rows.append({"id": f"{language}-{category}-{key}", "language": language, "text": spoken, "tts": tts, "final": final, "tags": [category, *tags]})
                    made += 1
            print(f"{language}/{category}: {made}")
    (target / "scripts.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    print(f"{len(rows)} scripts -> {target / 'scripts.jsonl'} (spot-check a sample before voicing)")


def voice(args: argparse.Namespace) -> None:
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer

    target = data_dir() / args.name
    rows = [json.loads(line) for line in (target / "scripts.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ParlerTTSForConditionalGeneration.from_pretrained(args.tts_model).to(device)
    tokenizer = AutoTokenizer.from_pretrained(args.tts_model)
    description_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    rng = random.Random(args.seed)
    clean = target / "clean"
    clean.mkdir(exist_ok=True)
    with (target / "clean.jsonl").open("w", encoding="utf-8") as manifest:
        for index, row in enumerate(rows):
            path = clean / f"{row['id']}.wav"
            speaker = rng.choice(SPEAKERS[args.split])
            if not path.exists():
                description = description_tokenizer(speaker, return_tensors="pt").to(device)
                prompt = tokenizer(row["tts"], return_tensors="pt").to(device)
                with torch.no_grad():
                    audio = model.generate(input_ids=description.input_ids, attention_mask=description.attention_mask, prompt_input_ids=prompt.input_ids, prompt_attention_mask=prompt.attention_mask)
                waveform = audio.cpu().numpy().squeeze().astype(np.float32)
                rate = model.config.sampling_rate
                if rate != 16000:
                    import librosa

                    waveform = librosa.resample(waveform, orig_sr=rate, target_sr=16000)
                soundfile.write(path, waveform, 16000)
            manifest.write(json.dumps({**{key: row[key] for key in ("id", "language", "text", "final", "tags")}, "audio": f"clean/{path.name}", "speaker": speaker}, ensure_ascii=False) + "\n")
            print(f"\r{index + 1}/{len(rows)}", end="")
    print()


# --- room simulation ---------------------------------------------------------

def pink_noise(length: int, rng: np.random.Generator) -> np.ndarray:
    spectrum = np.fft.rfft(rng.standard_normal(length))
    spectrum /= np.sqrt(np.maximum(np.arange(spectrum.size), 1))
    noise = np.fft.irfft(spectrum, n=length)
    return (noise / (np.abs(noise).max() + 1e-9)).astype(np.float32)


def room_impulse(rng: np.random.Generator, rate: int = 16000) -> np.ndarray:
    rt60 = rng.uniform(0.15, 0.6)
    length = int(rt60 * rate)
    decay = np.exp(-6.9 * np.arange(length) / length)
    impulse = rng.standard_normal(length) * decay
    impulse[0] = 1.0
    return (impulse / np.sqrt((impulse**2).sum())).astype(np.float32)


def laptop_mic(audio: np.ndarray, rate: int = 16000) -> np.ndarray:
    spectrum = np.fft.rfft(audio)
    frequencies = np.fft.rfftfreq(audio.size, 1 / rate)
    response = np.clip((frequencies - 120) / 200, 0, 1) * np.clip((7200 - frequencies) / 800, 0, 1)
    return np.fft.irfft(spectrum * response, n=audio.size).astype(np.float32)


def at_snr(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    speech_power = np.mean(speech**2) + 1e-9
    noise_power = np.mean(noise**2) + 1e-9
    return speech + noise * np.sqrt(speech_power / (noise_power * 10 ** (snr_db / 10)))


def augment_clip(audio: np.ndarray, rng: np.random.Generator, noises: list[np.ndarray], babble: list[np.ndarray]) -> tuple[np.ndarray, str]:
    kind = rng.choice(["clean", "fan", "street", "babble", "reverb", "laptop", "real"], p=[0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.10])
    out = audio.copy()
    if kind in ("reverb", "laptop", "babble"):
        out = np.convolve(out, room_impulse(rng))[: audio.size]
    if kind == "laptop":
        out = laptop_mic(out)
    if kind == "fan":
        t = np.arange(out.size) / 16000
        hum = 0.3 * np.sin(2 * np.pi * rng.uniform(80, 140) * t) + pink_noise(out.size, rng)
        out = at_snr(out, hum.astype(np.float32), rng.uniform(8, 20))
    elif kind == "street":
        out = at_snr(out, pink_noise(out.size, rng), rng.uniform(5, 15))
    elif kind == "babble" and babble:
        crowd = sum(np.resize(babble[rng.integers(len(babble))], out.size) for _ in range(4))
        out = at_snr(out, crowd.astype(np.float32), rng.uniform(8, 18))
    elif kind == "real" and noises:
        out = at_snr(out, np.resize(noises[rng.integers(len(noises))], out.size), rng.uniform(5, 20))
    peak = np.abs(out).max()
    return (out / peak * 0.9 if peak > 1 else out).astype(np.float32), kind


def augment(args: argparse.Namespace) -> None:
    target = data_dir() / args.name
    rows = [json.loads(line) for line in (target / "clean.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    rng = np.random.default_rng(args.seed)
    # Your own recordings of fans, traffic, kitchens... make it more real: drop WAVs in data/noise/.
    noises = [soundfile.read(path, dtype="float32")[0] for path in sorted((data_dir() / "noise").glob("*.wav"))]
    babble = [soundfile.read(target / row["audio"], dtype="float32")[0] for row in rows[:50]]
    out_dir = target / "audio"
    out_dir.mkdir(exist_ok=True)
    with (target / "manifest.jsonl").open("w", encoding="utf-8") as manifest:
        for row in rows:
            audio, _ = soundfile.read(target / row["audio"], dtype="float32")
            noisy, kind = augment_clip(audio, rng, noises, babble)
            name = f"{row['id']}.wav"
            soundfile.write(out_dir / name, noisy, 16000)
            manifest.write(json.dumps({**row, "audio": f"audio/{name}", "room": kind}, ensure_ascii=False) + "\n")
    print(f"{len(rows)} clips -> {target / 'manifest.jsonl'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=["scripts", "voice", "augment"])
    parser.add_argument("--split", choices=["eval", "train"], default="eval")
    parser.add_argument("--name", default=None, help="folder under the eval data dir (default pip-dictation or pip-dictation-train)")
    parser.add_argument("--languages", default="")
    parser.add_argument("--per-language", type=int, default=600)
    parser.add_argument("--model", default="qwen3:235b", help="a large local Ollama model; llama3.3:70b also works")
    parser.add_argument("--ollama", default="http://127.0.0.1:11434")
    parser.add_argument("--tts-model", default="ai4bharat/indic-parler-tts")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    args.name = args.name or ("pip-dictation" if args.split == "eval" else "pip-dictation-train")
    if args.split == "train":
        args.seed += 1000
    {"scripts": scripts, "voice": voice, "augment": augment}[args.step](args)


if __name__ == "__main__":
    main()
