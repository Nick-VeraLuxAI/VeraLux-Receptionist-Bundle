export interface TTSRequest {
  text: string;
  tenantId?: string;
  voice?: string;
  /** Cloud TTS model (OpenAI TTS / ElevenLabs). */
  cloudTtsModel?: string;
  format?: string;
  sampleRate?: number;
  /** Kokoro: speaking speed (JSON field `rate`; server maps to synthesis speed). */
  rate?: number;
  /** Kokoro: base URL for the TTS service. */
  kokoroUrl?: string;
  /** Coqui XTTS: base URL for the TTS API (e.g. http://host:7002/api/tts). */
  coquiXttsUrl?: string;
  /** Chatterbox: base URL (e.g. http://host:7005 or http://host:7005/tts). */
  chatterboxUrl?: string;
  /** Qwen3-TTS: base URL (e.g. http://host:7010 or http://host:7010/tts). */
  qwen3TtsUrl?: string;
  /** Miso TTS 8B: base URL (e.g. http://host:7011 or http://host:7011/tts). */
  misoTtsUrl?: string;
  /** NVIDIA Magpie TTS: base URL (e.g. http://host:7012). */
  magpieTtsUrl?: string;
  /** MeloTTS: base URL (e.g. http://host:7013). */
  meloTtsUrl?: string;
  /** Qwen3-TTS: optional style instruction. */
  instruct?: string;
  /** Miso TTS: optional transcript for speakerWavUrl context. */
  speakerText?: string;
  /** Miso TTS generation controls. */
  misoMaxAudioLengthMs?: number;
  misoTemperature?: number;
  misoTopK?: number;
  magpieTemperature?: number;
  magpieCfgScale?: number;
  magpieTopK?: number;
  magpieUseCfg?: boolean;
  magpieApplyTn?: boolean;
  meloSdpRatio?: number;
  meloNoiseScale?: number;
  meloNoiseScaleW?: number;
  /** Qwen3-TTS generation (optional; sent to qwen3_tts_server). */
  qwen3DoSample?: boolean;
  qwen3Temperature?: number;
  qwen3TopP?: number;
  qwen3TopK?: number;
  qwen3RepetitionPenalty?: number;
  qwen3MaxNewTokens?: number;
  qwen3NonStreamingMode?: boolean;
  qwen3SubtalkerDoSample?: boolean;
  qwen3SubtalkerTopK?: number;
  qwen3SubtalkerTopP?: number;
  qwen3SubtalkerTemperature?: number;
  /** Coqui XTTS: reference audio for voice cloning (URL or path). XTTS uses this, not preset voice IDs. */
  speakerWavUrl?: string;
  /** Coqui XTTS: language code (default "en"). */
  language?: string;
  /** Coqui XTTS v2 tuning (sent to your server if present). */
  coquiTemperature?: number;
  coquiLengthPenalty?: number;
  coquiRepetitionPenalty?: number;
  coquiTopK?: number;
  coquiTopP?: number;
  coquiSpeed?: number;
  coquiSplitSentences?: boolean;
}

export interface TTSResult {
  audio: Buffer;
  contentType: string;
}