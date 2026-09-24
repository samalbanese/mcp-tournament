import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp/server.js';
import { logError, logInfo } from './utils/logger.js';
import { loadDiscoveredBenches } from './plugins/custom.js';

export { createServer } from './mcp/server.js';

export async function serve(): Promise<void> {
  loadDiscoveredBenches();
  await createServer().connect(new StdioServerTransport());
  logInfo('MCP Tournament server running on stdio');
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isMain) {
  serve().catch(error => {
    logError(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
