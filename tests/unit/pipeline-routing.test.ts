import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelClient, ModelResponse } from '../../src/clients/types.js';
import { JUDGES } from '../../src/config/judges.js';
import { evaluateTournament } from '../../src/pipeline.js';
import type { TournamentPlugin } from '../../src/plugins/base.js';
import { registerPlugin } from '../../src/plugins/index.js';

const originalClient = getModelClient('openrouter');
const temporaryDirectories: string[] = [];

const plugin: TournamentPlugin = {
  name: 'routing-override-test',
  description: 'One-turn pipeline routing fixture',
  version: '1.0.0',
  scenarios: [{
    id: 'routing-scenario',
    name: 'Routing Scenario',
    description: 'Exercises per-run model routing.',
    setupMessage: 'Answer once.',
    goalCard: 'Return a useful answer.',
    minTurns: 1,
    maxTurns: 1,
  }],
  buildCandidatePrompt: () => 'Candidate prompt',
  buildJudgePrompt: () => 'Judge prompt',
  generateParticipantMessage: async () => 'No follow-up',
};

registerPlugin(plugin);

const judgeScore = JSON.stringify({
  scores: {
    overall_task_quality: {
      score: 8,
      justification: 'The response completed the task.',
      quotes: ['Candidate response'],
      improvement: 'Add a little more detail.',
    },
  },
  rule_errors: [],
  tool_errors: [],
  flags: [],
  overall_impression: 'A valid judge result.',
});

const synthesis = JSON.stringify({
  final_scores: {
    overall_task_quality: { score: 8, confidence: 'high', outliers: [] },
  },
  average_score: 8,
  rule_errors_confirmed: [],
  assessment: 'The panel agrees.',
  judge_agreement: 'Strong agreement.',
});

function response(text: string, model: string): ModelResponse {
  return {
    text,
    content: [{ type: 'text', text }],
    stop_reason: 'stop',
    usage: { input_tokens: 1, output_tokens: 1 },
    model,
  };
}

afterEach(() => {
  registerModelClient('openrouter', originalClient);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('per-run pipeline model routing', () => {
  it('uses overrides for execution and the manifest while preserving other judge defaults', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-routing-'));
    temporaryDirectories.push(outputRoot);
    const createMessage = vi.fn(async (params: CreateMessageParams) => {
      if (params.model === 'candidate/test-model') {
        return response('Candidate response', params.model);
      }
      if (params.model === 'synthesizer/override') {
        return response(synthesis, params.model);
      }
      return response(judgeScore, params.model);
    });
    registerModelClient('openrouter', { createMessage } as ModelClient);

    const run = await evaluateTournament({
      models: ['candidate/test-model'],
      plugin: plugin.name,
      judges: 2,
      judgeModels: { rules: 'judge/rules-override' },
      synthesizerModel: 'synthesizer/override',
      outputRoot,
      runId: 'run-routing-override',
    });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'),
    ) as {
      judges: Array<{ role: string; model: string }>;
      synthesizer: { model: string };
    };
    expect(manifest.judges).toEqual([
      { role: 'rules', name: JUDGES[0].name, model: 'judge/rules-override' },
      { role: 'creative', name: JUDGES[1].name, model: JUDGES[1].model },
    ]);
    expect(manifest.synthesizer.model).toBe('synthesizer/override');
    expect(createMessage.mock.calls.map(([params]) => params.model)).toEqual(expect.arrayContaining([
      'judge/rules-override',
      JUDGES[1].model,
      'synthesizer/override',
    ]));
  });
});
