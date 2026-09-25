import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/mcp/server.js';
import { BenchDefinitionSchema } from '../../src/plugins/custom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'mcp-results');

function uniqueBenchName(): string {
  return `test-support-triage-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function validCreateBenchArgs(name: string): Record<string, unknown> {
  return {
    name,
    description: 'Tests how well a model triages angry billing support chats.',
    scenarios: [
      {
        id: 'double-charge-refund',
        name: 'Double Charge Refund Request',
        description: 'Customer was billed twice for one order and wants it fixed today.',
        prompt: 'A customer says they were charged twice for the same order and wants a refund today. Handle it.',
        rounds: 2,
        participantPersona: 'an impatient customer who was double-charged',
        criteria: [
          { name: 'resolution_quality', description: 'Fully resolves the billing issue without deflecting.' },
          { name: 'tone', description: 'Stays calm, empathetic, and professional throughout.' },
        ],
      },
    ],
  };
}

async function connectedClient(benchesDir: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer({ resultsRoot: FIXTURE_ROOT, benchesDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('tournament_create_bench', () => {
  let benchesDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    benchesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-benches-'));
    ({ client, close } = await connectedClient(benchesDir));
  });

  afterEach(async () => {
    await close();
    fs.rmSync(benchesDir, { recursive: true, force: true });
  });

  it('saves a new bench to disk with a valid, parseable definition', async () => {
    const name = uniqueBenchName();
    const result = await client.callTool({
      name: 'tournament_create_bench',
      arguments: validCreateBenchArgs(name),
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { bench: { name: string }; file: string };
    expect(structured.bench.name).toBe(name);
    expect(fs.existsSync(structured.file)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(structured.file, 'utf8')) as unknown;
    const parsed = BenchDefinitionSchema.parse(saved);
    expect(parsed.name).toBe(name);
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0].criteria.map(criterion => criterion.name)).toEqual([
      'resolution_quality',
      'tone',
    ]);
  });

  it('makes the new bench immediately visible to tournament_list_benches', async () => {
    const name = uniqueBenchName();
    await client.callTool({ name: 'tournament_create_bench', arguments: validCreateBenchArgs(name) });

    const listed = await client.callTool({ name: 'tournament_list_benches', arguments: {} });
    const structured = listed.structuredContent as { benches: Array<{ name: string }> };
    expect(structured.benches.some(bench => bench.name === name)).toBe(true);
  });

  it('rejects a second bench with the same name with an actionable isError message', async () => {
    const name = uniqueBenchName();
    const first = await client.callTool({ name: 'tournament_create_bench', arguments: validCreateBenchArgs(name) });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({ name: 'tournament_create_bench', arguments: validCreateBenchArgs(name) });
    expect(second.isError).toBe(true);
    const text = second.content.map(block => (block.type === 'text' ? block.text : '')).join('\n');
    expect(text).toContain(name);
    expect(text).toContain('already exists');
    expect(text).toContain(`plugin: "${name}"`);
  });

  it('rejects duplicate scenario IDs, which would overwrite each other\'s results, and saves nothing', async () => {
    const name = uniqueBenchName();
    const args = validCreateBenchArgs(name) as { scenarios: Array<Record<string, unknown>> };
    args.scenarios.push({ ...args.scenarios[0], name: 'Second Refund Request' });

    const result = await client.callTool({ name: 'tournament_create_bench', arguments: args });
    expect(result.isError).toBe(true);
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n');
    expect(text).toContain('"double-charge-refund" is used more than once');
    expect(fs.readdirSync(benchesDir)).toEqual([]);

    const listed = await client.callTool({ name: 'tournament_list_benches', arguments: {} });
    const structured = listed.structuredContent as { benches: Array<{ name: string }> };
    expect(structured.benches.some(bench => bench.name === name)).toBe(false);
  });
});
