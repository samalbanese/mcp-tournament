import { getModelClient } from '../clients/index.js';
import { MAX_TOKENS_SYNTHESIS } from '../config/constants.js';
import { SYNTHESIZER } from '../config/judges.js';
import type { TestCase } from '../plugins/base.js';
import { buildSynthesisPrompt } from '../prompts/judge-prompts.js';
import { SynthesisSchema, type Synthesis } from '../schemas/synthesis.js';
import type { JudgeResult } from './judge-agent.js';

export interface SynthesisResult {
  synthesis: Synthesis | null;
  raw: string;
  parseSuccess: boolean;
  metrics: { inputTokens: number; outputTokens: number; timeMs: number };
}

/**
 * Models sometimes flatten final_scores to bare numbers despite the prompt
 * skeleton (observed with kimi-k2.5). Coerce that near-miss shape into the
 * schema instead of failing the whole synthesis phase over it.
 */
export function normalizeSynthesisPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const candidate = payload as Record<string, unknown>;
  const scores = candidate.final_scores;
  if (!scores || typeof scores !== 'object') return payload;
  const normalized = Object.fromEntries(Object.entries(scores as Record<string, unknown>)
    .map(([criterion, value]) => [
      criterion,
      typeof value === 'number'
        ? { score: value, confidence: 'medium', outliers: [] }
        : value,
    ]));
  return { ...candidate, final_scores: normalized };
}

function parseSynthesis(text: string): Synthesis | null {
  const match = text.match(/\`\`\`json\s*([\s\S]*?)\`\`\`/) ?? text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const result = SynthesisSchema.safeParse(
      normalizeSynthesisPayload(JSON.parse(match[1] ?? match[0])),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function runSynthesis(
  scenario: TestCase,
  judgeResults: JudgeResult[],
): Promise<SynthesisResult> {
  const parsedJudges = judgeResults.filter(result => result.parsed);
  if (parsedJudges.length < 2) {
    return {
      synthesis: null,
      raw: 'Fewer than two valid judge scores',
      parseSuccess: false,
      metrics: { inputTokens: 0, outputTokens: 0, timeMs: 0 },
    };
  }
  const startedAt = Date.now();
  const response = await getModelClient(SYNTHESIZER.route).createMessage({
    model: SYNTHESIZER.model,
    max_tokens: MAX_TOKENS_SYNTHESIS,
    system: 'Synthesize independent evaluations into final scores. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: buildSynthesisPrompt(scenario, parsedJudges.map(result => ({
        judgeName: result.judgeName,
        judgeModel: result.judgeModel,
        parsed: result.parsed,
      }))),
    }],
  });
  const synthesis = parseSynthesis(response.text);
  return {
    synthesis,
    raw: response.text,
    parseSuccess: synthesis !== null,
    metrics: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      timeMs: Date.now() - startedAt,
    },
  };
}
