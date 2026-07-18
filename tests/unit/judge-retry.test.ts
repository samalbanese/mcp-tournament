import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runJudge } from '../../src/agents/judge-agent.js';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type {
  CreateMessageParams,
  ModelClient,
  ModelResponse,
} from '../../src/clients/types.js';
import type { JudgeConfig } from '../../src/config/judges.js';
import { evaluateWithJudges } from '../../src/phases/judge-runner.js';
import type { TestCase, TournamentPlugin, Turn } from '../../src/plugins/base.js';

const originalClient = getModelClient('openrouter');
const temporaryDirectories: string[] = [];

const scenario: TestCase = {
  id: 'retry-scenario',
  name: 'Retry Scenario',
  description: 'Exercises judge output parsing.',
  setupMessage: 'Begin.',
  goalCard: 'Return a score.',
  minTurns: 1,
  maxTurns: 1,
};

const plugin: TournamentPlugin = {
  name: 'judge-test',
  description: 'Judge retry test plugin',
  version: '1.0.0',
  scenarios: [scenario],
  buildCandidatePrompt: () => 'Candidate prompt',
  buildJudgePrompt: () => 'Judge prompt',
  generateParticipantMessage: async () => 'Participant response',
};

const turns: Turn[] = [{ turn: 1, role: 'candidate', content: 'Candidate response' }];

const validScore = JSON.stringify({
  scores: {
    overall_task_quality: {
      score: 8,
      justification: 'The response completed the task.',
      quotes: ['Candidate response'],
      improvement: 'Add more detail.',
    },
  },
  rule_errors: [],
  tool_errors: [],
  flags: [],
  overall_impression: 'A valid judge result.',
});

function judge(name: string, role: string, model: string): JudgeConfig {
  return { name, role, model, family: 'test', route: 'openrouter', focus: ['quality'] };
}

function modelResponse(text: string, inputTokens = 1, outputTokens = 2): ModelResponse {
  return {
    text,
    content: [{ type: 'text', text }],
    stop_reason: 'stop',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    model: 'stub-model',
  };
}

afterEach(() => {
  registerModelClient('openrouter', originalClient);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('judge parse retries', () => {
  it('recovers when a fresh sample returns valid judge JSON', async () => {
    const createMessage = vi.fn()
      .mockResolvedValueOnce(modelResponse('not valid JSON', 3, 4))
      .mockResolvedValueOnce(modelResponse(validScore, 5, 6));
    registerModelClient('openrouter', { createMessage } as ModelClient);

    const result = await runJudge(
      judge('Rules Judge', 'rules', 'retry-model'),
      plugin,
      scenario,
      turns,
    );

    expect(result.parseSuccess).toBe(true);
    expect(result.parsed?.overall_impression).toBe('A valid judge result.');
    expect(result.metrics.inputTokens).toBe(8);
    expect(result.metrics.outputTokens).toBe(10);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('records an exhausted judge while preserving the valid panel result', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-judge-'));
    temporaryDirectories.push(outputDir);
    const createMessage = vi.fn(async (params: CreateMessageParams) =>
      modelResponse(params.model === 'valid-model' ? validScore : 'still not JSON'));
    registerModelClient('openrouter', { createMessage });

    const result = await evaluateWithJudges(
      plugin,
      scenario,
      turns,
      'candidate/model',
      outputDir,
      [
        judge('Broken Judge', 'rules', 'invalid-model'),
        judge('Valid Judge', 'creative', 'valid-model'),
      ],
      false,
    );

    expect(result.judgeResults).toHaveLength(1);
    expect(result.judgeResults[0].judgeName).toBe('Valid Judge');
    expect(result.failedJudges).toEqual([{
      judge: 'Broken Judge',
      error: 'Broken Judge returned invalid score JSON',
    }]);
    expect(createMessage.mock.calls.filter(([params]) =>
      params.model === 'invalid-model')).toHaveLength(3);
    expect(fs.existsSync(path.join(
      outputDir,
      'judges',
      'candidate_model',
      'retry_scenario',
      'creative.json',
    ))).toBe(true);
  });
});
