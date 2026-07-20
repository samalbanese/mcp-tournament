import type { JudgeScore, LeaderboardEntry, RunIndex, RunManifest, Synthesis, Turn } from './types';

const root = 'data';
export const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export function shortSlug(value: string, max = 24) {
  const slug = slugify(value);
  if (slug.length <= max) return slug;
  // Hash-suffixed truncation — must stay identical to src/utils/slug.ts.
  let hash = 5381;
  for (let i = 0; i < slug.length; i++) hash = ((hash * 33) ^ slug.charCodeAt(i)) >>> 0;
  const suffix = hash.toString(36).slice(0, 4).padStart(4, '0');
  const prefix = slug.slice(0, max - 5);
  const boundary = prefix.lastIndexOf('_');
  const base = (boundary > 0 ? prefix.slice(0, boundary) : prefix).replace(/_+$/, '');
  return `${base}_${suffix}`;
}
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
  const legacy = [slugify(name), slugify(id), slugify(`${id}-${name}`), number && slugify(`scenario-${number}-${name}`)].filter(Boolean);
  return [...new Set([...legacy.map((slug) => shortSlug(slug)), ...legacy])];
}
function modelSlugs(id: string) {
  return [...new Set([shortSlug(id), slugify(id)])];
}
function artifactPaths(runId: string, area: 'candidates' | 'judges', modelId: string, scenarioId: string, scenarioName: string, filename: string) {
  return modelSlugs(modelId).flatMap((model) => scenarioSlugs(scenarioId, scenarioName)
    .map((scenario) => `${runId}/${area}/${model}/${scenario}/${filename}`));
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
  return firstAvailable<Turn[]>(artifactPaths(runId, 'candidates', modelId, scenarioId, scenarioName, 'turns.json'));
}
export function loadSynthesis(runId: string, modelId: string, scenarioId: string, scenarioName: string) {
  return firstAvailable<Synthesis>(artifactPaths(runId, 'judges', modelId, scenarioId, scenarioName, 'synthesis.json'));
}
export function loadJudges(runId: string, modelId: string, scenarioId: string, scenarioName: string, roles: string[]) {
  return Promise.all(roles.map(async (role) => {
    try {
      return { role, score: await firstAvailable<JudgeScore>(artifactPaths(runId, 'judges', modelId, scenarioId, scenarioName, `${role}.json`)) };
    } catch {
      // Imported runs can omit an individual judge record. Keep the rest of
      // the panel usable instead of failing the entire model view.
      return null;
    }
  })).then((records) => records.filter((record): record is { role: string; score: JudgeScore } => record !== null));
}
