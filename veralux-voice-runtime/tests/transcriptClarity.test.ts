import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  areTranscriptsNearDuplicates,
  classifyNearDuplicateMatch,
  isFillerOrNoiseTranscript,
  isTooShortForIntent,
} from '../src/stt/transcriptClarity';

describe('transcriptClarity', () => {
  it('isFillerOrNoiseTranscript detects fillers', () => {
    assert.strictEqual(isFillerOrNoiseTranscript('uh'), true);
    assert.strictEqual(isFillerOrNoiseTranscript('um um'), true);
    assert.strictEqual(isFillerOrNoiseTranscript('[music]'), true);
    assert.strictEqual(isFillerOrNoiseTranscript('...'), true);
  });

  it('isFillerOrNoiseTranscript leaves real utterances', () => {
    assert.strictEqual(isFillerOrNoiseTranscript('no'), false);
    assert.strictEqual(isFillerOrNoiseTranscript('I need an appointment'), false);
    assert.strictEqual(isFillerOrNoiseTranscript('uh I need help'), false);
  });

  it('isTooShortForIntent respects letter count', () => {
    assert.strictEqual(isTooShortForIntent('ab', 3), true);
    assert.strictEqual(isTooShortForIntent('abc', 3), false);
    assert.strictEqual(isTooShortForIntent('no', 2), false);
  });

  it('areTranscriptsNearDuplicates catches echo-like finals', () => {
    assert.strictEqual(
      areTranscriptsNearDuplicates('I need an appointment', 'I need an appointment.', 0.9),
      true,
    );
    assert.strictEqual(
      areTranscriptsNearDuplicates('Hello there', 'I need a doctor', 0.9),
      false,
    );
  });

  it('classifyNearDuplicateMatch returns stable reasons', () => {
    assert.strictEqual(
      classifyNearDuplicateMatch('same words', 'same words', 0.9),
      'identical',
    );
    assert.strictEqual(
      classifyNearDuplicateMatch('book a table', 'book a tabke', 0.9),
      'levenshtein',
    );
    assert.strictEqual(classifyNearDuplicateMatch('a', 'b', 0.9), null);
  });
});
