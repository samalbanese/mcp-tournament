// Real-API check for per-seat reasoning levels. Costs a few cents.
// Build first (npm run build), then: node scripts/smoke-reasoning.mjs
// Needs OPENROUTER_API_KEY; the Claude tool-use check also needs ANTHROPIC_API_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateTournament } from '../dist/pipeline.js';

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-reasoning-'));

function candidateTurns(runDir) {
  const root = path.join(runDir, 'candidates');
  return fs.readdirSync(root).map(model => {
    const [scenario] = fs.readdirSync(path.join(root, model));
    const turns = JSON.parse(fs.readFileSync(path.join(root, model, scenario, 'turns.json'), 'utf8'))
      .filter(turn => turn.role === 'candidate');
    return {
      folder: model,
      turns: turns.length,
      outputTokens: turns.reduce((sum, turn) => sum + (turn.metrics?.outputTokens ?? 0), 0),
      toolCalls: turns.reduce((sum, turn) => sum + (turn.toolCalls?.length ?? 0), 0),
    };
  });
}

function report(run) {
  for (const entry of run.leaderboard) console.log(`  row: ${entry.modelName} (${entry.modelId}) ${entry.overallAverage}`);
  for (const row of candidateTurns(run.runDir)) {
    console.log(`  ${row.folder}: ${row.turns} turn(s), ${row.outputTokens} output tokens, ${row.toolCalls} tool call(s)`);
  }
  for (const failure of [...(run.failures ?? []), ...(run.judgeFailures ?? [])]) {
    console.log(`  FAILURE ${failure.model}/${failure.scenario}: ${failure.error}`);
  }
}

let failed = false;

console.log('1. OpenRouter: one model at low and at high');
try {
  const run = await evaluateTournament({
    models: ['google/gemini-3.1-flash-lite@low', 'google/gemini-3.1-flash-lite@high'],
    plugin: 'dnd', scenarios: ['dnd-combat'], turns: 1, judges: 1, outputRoot,
  });
  report(run);
  if (run.leaderboard.length !== 2) { failed = true; console.log('  FAIL: expected two leaderboard rows'); }
} catch (error) {
  failed = true;
  console.log(`  FAIL: ${error.message}`);
}

console.log('2. Claude Haiku 4.5 at a level is refused before any call');
try {
  await evaluateTournament({
    models: ['anthropic:claude-haiku-4-5-20251001@low'], plugin: 'dnd', scenarios: ['dnd-combat'], turns: 1, judges: 1, outputRoot,
  });
  failed = true;
  console.log('  FAIL: the run was not refused');
} catch (error) {
  console.log(`  refused: ${error.message}`);
}

console.log('3. Claude Sonnet 5.5 at low through a tool-using D&D scenario');
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('  skipped: set ANTHROPIC_API_KEY');
} else {
  try {
    const run = await evaluateTournament({
      models: ['anthropic:claude-sonnet-5-5@low'], plugin: 'dnd', scenarios: ['dnd-combat'], turns: 2, judges: 1, outputRoot,
    });
    report(run);
    const [row] = candidateTurns(run.runDir);
    if (run.failures?.length || !row || row.toolCalls < 1) { failed = true; console.log('  FAIL: expected a completed run with a tool call'); }
  } catch (error) {
    failed = true;
    console.log(`  FAIL: ${error.message}`);
  }
}

if (failed) console.log(`Results kept for inspection: ${outputRoot}`);
else fs.rmSync(outputRoot, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
