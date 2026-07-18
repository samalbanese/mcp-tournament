import type { LeaderboardEntry } from './types';

export interface Health { ok: true; version: string }
export interface ApiModel { id: string; name: string; contextLength: number; promptPrice: number; completionPrice: number }
export interface ApiScenario { id: string; name: string }
export interface ApiPlugin { name: string; description: string; scenarios: ApiScenario[] }
export interface RunRequest { apiKey: string; plugin: string; models: string[]; scenarioId?: string; judges: number }
export interface RunProgress { runId: string; status: 'running' | 'done' | 'error'; logTail: string[]; leaderboard?: LeaderboardEntry[]; error?: string }
export interface BenchCriterion { name: string; description: string }
export interface BenchDefinition {
  name: string;
  description: string;
  scenarios: Array<{
    id: string;
    name: string;
    description: string;
    prompt: string;
    rounds: number;
    participantPersona?: string;
    criteria: BenchCriterion[];
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Local server request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function detectAppMode(): Promise<Health | null> {
  try {
    const health = await request<Health>('/api/health');
    return health.ok === true ? health : null;
  } catch {
    return null;
  }
}
export const loadModels = () => request<ApiModel[]>('/api/models');
export const loadPlugins = () => request<ApiPlugin[]>('/api/plugins');
export const saveBench = (body: BenchDefinition) => request<{ name: string }>('/api/benches', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export const suggestCriteria = (apiKey: string, question: string) => request<{ criteria: BenchCriterion[] }>('/api/suggest-criteria', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey, question }),
});
export const loadRunProgress = (runId: string) => request<RunProgress>(`/api/runs/${encodeURIComponent(runId)}`);
export const startRun = (body: RunRequest) => request<{ runId: string }>('/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
