/**
 * Heuristics for “we did not get a usable user intent” without calling the LLM.
 * Conservative: avoid reprompting on plausible short answers (e.g. “yes”, “no”, “two”).
 */

const BRACKETED_NON_SPEECH =
  /^\s*\[+\s*(?:music|noise|silence|laugh(?:ter|ing)?|applause|inaudible|unintelligible|crosstalk)\s*\]+\s*$/i;

const FILLER_ONLY =
  /^(?:uh+\.?|um+\.?|hm+\.?|hmm+\.?|mmm+\.?|mm+\.?|erm+|er+\.?|oh+\.?|ah+\.?|well\.?|like\.?|you know\.?)(?:\s+(?:uh+\.?|um+\.?|hm+\.?|hmm+\.?|erm+|er+\.?|oh+\.?|ah+\.?|well\.?|like\.?|you know\.?))*$/i;

const PUNCT_ONLY = /^[\s.?!,;:'"«»—–\-_…]+$/u;

/** True if transcript is clearly non-intent (fillers / tags / punctuation). */
export function isFillerOrNoiseTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (BRACKETED_NON_SPEECH.test(t)) return true;
  if (PUNCT_ONLY.test(t)) return true;
  const singleWord = t.replace(/\s+/g, ' ');
  if (FILLER_ONLY.test(singleWord)) return true;
  return false;
}

/**
 * Very short transcripts that are mostly not letters (e.g. "." or "…") already handled above.
 * Single-letter words are allowed (e.g. "A" for a suite) — not treated as unclear here.
 */
export function isTooShortForIntent(text: string, minLetters: number): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return false;
  return letters.length < minLetters;
}

function normalizeForDedupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bounded Levenshtein for short strings (caller should cap length). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (m > 400 || n > 400) return Math.max(m, n);

  const v0 = new Array<number>(n + 1);
  const v1 = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) v0[j] = j;
  for (let i = 0; i < m; i += 1) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j]! + 1, v0[j + 1]! + 1, v0[j]! + cost);
    }
    for (let j = 0; j <= n; j += 1) v0[j] = v1[j]!;
  }
  return v0[n]!;
}

/** How two finals matched for near-duplicate suppression (metrics / logs). */
export type NearDuplicateMatchKind = 'identical' | 'substring' | 'levenshtein';

/**
 * Classify why two finals are treated as the same utterance (double endpointing / echo), or null if not.
 * similarityThreshold: 0–1, e.g. 0.9 means at least 90% character similarity.
 */
export function classifyNearDuplicateMatch(
  a: string,
  b: string,
  similarityThreshold: number,
): NearDuplicateMatchKind | null {
  const x = normalizeForDedupe(a);
  const y = normalizeForDedupe(b);
  if (!x || !y) return null;
  if (x === y) return 'identical';
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (longer.includes(shorter) && shorter.length >= Math.min(12, longer.length * 0.85)) {
    return 'substring';
  }

  const dist = levenshtein(x, y);
  const maxL = Math.max(x.length, y.length);
  const sim = 1 - dist / maxL;
  if (sim >= similarityThreshold) return 'levenshtein';
  return null;
}

/** True if two finals are likely the same utterance (double endpointing / model echo). */
export function areTranscriptsNearDuplicates(a: string, b: string, similarityThreshold: number): boolean {
  return classifyNearDuplicateMatch(a, b, similarityThreshold) !== null;
}
