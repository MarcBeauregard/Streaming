// Desktop shell: starts the FeedSwitch server inside the app on a private
// port and shows it in its own window.

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

let server = null;
let win = null;

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'Affichage',
        submenu: [
          { role: 'reload', label: 'Recharger l’interface' },
          { role: 'togglefullscreen', label: 'Plein écran' },
          { type: 'separator' },
          { role: 'resetZoom', label: 'Taille réelle' },
          { role: 'zoomIn', label: 'Agrandir' },
          { role: 'zoomOut', label: 'Réduire' },
          { type: 'separator' },
          { role: 'toggleDevTools', label: 'Outils de développement' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 400,
    minHeight: 520,
    title: 'FeedSwitch',
    backgroundColor: '#0b0d10',
    icon: join(HERE, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A feed should start with sound as soon as it is chosen.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // The window only ever shows the app itself; anything else opens in the
  // user's browser, or not at all.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(server.url + '/')) event.preventDefault();
  });

  await win.loadURL(server.url + '/');
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  await app.whenReady();
  buildMenu();

  try {
    // The page list lives in the user's profile, not in the app folder.
    process.env.DATA_FILE = join(app.getPath('userData'), 'sources.json');
    const { startServer } = await import('../src/server.js');
    server = await startServer({ port: 0, host: '127.0.0.1' });
    await createWindow();
  } catch (err) {
    dialog.showErrorBox('FeedSwitch ne peut pas démarrer', String(err?.message || err));
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (!win) void createWindow();
  });
}

app.on('window-all-closed', () => app.quit());

// Stop the server and the background Chrome before leaving.
let closing = false;
app.on('will-quit', (event) => {
  if (closing || !server) return;
  closing = true;
  event.preventDefault();
  const done = () => app.exit(0);
  server.close().then(done, done);
  setTimeout(done, 3000);
});

void main();
