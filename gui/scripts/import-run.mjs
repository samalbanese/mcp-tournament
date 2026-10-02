import { importRun } from './run-import-lib.mjs';

const args = process.argv.slice(2);
const fromOracle = args.includes('--from-oracle');
const input = args.find((arg) => !arg.startsWith('--'));
if (!input) { console.error('Usage: node scripts/import-run.mjs <runId|source-directory> [--from-oracle]'); process.exit(1); }

await importRun(input, { fromOracle });
