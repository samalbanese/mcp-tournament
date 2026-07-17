import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MCP-safe logger', () => {
  let logger: typeof import('../../src/utils/logger.js');
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    vi.resetModules();
    logger = await import('../../src/utils/logger.js');
  });

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => vi.restoreAllMocks());

  for (const name of ['log', 'logError', 'logWarn', 'logInfo', 'logDebug'] as const) {
    it(`${name} writes only to stderr`, () => {
      logger[name]('protocol safety');
      expect(errorSpy).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  }
});
