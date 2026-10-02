#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseStudy, runStudy, reanalyzeStudy } from './study/index.js';
import { defaultResultsRoot } from './pipeline.js';

/**
 * CLI results are user-facing program output, so they belong on stdout —
 * unlike the MCP server path, where stdout is reserved for JSON-RPC and all
 * logging goes to stderr (see src/utils/logger.ts).
 */
function print(text: string): void {
  process.stdout.write(`${text}\n`);
}
import { serve } from './index.js';
import { startServer } from './server.js';
import { loadDiscoveredBenches } from './plugins/custom.js';
import {
  evaluateTournament,
  formatLeaderboard,
  readLeaderboard,
} from './pipeline.js';

const program = new Command()
  .name('mcp-tournament')
  .description('Plugin-based LLM evaluation through OpenRouter')
  .version('0.1.0');

program.command('serve')
  .description('Start the MCP stdio server')
  .action(async () => serve());

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Opening a browser is a convenience; the printed URL is always usable.
  }
}

program.command('gui')
  .description('Start the local tournament GUI')
  .option('--port <n>', 'Local HTTP port', value => Number.parseInt(value, 10), 4600)
  .action(async options => {
    const { url } = await startServer({ port: options.port });
    print(url);
    openBrowser(url);
  });
program.command('run')
  .description('Run a tournament evaluation')
  .requiredOption('--models <models>', 'Comma-separated OpenRouter model IDs')
  .option('--plugin <plugin>', 'Plugin name', 'dnd')
  .option('--scenario <id>', 'Run one scenario ID')
  .option('--judges <count>', 'Number of judges', value => Number.parseInt(value, 10), 3)
  .option('--out <directory>', 'Root directory for result runs')
  .action(async options => {
    loadDiscoveredBenches();
    const run = await evaluateTournament({
      models: String(options.models).split(',').map(model => model.trim()).filter(Boolean),
      plugin: options.plugin,
      scenarios: options.scenario ? [options.scenario] : undefined,
      judges: options.judges,
      outputRoot: options.out,
    });
    print(formatLeaderboard(run.leaderboard));
    print(`\nResults: ${run.runDir}`);
  });

program.command('leaderboard')
  .description('Show cached leaderboard results')
  .option('--plugin <plugin>', 'Filter by plugin')
  .option('--limit <count>', 'Maximum rows', value => Number.parseInt(value, 10), 10)
  .option('--out <directory>', 'Root directory containing result runs')
  .action(options => {
    loadDiscoveredBenches();
    print(formatLeaderboard(readLeaderboard({
      plugin: options.plugin,
      limit: options.limit,
      outputRoot: options.out,
    })));
  });

program.command('study <file>')
  .description('Run or resume a model study')
  .option('--yes', 'Accept the cost estimate without prompting')
  .option('--out <directory>', 'Root directory for result runs')
  .action(async (file: string, options) => {
    loadDiscoveredBenches();
    const studyFile = path.resolve(file);
    const study = parseStudy(JSON.parse(fs.readFileSync(studyFile, 'utf8')));
    const result = await runStudy(study, {
      resultsRoot: options.out, studyFile,
      confirm: async summary => {
        process.stderr.write(`${summary}\n`);
        if (options.yes) return true;
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return /^y(?:es)?$/i.test((await prompt.question('Run this study? [y/N] ')).trim());
        } catch {
          return false;
        } finally {
          prompt.close();
        }
      },
      onProgress: progress => process.stderr.write(`[${progress.batch}/${progress.batches}] ${progress.message}\n`),
    });
    if (result.cancelled) process.stderr.write('Study cancelled.\n');
    else print(result.studyDir);
  });

program.command('study-analyze <id>')
  .description('Reanalyze saved study scores without model calls')
  .option('--out <directory>', 'Root directory containing result runs')
  .action(async (id: string, options) => {
    await reanalyzeStudy(id, options.out);
    print(path.resolve(options.out ?? defaultResultsRoot(), 'studies', id));
  });

program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
