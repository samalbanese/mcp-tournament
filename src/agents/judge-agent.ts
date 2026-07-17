import { getModelClient } from '../clients/index.js';
import { MAX_TOKENS_JUDGE } from '../config/constants.js';
import type { JudgeConfig } from '../config/judges.js';
import type { TestCase, TournamentPlugin, Turn } from '../plugins/base.js';
import { JudgeScoreSchema, type JudgeScore } from '../schemas/judge-score.js';
import { buildJudgeUserPrompt, JUDGE_SYSTEM_PROMPTS } from '../prompts/judge-prompts.js';

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

function parseJudgeJson(text: string): JudgeScore | null {
  const jsonMatch = text.match(/\`\`\`json\s*([\s\S]*?)\`\`\`/) ?? text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const result = JudgeScoreSchema.safeParse(JSON.parse(jsonMatch[1] ?? jsonMatch[0]));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function runJudge(
  judge: JudgeConfig,
  plugin: TournamentPlugin,
  scenario: TestCase,
  turns: Turn[],
): Promise<JudgeResult> {
  const system = JUDGE_SYSTEM_PROMPTS[judge.role] ?? JUDGE_SYSTEM_PROMPTS.holistic;
  const prompt = buildJudgeUserPrompt(plugin, judge.role, scenario, turns);
  const startedAt = Date.now();
  const response = await getModelClient(judge.route).createMessage({
    model: judge.model,
    max_tokens: MAX_TOKENS_JUDGE,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = parseJudgeJson(response.text);
  return {
    judgeName: judge.name,
    judgeRole: judge.role,
    judgeModel: judge.model,
    judgeFamily: judge.family,
    raw: response.text,
    parsed,
    parseSuccess: parsed !== null,
    metrics: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      timeMs: Date.now() - startedAt,
    },
  };
}
