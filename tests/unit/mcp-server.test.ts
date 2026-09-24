import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'mcp-results');
const FIXTURE_RUN_ID = 'run-2026-07-15-093000';

const TOOL_NAMES = [
  'tournament_list_benches',
  'tournament_leaderboard',
  'tournament_get_run',
  'tournament_quick_test',
  'tournament_evaluate',
] as const;

const READ_ONLY_TOOLS = new Set(['tournament_list_benches', 'tournament_leaderboard', 'tournament_get_run']);

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer({ resultsRoot: FIXTURE_ROOT });
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

describe('MCP server protocol contract', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ client, close } = await connectedClient());
  });

  afterEach(async () => {
    await close();
  });

  it('reports server info and declares tools, resources, and prompts capabilities', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('mcp-tournament');

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
  });

  describe('tools', () => {
    it('lists exactly the 5 contract tools with correct annotations and an outputSchema', async () => {
      const { tools } = await client.listTools();
      const names = tools.map(tool => tool.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());

      for (const tool of tools) {
        expect(tool.outputSchema, `${tool.name} is missing an outputSchema`).toBeDefined();
        const readOnly = READ_ONLY_TOOLS.has(tool.name);
        expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(readOnly);
      }
    });

    it('tournament_leaderboard returns structuredContent matching the contract plus a text block', async () => {
      const result = await client.callTool({ name: 'tournament_leaderboard', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.content.some(block => block.type === 'text')).toBe(true);

      const structured = result.structuredContent as { entries: Array<Record<string, unknown>> };
      expect(Array.isArray(structured.entries)).toBe(true);
      expect(structured.entries.length).toBeGreaterThan(0);
      const first = structured.entries[0];
      expect(first).toHaveProperty('rank');
      expect(first).toHaveProperty('modelId');
      expect(first).toHaveProperty('modelName');
      expect(first).toHaveProperty('tier');
      expect(first).toHaveProperty('score');
      // Best score in the fixture belongs to DeepSeek V3.2.
      expect(first.modelId).toBe('deepseek/deepseek-v3.2');
      expect(first.rank).toBe(1);
    });

    it('tournament_list_benches returns structuredContent matching the contract plus a text block', async () => {
      const result = await client.callTool({ name: 'tournament_list_benches', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.content.some(block => block.type === 'text')).toBe(true);

      const structured = result.structuredContent as { benches: Array<Record<string, unknown>> };
      expect(Array.isArray(structured.benches)).toBe(true);
      expect(structured.benches.length).toBeGreaterThan(0);
      const dnd = structured.benches.find(bench => bench.name === 'dnd');
      expect(dnd).toBeDefined();
      expect(Array.isArray((dnd as { scenarios: unknown[] }).scenarios)).toBe(true);
    });

    it('tournament_get_run returns structuredContent matching the contract plus a text block', async () => {
      const result = await client.callTool({
        name: 'tournament_get_run',
        arguments: { runId: FIXTURE_RUN_ID },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content.some(block => block.type === 'text')).toBe(true);

      const structured = result.structuredContent as { run: Record<string, unknown> };
      expect(structured.run.runId).toBe(FIXTURE_RUN_ID);
      expect(structured.run.plugin).toBe('business-strategy');
      expect(Array.isArray(structured.run.candidates)).toBe(true);
      expect(Array.isArray(structured.run.failures)).toBe(true);
    });

    it('tournament_get_run with an unknown run ID returns isError naming real run IDs', async () => {
      const result = await client.callTool({
        name: 'tournament_get_run',
        arguments: { runId: 'run-does-not-exist' },
      });
      expect(result.isError).toBe(true);
      const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n');
      expect(text).toContain(FIXTURE_RUN_ID);
    });

    it('tournament_evaluate with an unknown plugin returns isError without any network call', async () => {
      const result = await client.callTool({
        name: 'tournament_evaluate',
        arguments: { models: ['deepseek/deepseek-v3.2'], plugin: 'not-a-real-plugin' },
      });
      expect(result.isError).toBe(true);
      const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n');
      expect(text.toLowerCase()).toContain('not-a-real-plugin');
    });
  });

  describe('resources', () => {
    it('lists the 3 static URIs and the run template enumerates the fixture run', async () => {
      const { resources } = await client.listResources();
      const uris = resources.map(resource => resource.uri);
      expect(uris).toContain('tournament://benches');
      expect(uris).toContain('tournament://leaderboard');
      expect(uris).toContain('tournament://runs');

      const { resourceTemplates } = await client.listResourceTemplates();
      const runTemplate = resourceTemplates.find(template => template.uriTemplate === 'tournament://runs/{runId}');
      expect(runTemplate).toBeDefined();
      const reportTemplate = resourceTemplates.find(
        template => template.uriTemplate === 'tournament://runs/{runId}/report',
      );
      expect(reportTemplate).toBeDefined();
    });

    it('readResource on the report template returns markdown text containing the winner name', async () => {
      const result = await client.readResource({
        uri: `tournament://runs/${FIXTURE_RUN_ID}/report`,
      });
      expect(result.contents).toHaveLength(1);
      const [content] = result.contents;
      expect(content.mimeType).toBe('text/markdown');
      expect('text' in content && content.text).toBeTruthy();
      const text = 'text' in content ? content.text : '';
      expect(text).toContain('DeepSeek V3.2');
    });

    it('completion for runId returns the fixture run ID', async () => {
      const completion = await client.complete({
        ref: { type: 'ref/resource', uri: 'tournament://runs/{runId}' },
        argument: { name: 'runId', value: 'run-2026' },
      });
      expect(completion.completion.values).toContain(FIXTURE_RUN_ID);
    });
  });

  describe('prompts', () => {
    it('lists the 3 contract prompts', async () => {
      const { prompts } = await client.listPrompts();
      const names = prompts.map(prompt => prompt.name).sort();
      expect(names).toEqual(['choose_model_for_task', 'compare_models', 'explain_run'].sort());
    });

    it('getPrompt(explain_run, {runId}) embeds a resource', async () => {
      const result = await client.getPrompt({
        name: 'explain_run',
        arguments: { runId: FIXTURE_RUN_ID },
      });
      const hasEmbeddedResource = result.messages.some(message => message.content.type === 'resource');
      expect(hasEmbeddedResource).toBe(true);
    });
  });

  describe('regression: protocol channel hygiene', () => {
    it('never writes to stdout during a full tool call', async () => {
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await client.callTool({ name: 'tournament_leaderboard', arguments: {} });
        await client.callTool({ name: 'tournament_get_run', arguments: { runId: FIXTURE_RUN_ID } });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
