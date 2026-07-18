import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(guiDir, '..');
const dataDir = path.join(guiDir, 'public', 'data');
const args = process.argv.slice(2);
const fromOracle = args.includes('--from-oracle');
const input = args.find((arg) => !arg.startsWith('--'));
if (!input) { console.error('Usage: node scripts/import-run.mjs <runId|source-directory> [--from-oracle]'); process.exit(1); }

const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); };

async function updateIndex(runId) {
  await mkdir(dataDir, { recursive: true });
  const indexFile = path.join(dataDir, 'index.json');
  let runs = [];
  try { runs = (await readJson(indexFile)).runs ?? []; } catch { /* first import */ }
  await writeJson(indexFile, { runs: [runId, ...runs.filter((id) => id !== runId)] });
}

function unwrapJudge(legacy) {
  if (legacy.parsed) return legacy.parsed;
  let raw = String(legacy.raw ?? '').replace(/^```json\s*|\s*```$/g, '');
  try { return JSON.parse(raw); } catch {
    raw = raw.split('\n').map((line) => line.replace(/^(\s*)\\"/, '$1"').replace(/\\"(,?)\s*$/, '"$1')).join('\n');
    return JSON.parse(raw);
  }
}

async function importOracle(source) {
  const config = await readJson(path.join(source, 'config.json'));
  const legacyLeaderboard = await readJson(path.join(source, 'leaderboard.json'));
  const iso = new Date(config.timestamp).toISOString();
  const runId = `run-${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(':', '')}`;
  const target = path.join(dataDir, runId);
  await rm(target, { recursive: true, force: true });
  const leaderboard = legacyLeaderboard.map((entry) => ({
    modelId: entry.modelId, modelName: entry.modelName, tier: entry.tier,
    overallAverage: Number(entry.overallAverage.toFixed(2)),
    scenarioScores: entry.scenarioScores.map((scenario) => ({
      scenarioId: String(scenario.scenarioId), scenarioName: scenario.scenarioName,
      average: Number(scenario.average.toFixed(2)), scores: scenario.scores,
      ruleErrors: scenario.ruleErrors, flags: scenario.flags ?? [],
    })),
  }));
  const judgeRoot = path.join(source, 'judges');
  const judges = new Map();
  for (const modelDir of (await readdir(judgeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    for (const scenarioDir of (await readdir(path.join(judgeRoot, modelDir.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const sourceScenario = path.join(judgeRoot, modelDir.name, scenarioDir.name);
      const match = legacyLeaderboard.find((entry) => slugify(entry.modelId) === slugify(modelDir.name));
      const modelSlug = slugify(match?.modelId ?? modelDir.name);
      const scenarioSlug = slugify(scenarioDir.name);
      for (const file of await readdir(sourceScenario)) {
        const legacy = await readJson(path.join(sourceScenario, file));
        if (file === 'synthesis.json') { await writeJson(path.join(target, 'judges', modelSlug, scenarioSlug, 'synthesis.json'), legacy.synthesis ?? legacy); continue; }
        if (!file.endsWith('-judge.json')) continue;
        judges.set(legacy.judgeRole, { role: legacy.judgeRole, name: legacy.judgeName, model: legacy.judgeModel });
        const score = unwrapJudge(legacy);
        await writeJson(path.join(target, 'judges', modelSlug, scenarioSlug, `${legacy.judgeRole}.json`), {
          scores: score.scores, rule_errors: score.rule_errors, tool_errors: score.tool_errors,
          flags: score.flags, overall_impression: score.overall_impression,
        });
      }
    }
  }
  const candidateRoot = path.join(source, 'candidates');
  for (const modelDir of (await readdir(candidateRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    const match = legacyLeaderboard.find((entry) => slugify(entry.modelId) === slugify(modelDir.name));
    const modelSlug = slugify(match?.modelId ?? modelDir.name);
    for (const scenarioDir of (await readdir(path.join(candidateRoot, modelDir.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const sourceScenario = path.join(candidateRoot, modelDir.name, scenarioDir.name);
      const scenarioSlug = slugify(scenarioDir.name);
      const legacyTurns = await readJson(path.join(sourceScenario, 'turns.json'));
      const turns = legacyTurns.flatMap((turn, index) => [
        { turn: index * 2, role: 'participant', content: turn.playerMessage },
        { turn: index * 2 + 1, role: 'candidate', content: turn.dmResponse,
          toolCalls: (turn.toolCalls ?? []).map((call) => ({ name: call.name, arguments: call.input, result: call.result, valid: call.validation.valid })),
          metrics: { ttfbMs: turn.dmMetrics.ttfbMs, totalTimeMs: turn.dmMetrics.totalTimeMs, inputTokens: turn.dmMetrics.inputTokens, outputTokens: turn.dmMetrics.outputTokens } },
      ]);
      await writeJson(path.join(target, 'candidates', modelSlug, scenarioSlug, 'turns.json'), turns);
      const metrics = await readJson(path.join(sourceScenario, 'metrics.json'));
      await writeJson(path.join(target, 'candidates', modelSlug, scenarioSlug, 'metrics.json'), {
        candidateInputTokens: metrics.dmInputTokens, candidateOutputTokens: metrics.dmOutputTokens,
        participantInputTokens: metrics.playerInputTokens, participantOutputTokens: metrics.playerOutputTokens,
        totalTimeMs: metrics.totalTimeMs, toolCallCount: metrics.toolCallCount,
      });
    }
  }
  const scenarios = leaderboard[0]?.scenarioScores.map((scenario) => ({ id: scenario.scenarioId, name: scenario.scenarioName })) ?? [];
  await writeJson(path.join(target, 'run.json'), {
    runId, plugin: 'dnd', createdAt: iso,
    candidates: leaderboard.map((entry) => ({ id: entry.modelId, name: entry.modelName, tier: entry.tier })),
    judges: [...judges.values()], synthesizer: { model: config.models[0] }, scenarios,
  });
  await writeJson(path.join(target, 'leaderboard.json'), leaderboard);
  await updateIndex(runId);
  return runId;
}

async function importContractRun(source) {
  const manifest = await readJson(path.join(source, 'run.json'));
  const target = path.join(dataDir, manifest.runId);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await updateIndex(manifest.runId);
  return manifest.runId;
}

const looksLikePath = input.includes('/') || input.includes('\\') || input.startsWith('.');
const source = path.resolve(process.cwd(), looksLikePath ? input : path.join(repoDir, 'results', input));
const runId = fromOracle ? await importOracle(source) : await importContractRun(source);
console.log(`Imported ${runId} into ${path.relative(repoDir, path.join(dataDir, runId))}`);