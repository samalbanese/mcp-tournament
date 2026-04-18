// judge-agent.ts — Factory that routes judge calls to Anthropic SDK or OpenRouter.

import { createMessage as createORMessage } from '../clients/openrouter.js';
import { createClaudeJsonMessage } from '../clients/anthropic-client.js';
import { JudgeScoreSchema, type JudgeScore } from '../schemas/judge-score.js';
import { MAX_TOKENS_JUDGE } from '../config/constants.js';
import { JUDGE_SYSTEM_PROMPTS, buildJudgeUserPrompt } from '../prompts/judge-prompts.js';
import type { JudgeConfig } from '../config/judges.js';
import type { TestCase } from '../plugins/base.js';
import type { Turn } from '../schemas/result.js';

export interface JudgeResult {
  judgeName: string;
  judgeRole: string;
  judgeModel: string;
  judgeFamily: string;
  raw: string;
  parsed: JudgeScore | null;
  parseSuccess: boolean;
  metrics: { inputTokens: number; outputTokens: number; timeMs: number };
}

// JSON parser that handles markdown-wrapped JSON
function parseJudgeJson(text: string): JudgeScore | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    const result = JudgeScoreSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch { return null; }
}

export async function runJudge(judge: JudgeConfig, scenario: Scenario, turns: Turn[]): Promise<JudgeResult> {
  const systemPrompt = JUDGE_SYSTEM_PROMPTS[judge.role];
  if (!systemPrompt) throw new Error(`No system prompt for judge role: ${judge.role}`);
  const userPrompt = buildJudgeUserPrompt(scenario, turns);
  const startTime = Date.now();

  let text: string;
  let usage: { input_tokens: number; output_tokens: number };

  if (judge.route === 'anthropic-sdk') {
    // Claude judge via SDK ($0)
    const result = await createClaudeJsonMessage({
      model: judge.model, max_tokens: MAX_TOKENS_JUDGE,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      schema: JudgeScoreSchema,
    });
    text = result.raw;
    usage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };
  } else {
    // Non-Claude judge via OpenRouter
    const response = await createORMessage({
      model: judge.model, max_tokens: MAX_TOKENS_JUDGE,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    text = response.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  }

  const parsed = parseJudgeJson(text);
  return {
    judgeName: judge.name, judgeRole: judge.role, judgeModel: judge.model, judgeFamily: judge.family,
    raw: text, parsed, parseSuccess: !!parsed,
    metrics: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, timeMs: Date.now() - startTime },
  };
}
