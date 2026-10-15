import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { IPC_EVENT_CHANNEL, PUFF_INVOKE_METHODS, ipcChannel, type PuffApi } from '@puff/shared';
import { createBackend } from './backend';

const here = dirname(fileURLToPath(import.meta.url));
let backend: PuffApi;

function registerIpc(api: PuffApi): void {
  for (const method of PUFF_INVOKE_METHODS) {
    const fn = api[method] as (...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(ipcChannel(method), (_event, ...args: unknown[]) => fn.apply(api, args));
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Puff',
    backgroundColor: '#070a12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts need the sandbox off; the renderer still has no Node access.
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const unsubscribe = backend.onEvent((event) => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT_CHANNEL, event);
  });
  win.on('closed', unsubscribe);

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, '../renderer/index.html'));
  return win;
}

// One Puff at a time: two would run the same team on the same projects.
if (!app.requestSingleInstanceLock()) app.quit();
else
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return;
  backend = await createBackend(here, {
    // The installed app has no checkout; what ships with it is next to the app files.
    resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
    // The system "choose a folder" dialog, over whichever window the person is using.
    pickDirectory: async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? undefined;
      const options = { title: 'Choose a project folder', properties: ['openDirectory' as const] };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  registerIpc(backend);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
