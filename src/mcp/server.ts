import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createContext } from './data.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

export interface CreateServerOptions {
  /** Directory holding `run-*` result folders. Defaults to ./results. */
  resultsRoot?: string;
}

export const SERVER_INFO = { name: 'mcp-tournament', version: '0.1.0' } as const;

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: [
      'MCP Tournament benchmarks language models head to head: candidate models play through',
      'scenarios from a bench, a panel of judge models scores each transcript, and a synthesizer',
      'reconciles the judges into one score out of 10.',
      '',
      'Start free: tournament_list_benches shows the benches and scenario IDs, and',
      'tournament_leaderboard / tournament_get_run read results already on disk.',
      'Running models costs money and time: tournament_quick_test (one model, one scenario, one',
      'judge) is the cheap sanity check; tournament_evaluate runs the full panel for up to four',
      'models and can take several minutes. Confirm with the user before starting a paid run.',
      '',
      'Past runs are also exposed as resources (tournament://runs, tournament://runs/{runId}/report).',
    ].join('\n'),
  });
  const ctx = createContext(options.resultsRoot);
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
