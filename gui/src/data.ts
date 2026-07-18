import type { JudgeScore, LeaderboardEntry, RunIndex, RunManifest, Synthesis, Turn } from './types';

const root = 'data';
export const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${root}/${path}`);
  if (!response.ok) throw new Error(`Data file unavailable (${response.status})`);
  return response.json() as Promise<T>;
}
export const loadIndex = () => getJson<RunIndex>('index.json');
export const loadRun = (runId: string) => getJson<RunManifest>(`${runId}/run.json`);
export const loadLeaderboard = (runId: string) => getJson<LeaderboardEntry[]>(`${runId}/leaderboard.json`);

function scenarioSlugs(id: string, name: string) {
  const number = /^\d+$/.test(id) ? id.padStart(2, '0') : '';
  // The pipeline names scenario directories by slugified scenario NAME;
  // legacy oracle imports used id-based patterns. Try every known layout.
  return [...new Set([slugify(name), slugify(id), slugify(`${id}-${name}`), number && slugify(`scenario-${number}-${name}`)].filter(Boolean))];
}
async function firstAvailable<T>(paths: string[]): Promise<T> {
  let error: unknown;
  for (const path of paths) {
    try {
      return await getJson<T>(path);
    } catch (cause) {
      // Remember the failure and fall through to the next slug candidate.
      error = cause;
    }
  }
  throw error;
}
export function loadTurns(runId: string, modelId: string, scenarioId: string, scenarioName: string) {
  return firstAvailable<Turn[]>(scenarioSlugs(scenarioId, scenarioName).map((scenario) => `${runId}/candidates/${slugify(modelId)}/${scenario}/turns.json`));
}
export function loadSynthesis(runId: string, modelId: string, scenarioId: string, scenarioName: string) {
  return firstAvailable<Synthesis>(scenarioSlugs(scenarioId, scenarioName).map((scenario) => `${runId}/judges/${slugify(modelId)}/${scenario}/synthesis.json`));
}
export function loadJudges(runId: string, modelId: string, scenarioId: string, scenarioName: string, roles: string[]) {
  return Promise.all(roles.map(async (role) => ({ role, score: await firstAvailable<JudgeScore>(scenarioSlugs(scenarioId, scenarioName).map((scenario) => `${runId}/judges/${slugify(modelId)}/${scenario}/${role}.json`)) })));
}