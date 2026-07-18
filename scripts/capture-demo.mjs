import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const viewerDataDir = path.join(repoRoot, 'gui', 'public', 'data');
const framesDir = path.join(repoRoot, 'artifacts', 'demo-frames');
const healthPath = '/api/health';
const serverTimeoutMs = 30_000;

function fail(message) {
  throw new Error(message);
}

function readJson(file, description) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Could not read ${description} at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePort() {
  const args = process.argv.slice(2);
  let value = process.env.PORT ?? '4655';

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--port') {
      if (!args[index + 1]) fail('Usage: node scripts/capture-demo.mjs [--port <1-65535>]');
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--port=')) {
      value = argument.slice('--port='.length);
    } else {
      fail(`Unknown argument: ${argument}. Usage: node scripts/capture-demo.mjs [--port <1-65535>]`);
    }
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`Invalid port "${value}". Expected an integer between 1 and 65535.`);
  }
  return port;
}

function checkPreconditions() {
  const requiredFiles = [
    path.join(repoRoot, 'dist', 'cli.js'),
    path.join(repoRoot, 'gui', 'dist', 'index.html'),
  ];
  for (const file of requiredFiles) {
    if (!existsSync(file)) {
      fail(`Required build output is missing: ${file}. Build the app before capturing demo frames.`);
    }
  }
}

function selectDemoData() {
  const indexFile = path.join(viewerDataDir, 'index.json');
  const runIndex = readJson(indexFile, 'the committed viewer run index');
  if (!Array.isArray(runIndex.runs) || runIndex.runs.length === 0) {
    fail(`No committed viewer runs were found in ${indexFile}.`);
  }

  const runs = runIndex.runs.map((indexedRunId, indexPosition) => {
    const manifestFile = path.join(viewerDataDir, indexedRunId, 'run.json');
    const manifest = readJson(manifestFile, `run manifest for ${indexedRunId}`);
    if (typeof manifest.runId !== 'string' || manifest.runId.length === 0) {
      fail(`Run manifest ${manifestFile} does not contain a valid runId.`);
    }
    return { manifest, indexPosition };
  });

  const newestFirst = (left, right) => {
    const leftTime = Date.parse(left.manifest.createdAt ?? '');
    const rightTime = Date.parse(right.manifest.createdAt ?? '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.indexPosition - right.indexPosition;
  };
  const preferredRuns = runs.filter(({ manifest }) => manifest.plugin === 'business-strategy');
  const selected = [...(preferredRuns.length > 0 ? preferredRuns : runs)].sort(newestFirst)[0];
  const { manifest } = selected;

  const leaderboardFile = path.join(viewerDataDir, manifest.runId, 'leaderboard.json');
  const leaderboard = readJson(leaderboardFile, `leaderboard for ${manifest.runId}`);
  const topModel = Array.isArray(leaderboard) ? leaderboard[0] : undefined;
  if (!topModel || typeof topModel.modelId !== 'string' || topModel.modelId.length === 0) {
    fail(`Leaderboard ${leaderboardFile} does not contain a #1 model.`);
  }

  const firstScenario = Array.isArray(manifest.scenarios) ? manifest.scenarios[0] : undefined;
  if (!firstScenario || typeof firstScenario.id !== 'string' || firstScenario.id.length === 0) {
    fail(`Run manifest for ${manifest.runId} does not contain a first scenario.`);
  }

  return { runId: manifest.runId, modelId: topModel.modelId, scenarioId: firstScenario.id };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForServer(server, healthUrl) {
  const deadline = Date.now() + serverTimeoutMs;
  let lastError = 'the server did not respond';

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      fail(`GUI server exited before it became ready (exit code ${server.exitCode}).`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true) return;
        lastError = `health endpoint returned an unexpected response: ${JSON.stringify(body)}`;
      } else {
        lastError = `health endpoint returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(250);
  }

  fail(`GUI server was not ready at ${healthUrl} within 30 seconds (${lastError}).`);
}

function captureFrame(url, outputFile, label) {
  console.log(`Capturing ${label} -> ${path.relative(repoRoot, outputFile)}`);
  const result = spawnSync('npx', [
    'playwright@1.57',
    'screenshot',
    '--viewport-size=1440,900',
    '--wait-for-timeout=2200',
    url,
    outputFile,
  ], {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`Screenshot command failed for ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? 'unknown'}`;
    fail(`Screenshot command failed for ${label} (${detail}).`);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  if (await waitForExit(server, 2_000)) return;

  if (process.platform === 'win32' && server.pid) {
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${server.pid} -Force -ErrorAction SilentlyContinue`,
    ], { stdio: 'ignore' });
    await waitForExit(server, 2_000);
  }
}

async function main() {
  checkPreconditions();
  const port = parsePort();
  const demo = selectDemoData();
  const baseUrl = `http://127.0.0.1:${port}`;
  const encode = encodeURIComponent;
  const runRoute = `#/run/${encode(demo.runId)}`;
  const scenarioRoute = `${runRoute}/model/${encode(demo.modelId)}/scenario/${encode(demo.scenarioId)}`;
  const frames = [
    ['home leaderboard', runRoute, '01-home-leaderboard.png'],
    ['model scorecard', `${runRoute}/model/${encode(demo.modelId)}`, '02-model-scorecard.png'],
    ['judge matrix', `${scenarioRoute}/judges`, '03-judge-matrix.png'],
    ['transcript', `${scenarioRoute}/transcript`, '04-transcript.png'],
    ['build-bench form', '#/build', '05-build-bench-form.png'],
    ['new-run form', '#/new', '06-new-run-form.png'],
  ];

  mkdirSync(framesDir, { recursive: true });
  console.log(`Using run ${demo.runId}, model ${demo.modelId}, scenario ${demo.scenarioId}`);

  let server;
  try {
    server = spawn(process.execPath, [path.join(repoRoot, 'dist', 'cli.js'), 'gui', '--port', String(port)], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    await waitForServer(server, `${baseUrl}${healthPath}`);
    for (const [label, hashRoute, filename] of frames) {
      captureFrame(`${baseUrl}/${hashRoute}`, path.join(framesDir, filename), label);
    }
    console.log(`Captured ${frames.length} demo frames in ${framesDir}`);
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(`Demo capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
