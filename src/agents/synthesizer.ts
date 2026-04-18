// synthesizer.ts — Opus via Anthropic SDK. Pure arbiter, never judges.

import { createClaudeJsonMessage } from '../clients/anthropic-client.js';
import { SynthesisSchema, type Synthesis } from '../schemas/synthesis.js';
import { SYNTHESIZER } from '../config/judges.js';
import { MAX_TOKENS_SYNTHESIS } from '../config/constants.js';
import { buildSynthesisPrompt } from '../prompts/judge-prompts.js';
import type { TestCase } from '../plugins/base.js';
import type { JudgeResult } from './judge-agent.js';

export interface SynthesisResult {
  synthesis: Synthesis | null;
  raw: string;
  parseSuccess: boolean;
  metrics: { inputTokens: number; outputTokens: number; timeMs: number };
}

export async function runSynthesis(scenario: Scenario, judgeResults: JudgeResult[]): Promise<SynthesisResult> {
  const parsedJudges = judgeResults.filter(j => j.parseSuccess);
  if (parsedJudges.length < 2) {
    return { synthesis: null, raw: 'Fewer than 2 judges parsed', parseSuccess: false, metrics: { inputTokens: 0, outputTokens: 0, timeMs: 0 } };
  }

  const synthPrompt = buildSynthesisPrompt(
    scenario,
    parsedJudges.map(j => ({ judgeName: j.judgeName, judgeModel: j.judgeModel, parsed: j.parsed })),
  );

  const startTime = Date.now();
  const result = await createClaudeJsonMessage({
    model: SYNTHESIZER.model, max_tokens: MAX_TOKENS_SYNTHESIS,
    system: 'You are the lead evaluator synthesizing multiple specialist judge opinions into final scores. Respond ONLY with valid JSON.',
    messages: [{ role: 'user', content: synthPrompt }],
    schema: SynthesisSchema,
  });

  return {
    synthesis: result.parsed, raw: result.raw, parseSuccess: !!result.parsed,
    metrics: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, timeMs: Date.now() - startTime },
  };
}
