/**
 * Split assistant text into smaller chunks so Qwen3-TTS can return the first WAV sooner
 * (lower time-to-first-audio) when tenant `qwen3Streaming` is enabled.
 * This is not model-level streaming; it is multiple HTTP /tts calls in sequence.
 *
 * Voice consistency: each chunk is an independent synthesis. Stochastic decoding (`do_sample`)
 * makes every chunk sound like a new random take. The runtime defaults `do_sample` to false when
 * unset (see `applyQwen3VoiceConsistencyDefaults`). For maximum consistency, disable chunked
 * synthesis so the whole reply is one WAV.
 */

const MAX_SINGLE_CHUNK_CHARS = 140;

function splitLongSentence(s: string): string[] {
  const t = s.trim();
  if (t.length <= MAX_SINGLE_CHUNK_CHARS) {
    return [t];
  }
  const out: string[] = [];
  let rest = t;
  while (rest.length > 0) {
    let take = Math.min(MAX_SINGLE_CHUNK_CHARS, rest.length);
    if (take < rest.length) {
      const space = rest.lastIndexOf(' ', take);
      if (space > 40) {
        take = space;
      }
    }
    const piece = rest.slice(0, take).trim();
    if (piece) {
      out.push(piece);
    }
    rest = rest.slice(take).trim();
  }
  return out.length ? out : [t];
}

export function splitQwenStreamingChunks(text: string): string[] {
  const t = text.trim();
  if (!t) {
    return [];
  }

  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return [];
  }

  if (sentences.length === 1) {
    return splitLongSentence(sentences[0]!);
  }

  const expanded: string[] = [];
  for (const s of sentences) {
    expanded.push(...splitLongSentence(s));
  }
  return expanded.length ? expanded : [t];
}
