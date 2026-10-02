import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCatalogCache } from '../../src/catalog.js';
import { createRequestHandler } from '../../src/server.js';
import { createServer } from '../../src/mcp/server.js';
import type { TournamentOptions } from '../../src/mcp/tools.js';

const catalogFetch = vi.fn(async () => new Response(JSON.stringify({ data: [
  { id: 'a/b', name: 'B', reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high', mandatory: true } },
  { id: 'deepseek/deepseek-v3.2', reasoning: { supported_efforts: ['low', 'high'] } },
] })));
let root: string;
const evaluate = vi.fn(async () => { throw new Error('Offline evaluation stub'); });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-surfaces-'));
  resetCatalogCache();
  evaluate.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

async function request(method: string, url: string, body?: unknown) {
  const incoming = Readable.from(body ? [JSON.stringify(body)] : []) as IncomingMessage;
  Object.assign(incoming, { method, url, headers: {} });
  let status = 0;
  let data: any;
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string) { data = JSON.parse(value); },
  } as ServerResponse;
  await createRequestHandler({ rootDir: root, port: 4790, fetch: catalogFetch, evaluate })(incoming, response);
  await new Promise(resolve => setImmediate(resolve));
  return { status, data };
}

const run = (extra: Record<string, unknown> = {}) => ({ apiKey: 'offline-test', plugin: 'dnd', models: ['a/b@low'], ...extra });

describe('reasoning surfaces', () => {
  it('returns reasoning metadata in the model catalog', async () => {
    const result = await request('GET', '/api/models');
    expect(result.status).toBe(200);
    expect(result.data[0]).toMatchObject({ reasoningLevels: ['low', 'high'], defaultReasoning: 'high', reasonsByDefault: true, hasReasoning: true });
  });

  it('accepts a suffixed model and reuses the validated catalog for evaluation', async () => {
    expect((await request('POST', '/api/runs', run())).status).toBe(202);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ models: ['a/b@low'], catalog: expect.objectContaining({ source: 'live' }) }));
  });

  it.each([
    [run({ models: ['a/b@medium'] }), 'accepts low, high'],
    [run({ models: ['a/b@turbo'] }), 'unknown reasoning level'],
    [run({ models: ['a/b@low', 'a/b@LOW'] }), 'listed twice'],
    [run({ judgeModels: { rules: 'a/b@medium' } }), 'accepts low, high'],
    [run({ synthesizerModel: 'a/b@medium' }), 'accepts low, high'],
  ])('rejects invalid seats before evaluation: %j', async (body, message) => {
    const result = await request('POST', '/api/runs', body);
    expect(result.status).toBe(400);
    expect(result.data.error.toLowerCase()).toContain(message.toLowerCase());
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('includes shortlist levels in the MCP payload and output schema', async () => {
    const server = createServer({ resultsRoot: root, fetch: catalogFetch });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'reasoning-test', version: '1' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'tournament_options', arguments: {} });
      const payload = result.structuredContent as TournamentOptions;
      expect(Object.values(payload.models.shortlist).flat()[0]).toMatchObject({ reasoningLevels: ['low', 'high'] });
      const { tools } = await client.listTools();
      expect(JSON.stringify(tools.find(tool => tool.name === 'tournament_options')?.outputSchema)).toContain('reasoningLevels');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('GUI defaults', () => {
  it('keeps a judge default level so picking Default in Settings does not hide it', async () => {
    vi.resetModules();
    vi.stubEnv('TOURNAMENT_MODEL_JUDGE_RULES', 'a/b@high');
    try {
      const server = await import('../../src/server.js');
      const incoming = Readable.from([]) as IncomingMessage;
      Object.assign(incoming, { method: 'GET', url: '/api/defaults', headers: {} });
      let data: any;
      const response = { writeHead() {}, end(value: string) { data = JSON.parse(value); } } as unknown as ServerResponse;
      await server.createRequestHandler({ rootDir: root, port: 4790, fetch: catalogFetch, evaluate })(incoming, response);
      expect(data.judges.find((judge: { role: string }) => judge.role === 'rules').model).toBe('a/b@high');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('MCP reports', () => {
  it('show each judge level so two levels of one judge model are told apart', async () => {
    const { formatRunResultMarkdown } = await import('../../src/mcp/format.js');
    const text = formatRunResultMarkdown({
      runId: 'run-test', plugin: 'dnd', entries: [], failures: [], judgeFailures: [], resultsDir: root,
      judges: [
        { role: 'rules', name: 'Accuracy', model: 'openai/gpt-6.1-sol', reasoning: 'low' },
        { role: 'skeptic', name: 'Skeptic', model: 'openai/gpt-6.1-sol', reasoning: 'high' },
        { role: 'holistic', name: 'Holistic', model: 'qwen/qwen3.5-flash-02-23' },
      ],
    });
    expect(text).toContain('Accuracy (openai/gpt-6.1-sol · low), Skeptic (openai/gpt-6.1-sol · high), Holistic (qwen/qwen3.5-flash-02-23)');
  });

  it('show judge levels in the full run report resource', async () => {
    const { buildReport } = await import('../../src/mcp/report.js');
    const text = buildReport({
      runId: 'run-test', plugin: 'dnd', createdAt: '2026-10-02T06:00:00.000Z', candidates: [], scenarios: [],
      leaderboard: null, failures: [],
      judges: [
        { role: 'rules', name: 'Accuracy', model: 'openai/gpt-6.1-sol', reasoning: 'low' },
        { role: 'holistic', name: 'Holistic', model: 'qwen/qwen3.5-flash-02-23' },
      ],
    });
    expect(text).toContain('| rules | Accuracy | openai/gpt-6.1-sol · low |');
    expect(text).toContain('| holistic | Holistic | qwen/qwen3.5-flash-02-23 |');
  });

  it('show judge and synthesizer levels in the GUI download', async () => {
    const { buildReport } = await import('../../gui/src/analysis.js');
    const text = buildReport({
      runId: 'run-test', plugin: 'dnd', createdAt: '2026-10-02T06:00:00.000Z', candidates: [], scenarios: [],
      judges: [
        { role: 'rules', name: 'Accuracy', model: 'openai/gpt-6.1-sol', reasoning: 'high' },
        { role: 'holistic', name: 'Holistic', model: 'qwen/qwen3.5-flash-02-23' },
      ],
      synthesizer: { model: 'z-ai/glm-5.3', reasoning: 'low' },
    }, []);
    expect(text).toContain('- Accuracy: openai/gpt-6.1-sol · high');
    expect(text).toContain('- Holistic: qwen/qwen3.5-flash-02-23\n');
    expect(text).toContain('- Synthesizer: z-ai/glm-5.3 · low');
  });
});
