type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const CURRENT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const CURRENT_LEVEL_NUM = LOG_LEVELS[CURRENT_LEVEL] ?? LOG_LEVELS.info;

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] <= CURRENT_LEVEL_NUM;
}

function formatMsg(level: LogLevel, msg: string): string {
  const tag = level.toUpperCase().padEnd(5);
  return `[${new Date().toISOString().slice(11, 19)}] ${tag} ${msg}`;
}

export function log(msg: string): void {
  console.log(formatMsg('info', msg));
}

export function logError(msg: string): void {
  if (shouldLog('error')) console.error(formatMsg('error', msg));
}

export function logWarn(msg: string): void {
  if (shouldLog('warn')) console.warn(formatMsg('warn', msg));
}

export function logInfo(msg: string): void {
  if (shouldLog('info')) console.log(formatMsg('info', msg));
}

export function logDebug(msg: string): void {
  if (shouldLog('debug')) console.log(formatMsg('debug', msg));
}
