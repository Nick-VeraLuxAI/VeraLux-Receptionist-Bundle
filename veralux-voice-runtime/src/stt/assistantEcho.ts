/**
 * Detect when a user "final" is likely assistant playback / echo transcribed by Whisper.
 */

export type EchoSuppressionMode = 'conservative' | 'balanced' | 'permissive';

const FILLER = new Set([
  'a',
  'an',
  'the',
  'uh',
  'um',
  'hm',
  'hmm',
  'like',
  'you',
  'know',
  'oh',
  'ah',
  'yeah',
  'yes',
  'no',
  'ok',
  'okay',
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exported for forensics artifacts and tests. */
export function normalizeForEchoCompare(s: string): string {
  return normalize(s);
}

function tokenSet(norm: string): Set<string> {
  const out = new Set<string>();
  for (const w of norm.split(' ')) {
    if (w.length === 0) continue;
    if (FILLER.has(w) && w.length < 4) continue;
    out.add(w);
  }
  return out;
}

/** Jaccard on word sets; 0–1 */
function tokenJaccard(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Bounded Levenshtein distance (same as transcriptClarity). */
function levenshteinDist(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (m > 350 || n > 350) return Math.max(m, n);

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

function levenshteinSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const d = levenshteinDist(a, b);
  const maxL = Math.max(a.length, b.length);
  return maxL > 0 ? 1 - d / maxL : 0;
}

/** Share of user content words (len>2, non-filler) not present in reference. */
function novelWordShare(userNorm: string, refNorm: string): number {
  const uWords = userNorm.split(' ').filter((w) => w.length > 2 && !FILLER.has(w));
  if (uWords.length === 0) return 0;
  const refSet = tokenSet(refNorm);
  let novel = 0;
  for (const w of uWords) {
    if (!refSet.has(w)) novel += 1;
  }
  return novel / uWords.length;
}

function thresholdsForMode(mode: EchoSuppressionMode): {
  jaccard: number;
  levMin: number;
  minRefLenForSubstring: number;
} {
  switch (mode) {
    case 'conservative':
      return { jaccard: 0.38, levMin: 0.62, minRefLenForSubstring: 8 };
    case 'permissive':
      return { jaccard: 0.62, levMin: 0.82, minRefLenForSubstring: 14 };
    case 'balanced':
    default:
      return { jaccard: 0.5, levMin: 0.74, minRefLenForSubstring: 10 };
  }
}

export type AssistantEchoMatchResult = {
  isAssistantEcho: boolean;
  score: number;
  method: 'none' | 'identical' | 'substring' | 'token_jaccard' | 'levenshtein';
  matchedAssistantText?: string;
};

/**
 * Returns true if the user transcript should be rejected as assistant echo.
 * candidates: last assistant lines + recent TTS/playback strings (deduped, non-empty).
 */
export function matchAssistantEcho(
  userTranscript: string,
  candidates: string[],
  mode: EchoSuppressionMode,
): AssistantEchoMatchResult {
  const u = normalize(userTranscript);
  if (!u) return { isAssistantEcho: false, score: 0, method: 'none' };

  const uniq = [...new Set(candidates.map((c) => normalize(c)).filter((c) => c.length > 0))];
  if (uniq.length === 0) return { isAssistantEcho: false, score: 0, method: 'none' };

  const { jaccard: jTh, levMin: levTh, minRefLenForSubstring } = thresholdsForMode(mode);

  let best: AssistantEchoMatchResult = { isAssistantEcho: false, score: 0, method: 'none' };

  for (const ref of uniq) {
    if (!ref) continue;

    if (u === ref) {
      return { isAssistantEcho: true, score: 1, method: 'identical', matchedAssistantText: ref };
    }

    const novel = novelWordShare(u, ref);
    if (novel >= 0.42 && u.length > ref.length * 0.85) {
      continue;
    }

    const shorter = u.length <= ref.length ? u : ref;
    const longer = u.length <= ref.length ? ref : u;
    if (longer.includes(shorter) && shorter.length >= minRefLenForSubstring && shorter.length >= longer.length * 0.68) {
      return { isAssistantEcho: true, score: 0.95, method: 'substring', matchedAssistantText: ref };
    }

    const jac = tokenJaccard(u, ref);
    const lev = levenshteinSimilarity(u, ref);
    const blended = Math.max(jac, lev * 0.95);

    if (jac >= jTh || lev >= levTh) {
      const score = blended;
      if (!best.isAssistantEcho || score > best.score) {
        best = {
          isAssistantEcho: true,
          score,
          method: jac >= jTh && jac >= lev ? 'token_jaccard' : 'levenshtein',
          matchedAssistantText: ref,
        };
      }
    }
  }

  return best;
}
