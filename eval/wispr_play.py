"""Plays test clips into a virtual microphone while holding a dictation app's hotkey,
then copies what it typed (Windows). See wispr_compare.md.

    pip install sounddevice keyboard pyperclip
    python wispr_play.py --set pip-dictation --out wispr.jsonl --device "CABLE Input" --hotkey "ctrl+win"
"""

from __future__ import annotations

import argparse
import json
import time

import soundfile

from pip_eval.manifest import load_config, load_set


def main() -> None:
    import keyboard
    import pyperclip
    import sounddevice

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--device", default="CABLE Input", help="the virtual cable's playback side")
    parser.add_argument("--hotkey", default="ctrl+win", help="the app's push-to-talk shortcut")
    parser.add_argument("--settle", type=float, default=2.5, help="seconds to wait for the text after releasing")
    args = parser.parse_args()
    utterances = [item for item in load_set(args.set, load_config()) if item.audio]
    with open(args.out, "a", encoding="utf-8") as output:
        for utterance in utterances:
            audio, rate = soundfile.read(utterance.audio, dtype="float32")
            keyboard.send("ctrl+a, delete")
            keys = args.hotkey.split("+")
            for key in keys:
                keyboard.press(key)
            time.sleep(0.4)
            started = time.perf_counter()
            sounddevice.play(audio, rate, device=args.device, blocking=True)
            time.sleep(0.3)
            for key in reversed(keys):
                keyboard.release(key)
            released = time.perf_counter()
            time.sleep(args.settle)
            keyboard.send("ctrl+a, ctrl+c")
            time.sleep(0.2)
            text = pyperclip.paste()
            output.write(json.dumps({"id": utterance.id, "text": text, "audio_seconds": round(released - started, 2)}, ensure_ascii=False) + "\n")
            print(utterance.id, text[:60])


if __name__ == "__main__":
    main()
