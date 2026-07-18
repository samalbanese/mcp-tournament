import { getModelClient } from '../clients/index.js';
import { MAX_TOKENS_SYNTHESIS, RETRY_ATTEMPTS } from '../config/constants.js';
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
  model = SYNTHESIZER.model,
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
  const prompt = buildSynthesisPrompt(scenario, parsedJudges.map(result => ({
    judgeName: result.judgeName,
    judgeModel: result.judgeModel,
    parsed: result.parsed,
  })));

  // Budget models occasionally emit token-corrupted JSON (e.g. "score": Pt.5,
  // stray non-ASCII, unescaped quotes) that no normalizer can rescue. A fresh
  // sample nearly always parses, so re-generate instead of failing the pair.
  let raw = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    const response = await getModelClient(SYNTHESIZER.route).createMessage({
      model,
      max_tokens: MAX_TOKENS_SYNTHESIS,
      system: 'Synthesize independent evaluations into final scores. Return only valid JSON.',
      messages: [{ role: 'user', content: prompt }],
    });
    raw = response.text;
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    const synthesis = parseSynthesis(raw);
    if (synthesis) {
      return {
        synthesis,
        raw,
        parseSuccess: true,
        metrics: { inputTokens, outputTokens, timeMs: Date.now() - startedAt },
      };
    }
  }
  return {
    synthesis: null,
    raw,
    parseSuccess: false,
    metrics: { inputTokens, outputTokens, timeMs: Date.now() - startedAt },
  };
}
