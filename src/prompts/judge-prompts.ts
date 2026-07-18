import type { JudgeScore } from '../schemas/judge-score.js';
import type { TestCase, TournamentPlugin, Turn } from '../plugins/base.js';

const JSON_INSTRUCTION = `Score each listed criterion from 1 to 10. A 5 is competent
but unremarkable; reserve 9-10 for exceptional work. Cite evidence and return only JSON
matching this shape:
{
  "scores": {
    "criterion": {
      "score": 7,
      "justification": "Evidence-based reason",
      "quotes": ["supporting quote"],
      "improvement": "specific improvement"
    }
  },
  "rule_errors": [],
  "tool_errors": [],
  "flags": [],
  "overall_impression": "brief assessment"
}`;

export const JUDGE_SYSTEM_PROMPTS: Record<string, string> = {
  rules: `You are a precise correctness and tool-use evaluator. Check factual,
logical, procedural, and domain-rule accuracy. ${JSON_INSTRUCTION}`,
  creative: `You evaluate clarity, originality, communication quality, and whether
the response avoids generic filler. ${JSON_INSTRUCTION}`,
  holistic: `You evaluate overall task completion, usefulness, and the quality of
the participant experience. ${JSON_INSTRUCTION}`,
  authentic_voice: `You evaluate whether the response has a natural, specific voice
instead of repetitive model-like phrasing. ${JSON_INSTRUCTION}`,
  npc_world: `You evaluate context use, internal consistency, and whether details
remain coherent across the interaction. ${JSON_INSTRUCTION}`,
};

export function buildJudgeUserPrompt(
  plugin: TournamentPlugin,
  role: string,
  scenario: TestCase,
  turns: Turn[],
): string {
  const criteria = scenario.gradingCriteria?.length
    ? scenario.gradingCriteria
    : plugin.scoringRubric?.dimensions ?? [];
  const criteriaText = criteria.length
    ? criteria.map(criterion => `- ${criterion.name}: ${criterion.description}`).join('\n')
    : '- overall_task_quality: Correctness, usefulness, clarity, and completion';
  const transcript = turns.map(turn =>
    `[Turn ${turn.turn} - ${turn.role}] ${turn.content}`).join('\n\n');
  const pluginPrompt = plugin.buildJudgePrompt(role, scenario, turns);

  return `Plugin: ${plugin.name}
Scenario: ${scenario.name}
Goal: ${scenario.goalCard}

Criteria:
${criteriaText}

Domain guidance:
${pluginPrompt}

Transcript:
${transcript}

${JSON_INSTRUCTION}`;
}

export function buildSynthesisPrompt(
  scenario: TestCase,
  judgeEvaluations: Array<{
    judgeName: string;
    judgeModel: string;
    parsed: JudgeScore | null;
  }>,
): string {
  return `Synthesize these independent evaluations for "${scenario.name}".
Use the median where possible. Confidence must be "high", "medium", or "contested".
Return only JSON in EXACTLY this shape (every final_scores value is an object, never a bare number):
{
  "final_scores": {
    "<criterion>": { "score": 7, "confidence": "high", "outliers": ["<judge name>: scored N vs median M - <why>"] }
  },
  "average_score": 6.5,
  "rule_errors_confirmed": ["<error>"],
  "assessment": "<2-5 sentence overall assessment>",
  "judge_agreement": "<where judges agreed and disagreed>"
}

${judgeEvaluations.map(evaluation =>
    `${evaluation.judgeName} (${evaluation.judgeModel}):\n${JSON.stringify(evaluation.parsed, null, 2)}`
  ).join('\n\n')}`;
}
