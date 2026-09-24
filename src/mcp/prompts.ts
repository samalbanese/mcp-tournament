/**
 * MCP prompts: canned instructions a client can surface as slash commands.
 * Each one tells the assistant exactly which tournament tools to call and how
 * to explain the result in plain language, including the cost of any paid
 * (real API call) step.
 */
import { z } from 'zod';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completeRunIds, describeBenches, readRun, type McpContext } from './data.js';
import { buildReport } from './report.js';

export function registerPrompts(server: McpServer, ctx: McpContext): void {
  server.registerPrompt(
    'compare_models',
    {
      title: 'Compare models head to head',
      description:
        'Runs a fresh tournament comparing the given models on a bench and explains the ' +
        'result. This calls tournament_evaluate, which makes real API calls to every ' +
        'candidate model and every judge, so it costs money and takes a few minutes. Use ' +
        'choose_model_for_task instead if an existing leaderboard would already answer the ' +
        'question.',
      argsSchema: {
        models: z.string().describe('Comma-separated model IDs to compare, e.g. "deepseek/deepseek-v3.2,openai/gpt-5.4-mini"'),
        plugin: completable(
          z.string().optional().describe('Bench (plugin) name to run, e.g. "dnd" or "customer-support". Defaults to "dnd".'),
          value => describeBenches().map(bench => bench.name).filter(name => name.startsWith(value ?? '')),
        ),
      },
    },
    async ({ models, plugin }) => {
      const modelList = models.split(',').map(id => id.trim()).filter(Boolean);
      const benchNote = plugin ? `the "${plugin}" bench` : 'the default bench ("dnd")';
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text:
              `Compare these models head to head on ${benchNote}: ${modelList.join(', ')}.\n\n` +
              `1. Call tournament_evaluate with models: ${JSON.stringify(modelList)}` +
              `${plugin ? `, plugin: "${plugin}"` : ''}. This makes real API calls to each ` +
              'candidate and to the judge panel, so tell the user up front that this costs ' +
              'money and takes a few minutes before you call it.\n' +
              '2. Once it returns, call tournament_get_run with the runId it gives back for ' +
              'the per-scenario detail.\n' +
              '3. Summarize for a non-technical reader: who won, by how much, and the one or ' +
              'two criteria that decided it. Avoid jargon; explain any judge disagreement in ' +
              'plain terms (e.g. "judges disagreed on how clear the policy explanation was").',
          },
        }],
      };
    },
  );

  server.registerPrompt(
    'choose_model_for_task',
    {
      title: 'Choose a model for a task',
      description:
        'Recommends a model for a plain-language task description, using existing results ' +
        'first. Free unless it decides a fresh run is warranted (it will ask before running ' +
        'one, since that costs money). Use this before compare_models when the user has not ' +
        'already named the specific models to compare.',
      argsSchema: {
        task: z.string().describe('Plain-language description of what the model needs to do, e.g. "handle angry billing support chats"'),
      },
    },
    async ({ task }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Recommend a model for this task: "${task}".\n\n` +
            '1. Call tournament_list_benches (free, local) and pick the bench whose ' +
            'description and scenarios most closely match the task.\n' +
            '2. Call tournament_leaderboard with that bench\'s plugin name (free, local) to ' +
            'see which models have already scored well on it.\n' +
            '3. If the leaderboard has solid coverage, recommend the top model(s) and explain ' +
            'why in plain language, citing the scenario scores that matter for this task.\n' +
            '4. If the leaderboard is empty or thin for this bench, tell the user that and ' +
            'offer to run a fresh evaluation with tournament_evaluate, which makes real API ' +
            'calls to each candidate and judge (costs money, takes a few minutes). Only run ' +
            'it if the user agrees.',
        },
      }],
    }),
  );

  const runIdCompleter = async (value: string) => completeRunIds(ctx, value);

  server.registerPrompt(
    'explain_run',
    {
      title: 'Explain a run in plain English',
      description:
        'Embeds a run\'s markdown report and asks for a plain-English explanation aimed at a ' +
        'non-technical reader. Free, local, no API calls (the run must already exist). Use ' +
        'this when someone wants an existing run explained rather than a new one created.',
      argsSchema: {
        runId: completable(
          z.string().describe('Run ID to explain, e.g. "run-2026-07-20-235500". Use tournament://runs to list available run IDs.'),
          runIdCompleter,
        ),
      },
    },
    async ({ runId }) => {
      const run = readRun(ctx, runId);
      const report = buildReport(run);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri: `tournament://runs/${run.runId}/report`,
                mimeType: 'text/markdown',
                text: report,
              },
            },
          },
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                'Explain the run above in plain English for someone with no technical ' +
                'background: who won and why, what the score actually measures, and whether ' +
                'the judges agreed or disagreed. Skip jargon; if a term like "confidence" or ' +
                '"synthesis" comes up, translate it into what it means for the reader\'s ' +
                'decision. If the report notes the run was interrupted or has no leaderboard, ' +
                'say so plainly and suggest re-running it.',
            },
          },
        ],
      };
    },
  );
}
