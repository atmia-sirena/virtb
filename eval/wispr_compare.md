# Comparing Pip with Wispr Flow

Wispr Flow publishes about 8.7% WER for English and no figures for Indian languages. To compare like for like, run both on the same audio and score both with this harness. Everything stays on your PC except what Wispr Flow itself sends to its servers.

## 1. Pick the audio

Use the Pip Dictation Set (`generate_dictation_set.py`) and your personal clips (Home → Settings → Languages → Record test set). Public read-speech sets (FLEURS, Kathbath) say little about dictation polish; Wispr is judged on fillers, corrections and formatting.

## 2. Get Wispr Flow's output

Wispr Flow only listens to a microphone, so the clips have to be played into one.

1. Install a virtual audio cable (for example VB-CABLE) and set it as Wispr Flow's microphone.
2. Open a plain text editor and put the cursor in it.
3. Run `python wispr_play.py --set pip-dictation --out wispr.jsonl`. For each clip it:
   - holds Wispr's hotkey;
   - plays the clip into the cable;
   - releases the hotkey;
   - waits for the text, copies it, and saves it with the clip's id.
4. Or do it by hand: play each clip with Wispr listening, then paste the text into `wispr.jsonl` as `{"id": "...", "text": "..."}` lines.

Use the same Wispr settings you'd use day to day, with English, Hindi, Tamil, Telugu and Punjabi enabled.

## 3. Score both

```bash
python run.py --set pip-dictation --cleanup --config pip-default
python score_external.py --set pip-dictation --outputs wispr.jsonl --name wispr-flow
```

`score_external.py` puts Wispr's text through the same metrics, so the two reports line up:

- WER/CER against what was said;
- zero-edit rate against what should be typed;
- command and correction accuracy;
- filler leaks;
- hallucinated words;
- entity accuracy;
- latency, if you record it.

## 4. Read the result

Pip is "as good as Wispr Flow" for a language when, on the same clips:

- its zero-edit rate is at least Wispr's;
- its command and correction accuracy and entity accuracy are at least Wispr's;
- its WER is no worse than Wispr's plus 0.5.

The absolute targets in the plan (for example Hindi WER ≤ 8%, zero-edit ≥ 90%) still apply on top.
