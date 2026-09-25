import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvaluateOptions, TournamentRun } from '../../src/pipeline.js';
import { createServer } from '../../src/mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'mcp-results');

const FAKE_RUN: TournamentRun = {
  runId: 'run-2026-07-15-093000',
  runDir: path.join(FIXTURE_ROOT, 'run-2026-07-15-093000'),
  leaderboard: [
    {
      modelId: 'deepseek/deepseek-v3.2',
      modelName: 'DeepSeek V3.2',
      tier: 'budget',
      overallAverage: 8.4,
      scenarioScores: [],
    },
  ],
  failures: [],
  judgeFailures: [],
};

// Recorded so tests can assert on exactly what options the MCP tool layer passed through to the
// pipeline (e.g. the judgeModels/synthesizerModel conversion), without re-implementing the pipeline.
const recordedCalls: EvaluateOptions[] = [];

vi.mock('../../src/pipeline.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/pipeline.js')>();
  return {
    ...actual,
    evaluateTournament: vi.fn(async (options: EvaluateOptions) => {
      recordedCalls.push(options);
      const total = 4;
      options.onProgress?.({ completed: 1, total, message: 'deepseek/deepseek-v3.2 on pricing-pivot: started' });
      options.onProgress?.({ completed: 2, total, message: 'deepseek/deepseek-v3.2 on pricing-pivot: finished' });
      options.onProgress?.({ completed: 3, total, message: 'openai/gpt-5.4-mini on pricing-pivot: started' });
      options.onProgress?.({ completed: 4, total, message: 'openai/gpt-5.4-mini on pricing-pivot: finished' });
      return FAKE_RUN;
    }),
  };
});

describe('tournament_evaluate progress notifications', () => {
  let client: Client | undefined;
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await client?.close();
    await closeServer?.();
    client = undefined;
    closeServer = undefined;
    recordedCalls.length = 0;
  });

  it('forwards monotonically increasing progress notifications when the request carries a progress token', async () => {
    const server = createServer({ resultsRoot: FIXTURE_ROOT });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    closeServer = () => server.close();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const progressUpdates: Array<{ progress: number; total?: number; message?: string }> = [];

    const result = await client.callTool(
      {
        name: 'tournament_evaluate',
        arguments: { models: ['deepseek/deepseek-v3.2', 'openai/gpt-5.4-mini'], plugin: 'business-strategy' },
      },
      undefined,
      {
        onprogress: progress => {
          progressUpdates.push(progress);
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(progressUpdates.length).toBeGreaterThan(0);
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i].progress).toBeGreaterThan(progressUpdates[i - 1].progress);
    }
    expect(progressUpdates[progressUpdates.length - 1].progress).toBe(progressUpdates[progressUpdates.length - 1].total);
  });

  it('converts judgeModels + synthesizerModel into the pipeline\'s judges count and judgeModels map', async () => {
    const server = createServer({ resultsRoot: FIXTURE_ROOT });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    closeServer = () => server.close();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({
      name: 'tournament_evaluate',
      arguments: {
        models: ['deepseek/deepseek-v3.2'],
        plugin: 'business-strategy',
        judgeModels: ['a/one', 'b/two'],
        synthesizerModel: 'c/syn',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(recordedCalls).toHaveLength(1);
    const [call] = recordedCalls;
    expect(call.judges).toBe(2);
    expect(call.judgeModels).toEqual({ rules: 'a/one', creative: 'b/two' });
    expect(call.synthesizerModel).toBe('c/syn');
  });
});
