import { describe, expect, it } from "vitest";
import { cleanTranscript } from "../src/speech/cleanup/index.js";
import { indianGrouping } from "../src/speech/cleanup/deterministic.js";
import { parseNumberWords, renderNumbered, replacementAllowed, verifyAndApply } from "../src/speech/cleanup/llm-edit.js";
import { romanizeDevanagariWord, romanizeTokens } from "../src/speech/cleanup/script.js";
import { detokenize, tokenize } from "../src/speech/cleanup/tokens.js";

const rules = async (text: string, language: string, extra: Record<string, unknown> = {}) => (await cleanTranscript({ text, language, llmPass: "off", ...extra })).text;

describe("rules: English (Indian English)", () => {
  it.each([
    ["um so I I think we should uh meet tomorrow", "So I think we should meet tomorrow."],
    ["ummmm okay", "Okay"],
    ["send the report to rahul scratch that send it to priya", "Send it to priya."],
    ["Send the report to Rahul. Scratch that. Send it to Priya.", "Send it to Priya."],
    ["write this down scratch that", ""],
    ["let's meet at 5 pm no wait 6 pm", "Let's meet at 6 pm."],
    ["I'll call Rahul no wait I'll call Priya tomorrow", "I'll call Priya tomorrow."],
    ["my email is atmia at the rate gmail dot com", "My email is atmia@gmail.com"],
    ["the trial period ends tomorrow period", "The trial period ends tomorrow."],
    ["Hi Rahul comma how are you question mark new line see you tomorrow", "Hi Rahul, how are you?\nSee you tomorrow."],
    ["things to buy number one milk number two eggs number three bread", "Things to buy\n1. milk\n2. eggs\n3. bread."],
    ["it costs 150000 rupees", "It costs ₹1,50,000"],
    ["the budget is rupees 2500 for the team", "The budget is ₹2,500 for the team."],
    ["we raised 5 lakh rupees this month", "We raised ₹5 lakh this month."],
    ["no wait I can't come today", "No wait I can't come today."],
    ["see you at the dot", "See you at the dot."],
    ["can you call me back after the meeting", "Can you call me back after the meeting?"],
    ["please share the deck by 3 30 pm sorry I mean 4 pm", "Please share the deck by 4 pm."],
  ])("%s", async (input, expected) => {
    expect(await rules(input, "en-IN")).toBe(expected);
  });

  it("uses pauses from timed words as clause boundaries", async () => {
    const words = [
      { w: "book", start: 0, end: 0.3 },
      { w: "the", start: 0.35, end: 0.45 },
      { w: "flight", start: 0.5, end: 0.9 },
      { w: "send", start: 2.0, end: 2.3 },
      { w: "the", start: 2.35, end: 2.45 },
      { w: "email", start: 2.5, end: 2.9 },
      { w: "scratch", start: 3.0, end: 3.3 },
      { w: "that", start: 3.35, end: 3.6 },
    ];
    expect((await cleanTranscript({ text: "", words, language: "en", llmPass: "off" })).text).toBe("Book the flight");
  });
});

describe("rules: Hinglish (romanized)", () => {
  it.each([
    ["kal meeting 5 baje hai nahi nahi 6 baje hai", "Kal meeting 6 baje hai."],
    ["umm kal ki meeting cancel karo", "Kal ki meeting cancel karo."],
    ["order ki details bhejo pichhla hata do payment link bhejo", "Payment link bhejo"],
    ["dheere dheere chalo yaar", "Dheere dheere chalo yaar."],
    ["jaldi jaldi aao", "Jaldi jaldi aao"],
    ["ka- kal milte hain", "Kal milte hain"],
    ["nahi nahi main nahi aaunga", "Nahi nahi main nahi aaunga."],
    ["haan theek hai naya line kal milte hain", "Haan theek hai\nKal milte hain."],
    ["maine galti se file delete kar di", "Maine galti se file delete kar di."],
    ["bhai aaj raat ka plan kya hai", "Bhai aaj raat ka plan kya hai?"],
  ])("%s", async (input, expected) => {
    expect(await rules(input, "hinglish")).toBe(expected);
  });

  it("romanizes Devanagari output for Hinglish", async () => {
    expect(await rules("कल मीटिंग पांच बजे है नहीं नहीं छह बजे है", "hinglish")).toBe("Kal meeting chhe baje hai.");
    expect(await rules("अच्छा ठीक है मैं ऑफिस से कॉल करूंगा", "hinglish")).toBe("Accha theek hai main office se call karunga.");
  });

  it("prefers the speech server's transliteration over the rules for unknown words", async () => {
    const text = await rules("मेरा लैपटॉप स्लो चल रहा है", "hinglish", { transliterate: async (words: string[]) => words.map((word) => (word === "स्लो" ? "slow" : undefined)) });
    expect(text).toBe("Mera laptop slow chal raha hai.");
  });

  it("keeps Devanagari when Hindi is set to native script", async () => {
    expect(await rules("मैं कल आऊंगा पूर्ण विराम नई लाइन ठीक है", "hi")).toBe("मैं कल आऊंगा।\nठीक है।");
  });
});

describe("rules: Hindi, Tamil, Telugu, Punjabi (native script)", () => {
  it.each([
    ["hi", "उम्म मैं कल आऊंगा नहीं नहीं परसों आऊंगा", "मैं परसों आऊंगा"],
    ["hi", "धीरे धीरे चलो", "धीरे धीरे चलो"],
    ["hi", "पहला वाक्य पूर्ण विराम दूसरा वाक्य पिछला हटा दो", "पहला वाक्य।"],
    ["ta", "ம்ம் நாளைக்கு வரேன் புதிய வரி சரி", "நாளைக்கு வரேன்\nசரி"],
    ["ta", "நாளைக்கு வரேன் இல்ல இல்ல நாளன்னைக்கு வரேன்", "நாளன்னைக்கு வரேன்"],
    ["ta", "மெல்ல மெல்ல போ", "மெல்ல மெல்ல போ"],
    ["te", "రేపు వస్తాను కాదు కాదు ఎల్లుండి వస్తాను", "ఎల్లుండి వస్తాను"],
    ["te", "హ్మ్ సరే కొత్త లైన్ రేపు కలుద్దాం", "సరే\nరేపు కలుద్దాం"],
    ["pa", "ਮੈਂ ਕੱਲ੍ਹ ਆਵਾਂਗਾ ਨਹੀਂ ਨਹੀਂ ਪਰਸੋਂ ਆਵਾਂਗਾ", "ਮੈਂ ਪਰਸੋਂ ਆਵਾਂਗਾ"],
  ])("%s: %s", async (language, input, expected) => {
    expect(await rules(input, language)).toBe(expected);
  });
});

describe("LLM edit verifier", () => {
  const tokens = tokenize("kal ki meeting 5 baje hai matlab 6 baje hai");

  it("numbers words for the prompt", () => {
    expect(renderNumbered(tokenize("haan, theek hai."))).toBe("[0]haan, [1]theek [2]hai.");
  });

  it("applies deletes and punctuation", () => {
    const result = verifyAndApply(tokens, { delete: [[3, 6]], punctuation: [{ after: 9, mark: "." }] }, { dictionary: [] });
    expect(result.ok && detokenize(result.tokens)).toBe("kal ki meeting 6 baje hai.");
  });

  it("rejects new words, bad indexes and deleting too much", () => {
    expect(verifyAndApply(tokens, { replace: [{ from: 0, to: 0, with: "parso" }] }, { dictionary: [] }).ok).toBe(false);
    expect(verifyAndApply(tokens, { delete: [[3, 40]] }, { dictionary: [] }).ok).toBe(false);
    expect(verifyAndApply(tokens, { delete: [[0, 8]] }, { dictionary: [] }).ok).toBe(false);
    expect(verifyAndApply(tokens, { punctuation: [{ after: 2, mark: "—" }] }, { dictionary: [] }).ok).toBe(false);
  });

  it("allows dictionary spellings, digits and joined words only", () => {
    expect(replacementAllowed(["serena"], "Sirena", ["Sirena"])).toBe(true);
    expect(replacementAllowed(["serena"], "Sirena", [])).toBe(false);
    expect(replacementAllowed(["banana"], "Sirena", ["Sirena"])).toBe(false);
    expect(replacementAllowed(["twenty", "five"], "25", [])).toBe(true);
    expect(replacementAllowed(["five", "lakh"], "5,00,000", [])).toBe(true);
    expect(replacementAllowed(["ten", "percent"], "10%", [])).toBe(true);
    expect(replacementAllowed(["twenty", "five"], "26", [])).toBe(false);
    expect(replacementAllowed(["e", "mail"], "email", [])).toBe(true);
    expect(replacementAllowed(["whats", "app"], "WhatsApp", [])).toBe(true);
  });

  it("parses Indian number words", () => {
    expect(parseNumberWords(["two", "crore", "fifty", "lakh"])).toBe(2_50_00_000);
    expect(parseNumberWords(["one", "hundred", "and", "five"])).toBe(105);
    expect(indianGrouping("25000000")).toBe("2,50,00,000");
  });

  it("falls back to the rules when the model is unavailable or wrong", async () => {
    const text = "i was like thinking we meet on tuesday actually wednesday";
    expect((await cleanTranscript({ text, language: "en", editor: async () => undefined })).llm).toBe("unavailable");
    const failed = await cleanTranscript({ text, language: "en", editor: async () => { throw new Error("boom"); } });
    expect(failed).toMatchObject({ llm: "failed", text: "I was like thinking we meet on tuesday actually wednesday." });
  });
});

describe("Hinglish romanization rules", () => {
  it.each([
    ["समझना", "samajhna"], ["जानकारी", "jaankari"], ["अपना", "apna"], ["बच्चा", "baccha"], ["प्यार", "pyaar"],
    ["ज़रूर", "zaroor"], ["मित्र", "mitra"], ["बोलता", "bolta"], ["वहाँ", "wahan"], ["कमल", "kamal"], ["लड़की", "ladki"],
    ["स्वागत", "swagat"], ["संपर्क", "sampark"], ["२०२६", "2026"],
  ])("%s -> %s", (word, expected) => {
    expect(romanizeDevanagariWord(word)).toBe(expected);
  });

  it("turns dandas into full stops", async () => {
    const result = await romanizeTokens(tokenize("ठीक है।"));
    expect(detokenize(result.tokens)).toBe("theek hai.");
  });
});
