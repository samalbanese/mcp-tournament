// CommonJS keeps the Electron entry point and sandboxed preload path predictable;
// the packaged application code loaded below remains the existing ESM build.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} = require('electron');

const GET_API_KEY_CHANNEL = 'tournament-secure:get-api-key';
const SET_API_KEY_CHANNEL = 'tournament-secure:set-api-key';
const API_KEY_FILENAME = 'openrouter-api-key.bin';
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

let mainWindow = null;
let localServer = null;
let localOrigin = null;
let memoryApiKey = null;
let keyMutation = Promise.resolve();
let shutdownPromise = null;
let readyToQuit = false;

function getCoreRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-core')
    : path.resolve(__dirname, '..');
}

async function getServerRoot(coreRoot) {
  if (!app.isPackaged) return coreRoot;
  const serverRoot = path.join(app.getPath('userData'), 'app-data');
  await fs.mkdir(serverRoot, { recursive: true });
  await fs.cp(path.join(coreRoot, 'gui'), path.join(serverRoot, 'gui'), { recursive: true, force: true });
  await fs.cp(path.join(coreRoot, 'benches'), path.join(serverRoot, 'benches'), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await fs.copyFile(path.join(coreRoot, 'package.json'), path.join(serverRoot, 'package.json'));
  return serverRoot;
}

function getApiKeyPath() {
  return path.join(app.getPath('userData'), API_KEY_FILENAME);
}

function isTrustedSender(event) {
  if (!localOrigin) return false;
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  try {
    return new URL(senderUrl).origin === localOrigin;
  } catch {
    return false;
  }
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error('Secure storage is only available to the local MCP Tournament app');
}

function registerSecureStorageIpc() {
  ipcMain.handle(GET_API_KEY_CHANNEL, async (event) => {
    requireTrustedSender(event);
    await keyMutation;
    if (!safeStorage.isEncryptionAvailable()) return memoryApiKey;
    if (memoryApiKey !== null) return memoryApiKey;
    try {
      const encrypted = await fs.readFile(getApiKeyPath());
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if (error && error.code !== 'ENOENT') console.warn('Could not decrypt the stored OpenRouter API key:', error.message);
      return null;
    }
  });

  ipcMain.handle(SET_API_KEY_CHANNEL, async (event, key) => {
    requireTrustedSender(event);
    if (key !== null && typeof key !== 'string') throw new TypeError('API key must be a string or null');
    const mutation = keyMutation.then(async () => {
      if (key === null) {
        memoryApiKey = null;
        await fs.rm(getApiKeyPath(), { force: true });
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        await fs.rm(getApiKeyPath(), { force: true });
        memoryApiKey = key;
        return;
      }
      memoryApiKey = null;
      const encrypted = safeStorage.encryptString(key);
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(getApiKeyPath(), encrypted, { mode: 0o600 });
    });
    keyMutation = mutation.catch(() => undefined);
    return mutation;
  });
}

function parseExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function openInSystemBrowser(rawUrl) {
  const url = parseExternalUrl(rawUrl);
  if (url) void shell.openExternal(url.href);
}

function configureNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url);
    return { action: 'deny' };
  });

  const guardNavigation = (event, url) => {
    try {
      if (new URL(url).origin === localOrigin) return;
    } catch {
      // Invalid and non-web URLs must not replace the app content.
    }
    event.preventDefault();
    openInSystemBrowser(url);
  };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
}

async function startLocalServer() {
  const coreRoot = getCoreRoot();
  const serverRoot = await getServerRoot(coreRoot);
  const serverModuleUrl = pathToFileURL(path.join(coreRoot, 'dist', 'server.js')).href;
  const { startServer } = await import(serverModuleUrl);
  const started = await startServer({
    port: 0,
    rootDir: serverRoot,
    listenIPv6: false,
  });
  localServer = started.server;
  const address = localServer.address();
  if (!address || typeof address === 'string') throw new Error('The local server did not expose a TCP port');
  return `http://127.0.0.1:${address.port}/`;
}

async function createMainWindow() {
  const serverUrl = await startLocalServer();
  localOrigin = new URL(serverUrl).origin;
  registerSecureStorageIpc();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  configureNavigation(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(serverUrl);
}

function stopLocalServer() {
  const server = localServer;
  localServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function beginShutdown() {
  if (!shutdownPromise) {
    shutdownPromise = stopLocalServer().finally(() => {
      readyToQuit = true;
      app.quit();
    });
  }
  return shutdownPromise;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => { void beginShutdown(); });
  app.on('before-quit', (event) => {
    if (readyToQuit) return;
    event.preventDefault();
    void beginShutdown();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.samalbanese.mcptournament');
    await createMainWindow();
  }).catch(async (error) => {
    dialog.showErrorBox('MCP Tournament could not start', error instanceof Error ? error.message : String(error));
    await beginShutdown();
  });
}
