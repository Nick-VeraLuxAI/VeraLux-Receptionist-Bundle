import {
  QWEN3_SPEAKERS,
  defaultVoiceLang,
  coerceQwen3Language,
  qwen3InstructForPreset,
  qwen3InstructForTuning,
  voicesForMode,
} from "./voiceCatalog";

describe("Qwen3 CustomVoice catalog", () => {
  test("lists the nine official CustomVoice speakers", () => {
    expect(QWEN3_SPEAKERS.map((s) => s.id)).toEqual([
      "Serena",
      "Vivian",
      "Sohee",
      "Ono_Anna",
      "Ryan",
      "Aiden",
      "Uncle_Fu",
      "Dylan",
      "Eric",
    ]);
  });

  test("defaults receptionist engine to Serena + English", () => {
    const d = defaultVoiceLang("qwen3_tts_http", "", "en");
    expect(d.voice).toBe("Serena");
    expect(d.lang).toBe("English");
  });

  test("coerces ISO language codes to Qwen3 names", () => {
    expect(coerceQwen3Language("en")).toBe("English");
    expect(coerceQwen3Language("en-US")).toBe("English");
    expect(coerceQwen3Language("English")).toBe("English");
  });

  test("maps tone presets to instruct text the TTS server applies", () => {
    expect(qwen3InstructForPreset("warm")).toMatch(/receptionist/i);
    expect(qwen3InstructForPreset("neutral")).toBe("");
  });

  test("folds speaking rate into the Qwen3 instruct token", () => {
    expect(qwen3InstructForTuning("energetic", 0.95)).toMatch(/bright energy/);
    expect(qwen3InstructForTuning("energetic", 0.95)).toMatch(/slowly/);
    expect(qwen3InstructForTuning("energetic", 0.95)).toMatch(/\[\[vl-rate:0\.95\]\]/);
  });

  test("exposes those speakers on the voice selector for qwen3_tts_http", () => {
    const voices = voicesForMode("qwen3_tts_http");
    expect(voices).toHaveLength(9);
    expect(voices[0].id).toBe("Serena");
  });
});
