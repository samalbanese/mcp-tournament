import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  compactRunSummary,
  evaluateTournament,
  formatLeaderboard,
  quickTest,
  readLeaderboard,
} from './pipeline.js';
import { logError, logInfo } from './utils/logger.js';
import { loadBenches } from './plugins/custom.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'mcp-tournament', version: '0.1.0' });

  server.tool(
    'tournament.evaluate',
    'Evaluate one to four candidate models with a judge panel.',
    {
      models: z.array(z.string()).min(1).max(4),
      plugin: z.string().default('dnd'),
      scenarios: z.array(z.string()).optional(),
      judges: z.number().int().min(1).max(5).default(3),
    },
    async input => {
      const run = await evaluateTournament(input);
      return { content: [{ type: 'text' as const, text: compactRunSummary(run) }] };
    },
  );

  server.tool(
    'tournament.quick_test',
    'Run one scenario with one judge and no synthesis model call.',
    {
      model: z.string(),
      plugin: z.string().default('dnd'),
      scenario: z.string().optional(),
    },
    async input => {
      const run = await quickTest(input);
      return { content: [{ type: 'text' as const, text: compactRunSummary(run) }] };
    },
  );

  server.tool(
    'tournament.leaderboard',
    'Read the best cached score per model from result files.',
    {
      plugin: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async input => ({
      content: [{
        type: 'text' as const,
        text: formatLeaderboard(readLeaderboard(input)),
      }],
    }),
  );
  return server;
}

export async function serve(): Promise<void> {
  loadBenches(path.join(process.cwd(), 'benches'));
  await createServer().connect(new StdioServerTransport());
  logInfo('MCP Tournament server running on stdio');
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isMain) {
  serve().catch(error => {
    logError(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
