'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const { validateIpcPayload } = require('./persistence/schema');
const { NoteStore } = require('./persistence/store');
const { NoteWindowManager } = require('./windows/restore-notes');
const { LinuxAutostartManager } = require('./platform/linux-autostart');
const {
  getRuntimeSessionDiagnostics,
  getDisplaysSummary,
  verifyX11WindowClient
} = require('./platform/display-diagnostics');

// Allow isolated userData directory for testing without touching real user configuration
if (process.env.SPOTNOTES_USER_DATA_DIR && path.isAbsolute(process.env.SPOTNOTES_USER_DATA_DIR)) {
  fs.mkdirSync(process.env.SPOTNOTES_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.SPOTNOTES_USER_DATA_DIR);
}

// Configure Chromium Ozone backend for X11/XWayland before app.whenReady()
// unless an explicit --ozone-platform=... flag was already supplied on the command line.
const hasExplicitOzoneFlag = process.argv.some(
  (arg) => typeof arg === 'string' && arg.startsWith('--ozone-platform=')
);
if (process.platform === 'linux' && !hasExplicitOzoneFlag && process.env.DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[SpotNotes] Another instance is already running. Focusing existing instance and exiting.');
  app.quit();
  process.exit(0);
}

let store = null;
let windowManager = null;
let autostartManager = null;
let tray = null;
let isQuitting = false;

function getIconPath() {
  const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(pngPath)) {
    return pngPath;
  }
  return null;
}

function getGlobalMetaState() {
  if (!store || !windowManager) {
    return {
      launchAtLogin: false,
      totalNotesCount: 0,
      openNotesCount: 0,
      closedNotesCount: 0
    };
  }
  const allNotes = store.getAllNotes();
  const openCount = windowManager.getOpenWindowCount();
  const closedCount = Math.max(0, allNotes.length - openCount);
  return {
    launchAtLogin: store.getSettings().launchAtLogin,
    totalNotesCount: allNotes.length,
    openNotesCount: openCount,
    closedNotesCount: closedCount,
    loadStatus: store.getLoadStatus()
  };
}

function broadcastGlobalState() {
  if (!windowManager) return;
  const meta = getGlobalMetaState();
  for (const win of windowManager.windows.values()) {
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('spotnotes:state-changed', meta);
    }
  }
  updateTrayMenu();
}

function setupTray() {
  try {
    const iconPath = getIconPath();
    const img = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('SpotNotes — Sticky Notes');
    tray.on('click', async () => {
      if (!windowManager) return;
      if (windowManager.getOpenWindowCount() === 0) {
        const reopened = await windowManager.reopenClosedNotes();
        if (reopened.length === 0) {
          await windowManager.createNewNoteWindow();
        }
      } else {
        for (const win of windowManager.windows.values()) {
          if (win && !win.isDestroyed()) {
            win.show();
            win.focus();
          }
        }
      }
    });
    updateTrayMenu();
  } catch (err) {
    console.warn(`[SpotNotes] System tray unavailable (${err.message}); continuing in window mode.`);
  }
}

function updateTrayMenu() {
  if (!tray || !store || !windowManager) return;
  const meta = getGlobalMetaState();

  const template = [
    {
      label: 'New Sticky Note',
      click: () => {
        windowManager.createNewNoteWindow();
      }
    },
    {
      label: `Show Closed Notes (${meta.closedNotesCount})`,
      enabled: meta.closedNotesCount > 0,
      click: () => {
        windowManager.reopenClosedNotes();
      }
    },
    { type: 'separator' },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: meta.launchAtLogin,
      click: async (menuItem) => {
        const enabled = Boolean(menuItem.checked);
        await autostartManager.sync(enabled);
        store.updateSettings({ launchAtLogin: enabled });
        broadcastGlobalState();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit SpotNotes',
      click: () => {
        isQuitting = true;
        if (windowManager) {
          windowManager.setQuitting(true);
        }
        app.quit();
      }
    }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers() {
  ipcMain.handle('spotnotes:get-init-data', (_event, payload) => {
    const check = validateIpcPayload('note-id', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    const note = store.getNote(check.value.id);
    if (!note) {
      throw new Error(`Note not found: ${check.value.id}`);
    }
    return {
      note,
      meta: getGlobalMetaState()
    };
  });

  ipcMain.handle('spotnotes:update-text', (_event, payload) => {
    const check = validateIpcPayload('update-text', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    const updated = store.updateNoteText(check.value.id, check.value.text);
    return { ok: Boolean(updated), updatedAt: updated ? updated.updatedAt : null };
  });

  ipcMain.handle('spotnotes:update-colour', (_event, payload) => {
    const check = validateIpcPayload('update-colour', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    const updated = store.updateNoteColour(check.value.id, check.value.colour);
    return { ok: Boolean(updated), note: updated };
  });

  ipcMain.handle('spotnotes:toggle-pin', (_event, payload) => {
    const check = validateIpcPayload('toggle-pin', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    const updated = store.updateNoteAlwaysOnTop(check.value.id, check.value.alwaysOnTop);
    const win = windowManager.getWindow(check.value.id);
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(check.value.alwaysOnTop);
    }
    return {
      ok: Boolean(updated),
      alwaysOnTop: updated ? updated.alwaysOnTop : false
    };
  });

  ipcMain.handle('spotnotes:create-note', async (_event, payload) => {
    let anchorId = null;
    if (payload && payload.id) {
      const check = validateIpcPayload('note-id', payload);
      if (check.valid) {
        anchorId = check.value.id;
      }
    }
    const res = await windowManager.createNewNoteWindow(anchorId);
    broadcastGlobalState();
    return { ok: true, note: res.note };
  });

  ipcMain.handle('spotnotes:close-note', (_event, payload) => {
    const check = validateIpcPayload('note-id', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    const closed = windowManager.closeNoteWindow(check.value.id);
    broadcastGlobalState();
    return { ok: closed };
  });

  ipcMain.handle('spotnotes:delete-note', (_event, payload) => {
    const check = validateIpcPayload('note-id', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    const deleted = windowManager.deleteNoteAndCloseWindow(check.value.id);
    broadcastGlobalState();
    return { ok: deleted };
  });

  ipcMain.handle('spotnotes:reopen-closed-notes', async () => {
    const reopened = await windowManager.reopenClosedNotes();
    broadcastGlobalState();
    return { ok: true, reopenedCount: reopened.length };
  });

  ipcMain.handle('spotnotes:update-settings', async (_event, payload) => {
    const check = validateIpcPayload('update-settings', payload);
    if (!check.valid) {
      throw new Error(check.error);
    }
    await autostartManager.sync(check.value.launchAtLogin);
    const settings = store.updateSettings({ launchAtLogin: check.value.launchAtLogin });
    broadcastGlobalState();
    return { ok: true, settings };
  });

  ipcMain.handle('spotnotes:quit-app', async () => {
    isQuitting = true;
    if (windowManager) {
      windowManager.setQuitting(true);
      windowManager.captureAllOpenWindowBounds();
    }
    if (store) {
      await store.flush();
    }
    app.quit();
    return { ok: true };
  });
}

app.on('second-instance', async () => {
  if (!windowManager) return;
  if (windowManager.getOpenWindowCount() === 0) {
    const reopened = await windowManager.reopenClosedNotes();
    if (reopened.length === 0) {
      await windowManager.createNewNoteWindow();
    }
  } else {
    for (const win of windowManager.windows.values()) {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    }
  }
  broadcastGlobalState();
});

// Keep application running in background/tray when note windows are closed (unless explicitly quitting)
app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (windowManager) {
    windowManager.setQuitting(true);
    windowManager.captureAllOpenWindowBounds();
  }
  if (store) {
    store.flushSync();
  }
});

async function bootstrap() {
  const userDataDir = app.getPath('userData');
  store = new NoteStore({ userDataDir });
  await store.load();

  autostartManager = new LinuxAutostartManager({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    iconPath: getIconPath()
  });

  // Ensure autostart desktop file matches persisted setting if enabled
  const currentSettings = store.getSettings();
  if (currentSettings.launchAtLogin) {
    try {
      await autostartManager.enable();
    } catch (err) {
      console.warn(`[SpotNotes] Failed to sync autostart entry on startup: ${err.message}`);
    }
  }

  await app.whenReady();

  const sessionDiag = getRuntimeSessionDiagnostics();
  const displaysDiag = getDisplaysSummary(screen);
  console.log('[SpotNotes] Runtime session diagnostics:', JSON.stringify(sessionDiag));
  console.log('[SpotNotes] Connected displays:', JSON.stringify(displaysDiag));

  windowManager = new NoteWindowManager({
    store,
    BrowserWindowClass: BrowserWindow,
    screenApi: screen,
    preloadPath: path.join(__dirname, 'preload.js'),
    rendererHtmlPath: path.join(__dirname, 'renderer', 'index.html'),
    iconPath: getIconPath(),
    onWindowsChanged: () => broadcastGlobalState()
  });

  registerIpcHandlers();
  setupTray();

  const onDisplayChanged = () => {
    if (windowManager) {
      windowManager.handleDisplayChange();
    }
  };
  screen.on('display-added', onDisplayChanged);
  screen.on('display-removed', onDisplayChanged);
  screen.on('display-metrics-changed', onDisplayChanged);

  let restoreSummary = await windowManager.restoreAllNotes();
  broadcastGlobalState();

  if (process.env.SPOTNOTES_INTEGRATION_OPS) {
    try {
      const ops = JSON.parse(process.env.SPOTNOTES_INTEGRATION_OPS);
      if (Array.isArray(ops)) {
        for (const op of ops) {
          if (op.type === 'move-resize' && op.id && op.bounds) {
            const win = windowManager.getWindow(op.id);
            if (win && !win.isDestroyed()) {
              win.setBounds(op.bounds);
              await new Promise((r) => setTimeout(r, 350));
            }
          } else if (op.type === 'toggle-pin' && op.id) {
            store.updateNoteAlwaysOnTop(op.id, Boolean(op.alwaysOnTop));
            const win = windowManager.getWindow(op.id);
            if (win && !win.isDestroyed()) {
              win.setAlwaysOnTop(Boolean(op.alwaysOnTop));
              await new Promise((r) => setTimeout(r, 150));
            }
          } else if (op.type === 'enable-autostart') {
            await autostartManager.sync(Boolean(op.enabled));
            store.updateSettings({ launchAtLogin: Boolean(op.enabled) });
          } else if (op.type === 'close-window' && op.id) {
            windowManager.closeNoteWindow(op.id);
            await new Promise((r) => setTimeout(r, 150));
          } else if (op.type === 'delete-note' && op.id) {
            windowManager.deleteNoteAndCloseWindow(op.id);
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        await store.flush();
      }
    } catch (err) {
      console.error(`[SpotNotes] Integration ops error: ${err.message}`);
    }
  }

  if (process.env.SPOTNOTES_DIAGNOSTIC_FILE) {
    const liveWindows = [];
    for (const [id, win] of windowManager.windows.entries()) {
      if (win && !win.isDestroyed()) {
        let x11Info = null;
        try {
          x11Info = await verifyX11WindowClient({
            nativeHandleBuffer: win.getNativeWindowHandle()
          });
        } catch {
          x11Info = null;
        }
        liveWindows.push({
          noteId: id,
          bounds: win.getBounds(),
          alwaysOnTop: win.isAlwaysOnTop(),
          x11: x11Info
        });
      }
    }

    const diagPayload = {
      timestamp: new Date().toISOString(),
      userDataDir,
      loadStatus: store.getLoadStatus(),
      session: sessionDiag,
      displays: displaysDiag,
      restoreSummary,
      liveWindows,
      persistedNotes: store.getAllNotes(),
      settings: store.getSettings(),
      autostartDesktopPath: autostartManager.getDesktopFilePath(),
      autostartFileExists: fs.existsSync(autostartManager.getDesktopFilePath())
    };
    try {
      fs.writeFileSync(
        process.env.SPOTNOTES_DIAGNOSTIC_FILE,
        `${JSON.stringify(diagPayload, null, 2)}\n`,
        'utf8'
      );
      console.log(`[SpotNotes] Wrote diagnostic report to ${process.env.SPOTNOTES_DIAGNOSTIC_FILE}`);
    } catch (err) {
      console.error(`[SpotNotes] Failed to write diagnostic file: ${err.message}`);
    }
  }

  if (process.env.SPOTNOTES_AUTO_QUIT_MS) {
    const ms = Number.parseInt(process.env.SPOTNOTES_AUTO_QUIT_MS, 10);
    if (Number.isFinite(ms) && ms > 0) {
      setTimeout(() => {
        isQuitting = true;
        if (windowManager) {
          windowManager.setQuitting(true);
          windowManager.captureAllOpenWindowBounds();
        }
        if (store) {
          store.flushSync();
        }
        app.quit();
      }, ms);
    }
  }
}

bootstrap().catch((err) => {
  console.error('[SpotNotes] Fatal startup error:', err);
  process.exit(1);
});
