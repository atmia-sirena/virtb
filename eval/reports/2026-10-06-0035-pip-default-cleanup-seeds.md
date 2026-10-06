# pip-default-cleanup-seeds

## cleanup-seeds

| scope | utterances | wer | cer | final_wer | zero_edit_rate | command_accuracy | filler_leak_rate | hallucinated_word_rate | entity_accuracy | latency_p50 | latency_p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 41 | 0.0 | 0.0 | 0.0513 | 0.878 ✗ | 0.8636 ✗ | 0.0 ✓ | 0.0 ✓ | 1.0 | 0.002 ✓ | 0.005 ✓ |
| en | 14 | 0.0 | 0.0 | 0.0465 | 0.8571 ✗ | 0.8571 ✗ | 0.0 ✓ | 0.0 ✓ | 1.0 | 0.002 ✓ | 0.008 ✓ |
| hi | 6 | 0.0 ✓ | 0.0 | 0.1429 | 0.8333 ✗ | 0.75 ✗ | 0.0 ✓ | 0.0 ✓ |  | 0.002 ✓ | 0.002 ✓ |
| hinglish | 12 | 0.0 ✓ | 0.0 | 0.0484 | 0.8333 ✗ | 0.75 ✗ | 0.0 ✓ | 0.0 ✓ | 1.0 | 0.002 ✓ | 0.002 ✓ |
| pa | 2 | 0.0 ✓ | 0.0 | 0.0 | 1.0 ✓ | 1.0 ✓ | 0.0 ✓ | 0.0 ✓ |  | 0.002 ✓ | 0.002 ✓ |
| ta | 4 | 0.0 ✓ | 0.0 ✓ | 0.0 | 1.0 ✓ | 1.0 ✓ | 0.0 ✓ | 0.0 ✓ |  | 0.001 ✓ | 0.001 ✓ |
| te | 3 | 0.0 ✓ | 0.0 ✓ | 0.0 | 1.0 ✓ | 1.0 ✓ | 0.0 ✓ | 0.0 ✓ |  | 0.001 ✓ | 0.002 ✓ |

Typed text that differs from what was meant (first 10):

- `en-010`: expected `I'll send it on Wednesday.`, got `I'll send it on Tuesday actually Wednesday.`
- `en-011`: expected `So I was thinking we should order food.`, got `So I was like thinking we should like order food.`
- `hi-005`: expected `मैं परसों आऊंगा।`, got `मैं कल आऊंगा मतलब परसों आऊंगा।`
- `hinglish-008`: expected `Main parso aaunga.`, got `Main kal aaunga matlab parso aaunga.`
- `hinglish-010`: expected `Office se nikal raha hoon, 10 minute mein pahunchunga.`, got `Office se nikal raha hoon 10 minute mein pahunchunga.`
