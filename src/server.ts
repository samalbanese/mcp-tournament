import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { evaluateTournament, type TournamentRun } from './pipeline.js';
import { listPlugins } from './plugins/index.js';
import { logDebug, logError, logInfo, onLog } from './utils/logger.js';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 64 * 1024;
const MODEL_CACHE_MS = 10 * 60 * 1000;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

type RunStatus = 'running' | 'done' | 'error';
interface ActiveRun {
  runId: string;
  status: RunStatus;
  logTail: string[];
  leaderboard?: TournamentRun['leaderboard'];
  error?: string;
}
interface ModelSummary {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
}
export interface HandlerOptions {
  rootDir?: string;
  port: number;
  version?: string;
  fetch?: typeof fetch;
  evaluate?: typeof evaluateTournament;
}

const runs = new Map<string, ActiveRun>();
let activeApiKey: string | null = null;
let modelCache: { expiresAt: number; models: ModelSummary[] } | null = null;

const runRequestSchema = z.object({
  apiKey: z.string().min(1),
  plugin: z.string().min(1),
  models: z.array(z.string().min(1)).min(1).max(4),
  scenarioId: z.string().min(1).optional(),
  judges: z.number().int().min(1).max(5).optional(),
}).strict();

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': CONTENT_TYPES['.json'] });
  response.end(JSON.stringify(body));
}

function safePath(base: string, relative: string): string | null {
  const resolved = path.resolve(base, relative);
  const prefix = `${path.resolve(base)}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : null;
}

function readSeedRuns(guiDataDir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(guiDataDir, 'index.json'), 'utf8')) as { runs?: unknown };
    return Array.isArray(parsed.runs) ? parsed.runs.filter((run): run is string => typeof run === 'string') : [];
  } catch {
    return [];
  }
}

function readResultRuns(resultsDir: string): string[] {
  try {
    return fs.readdirSync(resultsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('run-') && fs.existsSync(path.join(resultsDir, entry.name, 'run.json')))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

export function mergeRunIndex(resultsDir: string, guiDataDir: string): { runs: string[] } {
  return { runs: [...new Set([...readResultRuns(resultsDir), ...readSeedRuns(guiDataDir)])] };
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  // Plain http is correct here: these are loopback-only origins for a local
  // server that never leaves the machine — there is no TLS on 127.0.0.1.
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]).has(origin);
}

function serveFile(response: ServerResponse, file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function allocateRunId(resultsDir: string, date = new Date()): string {
  let offset = 0;
  while (true) {
    const stamp = new Date(date.getTime() + offset * 1000).toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
    const runId = `run-${stamp}`;
    if (!fs.existsSync(path.join(resultsDir, runId)) && !runs.has(runId)) return runId;
    offset += 1;
  }
}

function scrub(message: string, apiKey: string): string {
  return apiKey ? message.replaceAll(apiKey, '[redacted]') : message;
}

async function getModels(fetcher: typeof fetch): Promise<ModelSummary[]> {
  if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.models;
  const response = await fetcher('https://openrouter.ai/api/v1/models');
  if (!response.ok) throw new Error(`OpenRouter models request failed (${response.status})`);
  const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> };
  if (!Array.isArray(body.data)) throw new Error('OpenRouter returned an invalid models response');
  const models = body.data
    .filter((model): model is typeof model & { id: string } => typeof model.id === 'string')
    .map(model => ({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      contextLength: Number(model.context_length) || 0,
      promptPrice: Number(model.pricing?.prompt) * 1e6 || 0,
      completionPrice: Number(model.pricing?.completion) * 1e6 || 0,
    }))
    // OpenRouter marks meta-entries like the Auto Router with -1 pricing;
    // they aren't real candidates and render as absurd negative prices.
    .filter(model => model.promptPrice >= 0 && model.completionPrice >= 0);
  modelCache = { expiresAt: Date.now() + MODEL_CACHE_MS, models };
  return models;
}

function runInBackground(input: z.infer<typeof runRequestSchema>, runId: string, resultsDir: string, evaluate: typeof evaluateTournament): void {
  const state: ActiveRun = { runId, status: 'running', logTail: [] };
  runs.set(runId, state);
  activeApiKey = input.apiKey;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = input.apiKey;
  const unsubscribe = onLog(line => {
    state.logTail.push(scrub(line, input.apiKey));
    if (state.logTail.length > 50) state.logTail.splice(0, state.logTail.length - 50);
  });
  logInfo(`Starting local GUI run ${runId}`);
  void evaluate({
    models: input.models,
    plugin: input.plugin,
    scenarios: input.scenarioId ? [input.scenarioId] : undefined,
    judges: input.judges,
    outputRoot: resultsDir,
    runId,
  }).then(run => {
    state.status = 'done';
    state.leaderboard = JSON.parse(fs.readFileSync(path.join(run.runDir, 'leaderboard.json'), 'utf8')) as TournamentRun['leaderboard'];
    logInfo(`Completed local GUI run ${runId}`);
  }).catch((error: unknown) => {
    state.status = 'error';
    state.error = scrub(error instanceof Error ? error.message : String(error), input.apiKey);
    logError(`Local GUI run ${runId} failed: ${state.error}`);
  }).finally(() => {
    unsubscribe();
    activeApiKey = null;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
}

export function createRequestHandler(options: HandlerOptions): http.RequestListener {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const guiDir = path.join(rootDir, 'gui', 'dist');
  const guiDataDir = path.join(guiDir, 'data');
  const resultsDir = path.join(rootDir, 'results');
  const fetcher = options.fetch ?? fetch;
  const evaluate = options.evaluate ?? evaluateTournament;
  const version = options.version ?? (() => {
    try { return (JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'; }
    catch { return 'unknown'; }
  })();

  return async (request, response) => {
    try {
      if (!isAllowedOrigin(request.headers.origin, options.port)) {
        sendJson(response, 403, { error: 'origin not allowed' });
        return;
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, { ok: true, version });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/models') {
        try { sendJson(response, 200, await getModels(fetcher)); }
        catch (error) { sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/plugins') {
        sendJson(response, 200, listPlugins().map(plugin => ({
          name: plugin.name,
          description: plugin.description,
          scenarios: plugin.scenarios.map(scenario => ({ id: scenario.id, name: scenario.name })),
        })));
        return;
      }
      if (request.method === 'POST' && pathname === '/api/runs') {
        const parsed = runRequestSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendJson(response, 400, { error: 'invalid run request', details: parsed.error.flatten() });
          return;
        }
        if (activeApiKey !== null) {
          sendJson(response, 409, { error: 'a run is already in progress' });
          return;
        }
        const runId = allocateRunId(resultsDir);
        runInBackground(parsed.data, runId, resultsDir, evaluate);
        sendJson(response, 202, { runId });
        return;
      }
      const runMatch = request.method === 'GET' ? pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)$/) : null;
      if (runMatch) {
        const state = runs.get(runMatch[1]);
        if (!state) sendJson(response, 404, { error: 'run not found' });
        else sendJson(response, 200, state);
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }

      if (pathname === '/data') {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      if (request.method === 'GET' && pathname === '/data/index.json') {
        sendJson(response, 200, mergeRunIndex(resultsDir, guiDataDir));
        return;
      }
      if (request.method === 'GET' && pathname.startsWith('/data/')) {
        const relative = pathname.slice('/data/'.length);
        const resultFile = safePath(resultsDir, relative);
        const seedFile = safePath(guiDataDir, relative);
        if ((resultFile && serveFile(response, resultFile)) || (seedFile && serveFile(response, seedFile))) return;
        sendJson(response, 404, { error: 'data file not found' });
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      const staticRelative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const staticFile = safePath(guiDir, staticRelative);
      if (staticFile && serveFile(response, staticFile)) return;
      if (!serveFile(response, path.join(guiDir, 'index.html'))) sendJson(response, 404, { error: 'GUI build not found' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : 'internal server error' });
    }
  };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function startServer(options: { port?: number; rootDir?: string } = {}): Promise<{ server: http.Server; url: string }> {
  const port = options.port ?? 4600;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535');
  const handler = createRequestHandler({ port, rootDir: options.rootDir });
  const server = http.createServer(handler);
  await listen(server, port, '127.0.0.1');
  // Browsers on Windows often resolve localhost to ::1 first; listen on both
  // loopbacks so neither address family gets connection-refused. IPv6 loopback
  // is best-effort — some machines have IPv6 disabled entirely.
  try {
    await listen(http.createServer(handler), port, '::1');
  } catch (error) {
    logDebug(`IPv6 loopback bind skipped (IPv4-only host?): ${error instanceof Error ? error.message : String(error)}`);
  }
  return { server, url: `http://localhost:${port}` };
}