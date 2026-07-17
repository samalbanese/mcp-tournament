import { Command } from 'commander';
import { serve } from './index.js';
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

program.command('run')
  .description('Run a tournament evaluation')
  .requiredOption('--models <models>', 'Comma-separated OpenRouter model IDs')
  .option('--plugin <plugin>', 'Plugin name', 'dnd')
  .option('--scenario <id>', 'Run one scenario ID')
  .option('--judges <count>', 'Number of judges', value => Number.parseInt(value, 10), 3)
  .option('--out <directory>', 'Root directory for result runs')
  .action(async options => {
    const run = await evaluateTournament({
      models: String(options.models).split(',').map(model => model.trim()).filter(Boolean),
      plugin: options.plugin,
      scenarios: options.scenario ? [options.scenario] : undefined,
      judges: options.judges,
      outputRoot: options.out,
    });
    console.log(formatLeaderboard(run.leaderboard));
    console.log(`\nResults: ${run.runDir}`);
  });

program.command('leaderboard')
  .description('Show cached leaderboard results')
  .option('--plugin <plugin>', 'Filter by plugin')
  .option('--limit <count>', 'Maximum rows', value => Number.parseInt(value, 10), 10)
  .option('--out <directory>', 'Root directory containing result runs')
  .action(options => {
    console.log(formatLeaderboard(readLeaderboard({
      plugin: options.plugin,
      limit: options.limit,
      outputRoot: options.out,
    })));
  });

program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
