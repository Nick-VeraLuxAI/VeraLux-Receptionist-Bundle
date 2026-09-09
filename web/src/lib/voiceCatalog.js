/** Voice / language catalogs (ported from control-plane/public/qwen3-tts-options.js). */

/** Qwen3-TTS 1.7B CustomVoice — 9 official timbres. All can speak English. */
export const QWEN3_LANGUAGES = [
  { id: "Auto", label: "Auto — infer from text" },
  { id: "English", label: "English" },
  { id: "Chinese", label: "Chinese" },
  { id: "Japanese", label: "Japanese" },
  { id: "Korean", label: "Korean" },
  { id: "German", label: "German" },
  { id: "French", label: "French" },
  { id: "Spanish", label: "Spanish" },
  { id: "Portuguese", label: "Portuguese" },
  { id: "Italian", label: "Italian" },
  { id: "Russian", label: "Russian" },
];

export const QWEN3_SPEAKERS = [
  { id: "Serena", label: "Serena — warm receptionist (best English female)", gender: "female", native: "Chinese" },
  { id: "Vivian", label: "Vivian — bright, slightly edgy young female", gender: "female", native: "Chinese" },
  { id: "Sohee", label: "Sohee — warm, emotional female", gender: "female", native: "Korean" },
  { id: "Ono_Anna", label: "Ono Anna — playful, light female", gender: "female", native: "Japanese" },
  { id: "Ryan", label: "Ryan — dynamic English male", gender: "male", native: "English" },
  { id: "Aiden", label: "Aiden — sunny American male", gender: "male", native: "English" },
  { id: "Uncle_Fu", label: "Uncle Fu — seasoned low male", gender: "male", native: "Chinese" },
  { id: "Dylan", label: "Dylan — clear Beijing male", gender: "male", native: "Chinese" },
  { id: "Eric", label: "Eric — lively Chengdu male", gender: "male", native: "Chinese" },
];

export const QWEN3_PRESET_INSTRUCT = {
  warm: "Speak as a warm, friendly receptionist. Natural conversational American English.",
  energetic: "Speak with bright energy and a slightly quicker, upbeat pace.",
  calm: "Speak slowly, calmly, and reassuringly.",
  neutral: "",
};

export function qwen3InstructForPreset(preset) {
  return QWEN3_PRESET_INSTRUCT[preset] || "";
}

/** Tone plus a pace line the model can follow. The rate token is stripped before synthesis. */
export function qwen3InstructForTuning(preset, rate) {
  const tone = qwen3InstructForPreset(preset);
  const n = Number(rate);
  const paced = Number.isFinite(n) ? Math.min(1.2, Math.max(0.8, n)) : 1;
  const pace =
    paced <= 0.97
      ? "Speak a little more slowly."
      : paced >= 1.03
        ? "Speak a little more quickly."
        : "";
  const body = [tone, pace].filter(Boolean).join(" ");
  return `${body}${body ? " " : ""}[[vl-rate:${paced.toFixed(2)}]]`.trim();
}

const QWEN3_LANG_IDS = new Set(QWEN3_LANGUAGES.map((l) => l.id));
const ISO_TO_QWEN3 = {
  en: "English",
  "en-US": "English",
  "en-GB": "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
};

export function coerceQwen3Language(lang) {
  const t = (lang || "").trim();
  if (!t) return "English";
  if (QWEN3_LANG_IDS.has(t)) return t;
  return ISO_TO_QWEN3[t] || ISO_TO_QWEN3[t.split("-")[0]] || "English";
}

export const MISO_SPEAKERS = [
  { id: "0", label: "0 — default speaker" },
  { id: "1", label: "1 — alternate speaker" },
];

const KOKORO_PRESET_SPEED = { neutral: 1, warm: 0.96, energetic: 1.08, calm: 0.88 };

export function kokoroLanguageForVoice(voice) {
  const id = String(voice || "").toLowerCase();
  if (id.startsWith("bf_") || id.startsWith("bm_")) return "en-GB";
  return "en-US";
}

export function kokoroVoiceForLanguage(voice, language) {
  const lang = String(language || "").toLowerCase().startsWith("en-gb") ? "en-GB" : "en-US";
  const id = String(voice || "af_bella").trim() || "af_bella";
  if (!/^(a[fm]_|b[fm]_)[a-z]+$/i.test(id)) {
    return lang === "en-GB" ? "bf_emma" : "af_bella";
  }
  const male = /^(am_|bm_)/i.test(id);
  if ((kokoroLanguageForVoice(id) === "en-GB") === (lang === "en-GB")) return id;
  return male ? (lang === "en-GB" ? "bm_george" : "am_adam") : lang === "en-GB" ? "bf_emma" : "af_heart";
}

export function kokoroSpeedForTuning(preset, rate) {
  const n = Number(rate);
  const base = Number.isFinite(n) ? Math.min(1.2, Math.max(0.8, n)) : 1;
  const mul = KOKORO_PRESET_SPEED[preset] || 1;
  return Math.min(1.5, Math.max(0.5, Math.round(base * mul * 100) / 100));
}

export function kokoroTextForPreset(text, preset) {
  const t = String(text || "").trim();
  if (!t || !preset || preset === "neutral" || preset === "warm") return t;
  if (preset === "calm") return t.replace(/([.!?])\s+/g, "$1  ");
  if (preset === "energetic") return t.replace(/\s{2,}/g, " ");
  return t;
}

export const KOKORO_VOICES = [
  { id: "af_bella", label: "af_bella — American English female" },
  { id: "af_heart", label: "af_heart — American English female" },
  { id: "af_nicole", label: "af_nicole — American English female" },
  { id: "af_sarah", label: "af_sarah — American English female" },
  { id: "af_sky", label: "af_sky — American English female" },
  { id: "am_adam", label: "am_adam — American English male" },
  { id: "am_michael", label: "am_michael — American English male" },
  { id: "bf_emma", label: "bf_emma — British English female" },
  { id: "bm_george", label: "bm_george — British English male" },
];

const KOKORO_VOICE_RE = /^(a[fm]_|b[fm]_)[a-z]+$/i;

export function coerceKokoroVoice(voice) {
  const v = (voice || "").trim();
  return KOKORO_VOICE_RE.test(v) ? v : "af_bella";
}

export const XTTS_SAMPLE_VOICES = [
  { id: "en_sample", label: "en_sample — English" },
  { id: "es_sample", label: "es_sample — Spanish" },
  { id: "fr_sample", label: "fr_sample — French" },
];

export const OPENAI_TTS_VOICES = [
  { id: "alloy", label: "alloy" },
  { id: "ash", label: "ash" },
  { id: "coral", label: "coral" },
  { id: "echo", label: "echo" },
  { id: "fable", label: "fable" },
  { id: "nova", label: "nova" },
  { id: "onyx", label: "onyx" },
  { id: "sage", label: "sage" },
  { id: "shimmer", label: "shimmer" },
];

export const MAGPIE_SPEAKERS = [
  { id: "Aria", label: "Aria — bright female", gender: "female" },
  { id: "Jason", label: "Jason — clear male", gender: "male" },
  { id: "John", label: "John — warm male", gender: "male" },
  { id: "Leo", label: "Leo — deeper male", gender: "male" },
  { id: "Sofia", label: "Sofia — warm receptionist female", gender: "female" },
];

export const MAGPIE_LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese (Brazil)" },
  { id: "zh", label: "Chinese" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "hi", label: "Hindi" },
  { id: "vi", label: "Vietnamese" },
  { id: "ar", label: "Arabic" },
];

export const MAGPIE_PRESET_TUNING = {
  neutral: { temperature: 0.6, cfgScale: 2.5, topK: 80 },
  warm: { temperature: 0.55, cfgScale: 2.5, topK: 80 },
  energetic: { temperature: 0.75, cfgScale: 2.2, topK: 80 },
  calm: { temperature: 0.4, cfgScale: 2.8, topK: 80 },
};

export const MELO_SPEAKERS = [
  { id: "EN-US", label: "EN-US — American English", language: "EN", gender: "female" },
  { id: "EN-BR", label: "EN-BR — British English", language: "EN", gender: "female" },
  { id: "EN-INDIA", label: "EN-INDIA — Indian English", language: "EN", gender: "female" },
  { id: "EN-AU", label: "EN-AU — Australian English", language: "EN", gender: "female" },
  { id: "EN-Default", label: "EN-Default — default English", language: "EN", gender: "female" },
  { id: "ES", label: "ES — Spanish", language: "ES", gender: "female" },
  { id: "FR", label: "FR — French", language: "FR", gender: "female" },
  { id: "ZH", label: "ZH — Chinese", language: "ZH", gender: "female" },
  { id: "JP", label: "JP — Japanese", language: "JP", gender: "female" },
  { id: "KR", label: "KR — Korean", language: "KR", gender: "female" },
];

export const MELO_LANGUAGES = [
  { id: "EN", label: "English" },
  { id: "ES", label: "Spanish" },
  { id: "FR", label: "French" },
  { id: "ZH", label: "Chinese" },
  { id: "JP", label: "Japanese" },
  { id: "KR", label: "Korean" },
];

export const MELO_PRESET_TUNING = {
  neutral: { sdpRatio: 0.2, noiseScale: 0.6, noiseScaleW: 0.8 },
  warm: { sdpRatio: 0.55, noiseScale: 0.5, noiseScaleW: 0.7 },
  energetic: { sdpRatio: 0.35, noiseScale: 0.95, noiseScaleW: 1.05 },
  calm: { sdpRatio: 0.05, noiseScale: 0.35, noiseScaleW: 0.45 },
};

const MAGPIE_LANG_IDS = new Set(MAGPIE_LANGUAGES.map((l) => l.id));
const ISO_TO_MAGPIE = {
  en: "en",
  "en-US": "en",
  "en-GB": "en",
  es: "es",
  "es-US": "es",
  fr: "fr",
  de: "de",
  it: "it",
  pt: "pt",
  "pt-BR": "pt",
  zh: "zh",
  ja: "ja",
  ko: "ko",
  hi: "hi",
  vi: "vi",
  ar: "ar",
};

export function coerceMagpieLanguage(lang) {
  const t = (lang || "").trim();
  if (!t) return "en";
  if (MAGPIE_LANG_IDS.has(t)) return t;
  const lower = t.toLowerCase();
  return ISO_TO_MAGPIE[lower] || ISO_TO_MAGPIE[lower.split("-")[0]] || "en";
}

export function magpieTuningForPreset(preset) {
  return MAGPIE_PRESET_TUNING[preset] || MAGPIE_PRESET_TUNING.neutral;
}

export function meloLanguageForSpeaker(speaker) {
  const found = MELO_SPEAKERS.find((s) => s.id === speaker);
  return found ? found.language : "EN";
}

export function coerceMeloLanguage(lang, speaker) {
  const t = (lang || "").trim().toUpperCase();
  if (["EN", "ES", "FR", "ZH", "JP", "KR"].includes(t)) return t;
  if (speaker) return meloLanguageForSpeaker(speaker);
  const iso = (lang || "").trim().toLowerCase().split("-")[0];
  const map = { en: "EN", es: "ES", fr: "FR", zh: "ZH", ja: "JP", ko: "KR" };
  return map[iso] || "EN";
}

export function meloTuningForPreset(preset) {
  return MELO_PRESET_TUNING[preset] || MELO_PRESET_TUNING.neutral;
}

export const PRESET_ONLY_TTS = new Set(["kokoro_http", "qwen3_tts_http", "magpie_tts_http", "melo_tts_http"]);

export const ELEVENLABS_VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah" },
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { id: "29vD33N1CtxCmqQRPOHJ", label: "Drew" },
  { id: "2EiwWnXFnvU5JabPnv8n", label: "Clyde" },
  { id: "CYw3kZ02Hs0563khs1Fj", label: "Dave" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
];

export const ISO_LANGUAGES = [
  { id: "en", label: "English (en)" },
  { id: "es", label: "Spanish (es)" },
  { id: "fr", label: "French (fr)" },
  { id: "de", label: "German (de)" },
  { id: "it", label: "Italian (it)" },
  { id: "pt", label: "Portuguese (pt)" },
];

export function voicesForMode(mode, apiVoices) {
  if (Array.isArray(apiVoices) && apiVoices.length) {
    return apiVoices.map((v) => ({ id: v.id || v.value, label: v.label || v.id }));
  }
  switch (mode) {
    case "qwen3_tts_http":
      return QWEN3_SPEAKERS;
    case "magpie_tts_http":
      return MAGPIE_SPEAKERS;
    case "melo_tts_http":
      return MELO_SPEAKERS;
    case "miso_tts_http":
      return MISO_SPEAKERS;
    case "kokoro_http":
      return KOKORO_VOICES;
    case "coqui_xtts":
      return XTTS_SAMPLE_VOICES;
    case "openai_tts":
      return OPENAI_TTS_VOICES;
    case "elevenlabs":
      return ELEVENLABS_VOICES;
    default:
      return [];
  }
}

export function languagesForMode(mode) {
  if (mode === "qwen3_tts_http") return QWEN3_LANGUAGES;
  if (mode === "magpie_tts_http") return MAGPIE_LANGUAGES;
  if (mode === "melo_tts_http") return MELO_LANGUAGES;
  if (mode === "coqui_xtts" || mode === "chatterbox_http") return ISO_LANGUAGES;
  if (mode === "kokoro_http") {
    return [
      { id: "en-US", label: "American English (en-US)" },
      { id: "en-GB", label: "British English (en-GB)" },
    ];
  }
  return [
    { id: "en-US", label: "en-US" },
    { id: "en-GB", label: "en-GB" },
    { id: "es-US", label: "es-US" },
  ];
}

export function defaultVoiceLang(mode, voice, lang) {
  let v = (voice || "").trim();
  let l = (lang || "").trim();
  if (mode === "coqui_xtts") {
    if (!v) v = "en_sample";
    if (!l) l = "en";
  } else if (mode === "kokoro_http") {
    if (!v) v = "af_heart";
    l = kokoroLanguageForVoice(v);
    v = kokoroVoiceForLanguage(v, l);
  } else if (mode === "qwen3_tts_http") {
    if (!v) v = "Serena";
    l = coerceQwen3Language(l);
  } else if (mode === "magpie_tts_http") {
    if (!v) v = "Sofia";
    l = coerceMagpieLanguage(l);
  } else if (mode === "melo_tts_http") {
    if (!v) v = "EN-US";
    l = coerceMeloLanguage(l, v);
  } else if (mode === "miso_tts_http") {
    if (!v) v = "0";
    if (!l) l = "en";
  } else if (mode === "chatterbox_http") {
    if (!l) l = "en";
  } else if (mode === "openai_tts") {
    if (!v) v = "alloy";
    if (!l) l = "en";
  } else if (mode === "elevenlabs") {
    if (!v) v = "EXAVITQu4vr4xnSDxMaL";
    if (!l) l = "en";
  }
  return { voice: v, lang: l };
}
