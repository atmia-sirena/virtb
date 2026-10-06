# pip-default-cleanup-seeds

## cleanup-seeds

| scope | utterances | wer | cer | final_wer | zero_edit_rate | command_accuracy | filler_leak_rate | inserted_word_rate | entity_accuracy | latency_p50 | latency_p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 41 | 0.0 | 0.0 | 0.0564 | 0.7561 ✗ | 0.8182 ✗ | 0.0 ✓ | 0.0564 ✗ | 1.0 | 0.002 ✓ | 0.004 ✓ |
| en | 14 | 0.0 | 0.0 | 0.0581 | 0.7143 ✗ | 0.7143 ✗ | 0.0 ✓ | 0.0581 ✗ | 1.0 | 0.004 ✓ | 0.011 ✓ |
| hi | 6 | 0.0 ✓ | 0.0 | 0.1429 | 0.6667 ✗ | 0.75 ✗ | 0.0 ✓ | 0.1429 ✗ |  | 0.002 ✓ | 0.003 ✓ |
| hinglish | 12 | 0.0 ✓ | 0.0 | 0.0484 | 0.6667 ✗ | 0.75 ✗ | 0.0 ✓ | 0.0484 ✗ | 1.0 | 0.002 ✓ | 0.003 ✓ |
| pa | 2 | 0.0 ✓ | 0.0 | 0.0 | 1.0 ✓ | 1.0 ✓ | 0.0 ✓ | 0.0 ✓ |  | 0.003 ✓ | 0.004 ✓ |
| ta | 4 | 0.0 ✓ | 0.0 ✓ | 0.0 | 1.0 ✓ | 1.0 ✓ | 0.0 ✓ | 0.0 ✓ |  | 0.002 ✓ | 0.002 ✓ |
| te | 3 | 0.0 ✓ | 0.0 ✓ | 0.0 | 1.0 ✓ | 1.0 ✓ | 0.0 ✓ | 0.0 ✓ |  | 0.002 ✓ | 0.002 ✓ |

Typed text that differs from what was meant (first 10):

- `en-008`: expected `Can you call me back after the meeting?`, got `Can you call me back after the meeting.`
- `en-010`: expected `I'll send it on Wednesday.`, got `I'll send it on Tuesday actually Wednesday.`
- `en-011`: expected `So I was thinking we should order food.`, got `So I was like thinking we should like order food.`
- `en-012`: expected `Please share the deck by 4 pm.`, got `Please share the deck by 3 4 pm.`
- `hi-004`: expected `क्या आप कल फ्री हैं?`, got `क्या आप कल फ्री हैं।`
- `hi-005`: expected `मैं परसों आऊंगा।`, got `मैं कल आऊंगा मतलब परसों आऊंगा।`
- `hinglish-002`: expected `Bhai aaj raat ka plan kya hai?`, got `Bhai aaj raat ka plan kya hai.`
- `hinglish-008`: expected `Main parso aaunga.`, got `Main kal aaunga matlab parso aaunga.`
- `hinglish-009`: expected `Iska matlab kya hai bhai?`, got `Iska matlab kya hai bhai.`
- `hinglish-010`: expected `Office se nikal raha hoon, 10 minute mein pahunchunga.`, got `Office se nikal raha hoon 10 minute mein pahunchunga.`
