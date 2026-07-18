import { describe, expect, it } from 'vitest';
import { normalizeSynthesisPayload } from '../../src/agents/synthesizer.js';
import { SynthesisSchema } from '../../src/schemas/synthesis.js';

// Regression: real synthesizer output from run-2026-07-17-235321 (kimi-k2.5).
// The model flattened final_scores to bare numbers, which failed schema
// validation and killed an otherwise-successful evaluation.
const FLAT_PAYLOAD = {
  final_scores: {
    rules_accuracy: 6,
    narrative_quality: 9,
    dice_integration: 7,
  },
  average_score: 7.0,
  confidence: 'medium',
  rule_errors_confirmed: ['Object Interaction misrule: drawing a second weapon cost an action'],
  assessment: 'Strong atmosphere, inconsistent mechanics.',
  judge_agreement: 'High consensus on narrative quality; contested on dice integration.',
};

describe('normalizeSynthesisPayload', () => {
  it('coerces bare-number final_scores into schema-valid criterion objects', () => {
    const parsed = SynthesisSchema.safeParse(normalizeSynthesisPayload(FLAT_PAYLOAD));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.final_scores.narrative_quality).toEqual({
        score: 9,
        confidence: 'medium',
        outliers: [],
      });
      expect(parsed.data.average_score).toBe(7.0);
    }
  });

  it('leaves already-conforming payloads untouched', () => {
    const conforming = {
      ...FLAT_PAYLOAD,
      final_scores: {
        rules_accuracy: { score: 6, confidence: 'high', outliers: [] },
      },
    };
    const parsed = SynthesisSchema.safeParse(normalizeSynthesisPayload(conforming));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.final_scores.rules_accuracy.confidence).toBe('high');
    }
  });

  it('passes non-object payloads through for the schema to reject', () => {
    expect(SynthesisSchema.safeParse(normalizeSynthesisPayload(null)).success).toBe(false);
    expect(SynthesisSchema.safeParse(normalizeSynthesisPayload('nonsense')).success).toBe(false);
  });
});
