type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const CURRENT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const CURRENT_LEVEL_NUM = LOG_LEVELS[CURRENT_LEVEL] ?? LOG_LEVELS.info;
const listeners = new Set<(line: string) => void>();

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] <= CURRENT_LEVEL_NUM;
}

function formatMsg(level: LogLevel, msg: string): string {
  const tag = level.toUpperCase().padEnd(5);
  return `[${new Date().toISOString().slice(11, 19)}] ${tag} ${msg}`;
}

function writeLine(level: LogLevel, msg: string): void {
  const line = formatMsg(level, msg);
  console.error(line);
  for (const listener of listeners) {
    try {
      listener(line);
    } catch {
      // Logging must never fail because an optional observer failed.
    }
  }
}

export function onLog(listener: (line: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// NOTE: all levels write to stderr — this server speaks JSON-RPC on stdout (MCP
// stdio transport), so any stdout write would corrupt the protocol stream.
export function log(msg: string): void {
  writeLine('info', msg);
}

export function logError(msg: string): void {
  if (shouldLog('error')) writeLine('error', msg);
}

export function logWarn(msg: string): void {
  if (shouldLog('warn')) writeLine('warn', msg);
}

export function logInfo(msg: string): void {
  if (shouldLog('info')) writeLine('info', msg);
}

export function logDebug(msg: string): void {
  if (shouldLog('debug')) writeLine('debug', msg);
}
