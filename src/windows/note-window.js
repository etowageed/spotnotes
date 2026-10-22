'use strict';

const path = require('node:path');
const { MIN_WIDTH, MIN_HEIGHT } = require('../persistence/schema');
const { resolveNoteBoundsForDisplays, compareBounds } = require('./geometry');
const { verifyX11WindowClient } = require('../platform/display-diagnostics');

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Create, position, verify, and wire lifecycle events for a single sticky note BrowserWindow.
 */
async function createAndRestoreNoteWindow(options) {
  const {
    note,
    store,
    BrowserWindowClass,
    screenApi,
    preloadPath = path.join(__dirname, '..', 'preload.js'),
    rendererHtmlPath = path.join(__dirname, '..', 'renderer', 'index.html'),
    iconPath = null,
    getIsQuitting = () => false,
    onWindowClosed = () => {},
    settleDelayMs = 80,
    verifyX11 = true,
    logger = console
  } = options;

  if (!note || !note.id) {
    throw new Error('createAndRestoreNoteWindow requires a valid note object');
  }

  const displays = screenApi && typeof screenApi.getAllDisplays === 'function'
    ? screenApi.getAllDisplays()
    : [];

  const resolution = resolveNoteBoundsForDisplays(note, displays);
  const targetBounds = resolution.bounds;

  if (resolution.clamped || resolution.restoredOriginalMonitor) {
    logger.log(`[NoteWindow:${note.id}] ${resolution.reason}`);
    store.updateNoteGeometry(note.id, targetBounds, {
      immediate: true,
      unclampedBounds: resolution.unclampedBounds,
      silentTimestamp: true,
      forceUnlock: true
    });
  }

  store.unlockNoteGeometry(note.id);

  let isRestoring = true;
  let isClosing = false;
  let isConfirmedX11 = !verifyX11;

  const winOptions = {
    x: targetBounds.x,
    y: targetBounds.y,
    width: targetBounds.width,
    height: targetBounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    center: false,
    show: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: Boolean(note.alwaysOnTop),
    title: 'SpotNotes',
    backgroundColor: '#fff9b1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
       navigateOnDragDrop: false
    }
  };

  if (iconPath) {
    winOptions.icon = iconPath;
  }

  const win = new BrowserWindowClass(winOptions);

  // Security: prevent untrusted navigation or new window creation
  if (win.webContents) {
    if (typeof win.webContents.setWindowOpenHandler === 'function') {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    if (typeof win.webContents.on === 'function') {
      win.webContents.on('will-navigate', (event) => {
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
      });
    }
  }

  const persistCurrentBounds = () => {
    if (isRestoring || isClosing || win.isDestroyed()) {
      return;
    }
    if (typeof win.isMinimized === 'function' && win.isMinimized()) {
      return;
    }
    const currentBounds = win.getBounds();
    if (!isConfirmedX11) {
      // Under native Wayland, global (x, y) coordinates are not exposed to the client;
      // persist only resize dimensions so saved XWayland (x, y) coordinates are not overwritten.
      const existing = store.getNote(note.id);
      if (existing) {
        store.updateNoteGeometry(note.id, {
          x: existing.x,
          y: existing.y,
          width: currentBounds.width,
          height: currentBounds.height
        });
      }
      return;
    }
    store.updateNoteGeometry(note.id, currentBounds);
  };

  // Never call setBounds or setPosition inside move/resize handlers!
  win.on('move', persistCurrentBounds);
  win.on('resize', persistCurrentBounds);

  win.on('close', () => {
    isClosing = true;
    const quitting = Boolean(getIsQuitting());

    // Capture last valid bounds before locking if window was already restored and not minimized
    if (!isRestoring && !win.isDestroyed() && isConfirmedX11) {
      const minimized = typeof win.isMinimized === 'function' && win.isMinimized();
      if (!minimized) {
        const finalBounds = win.getBounds();
        store.updateNoteGeometry(note.id, finalBounds, {
          immediate: true,
          preserveUnclamped: true,
          silentTimestamp: true
        });
      }
    }

    // Lock geometry so teardown events cannot overwrite saved bounds
    store.lockNoteGeometry(note.id);

    // If the user closed this individual note window (not quitting the app),
    // mark isOpen = false while preserving the note in storage.
    if (!quitting && store.getNote(note.id)) {
      store.updateNoteOpenState(note.id, false);
    }
  });

  win.on('closed', () => {
    isClosing = true;
    store.lockNoteGeometry(note.id);
    onWindowClosed(note.id);
  });

  // Load renderer HTML with the note ID in the query string
  const readyPromise = new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    win.once('ready-to-show', done);
    if (win.webContents && typeof win.webContents.once === 'function') {
      win.webContents.once('did-finish-load', done);
    }
    const fallbackTimer = setTimeout(done, 1500);
    if (typeof fallbackTimer.unref === 'function') {
      fallbackTimer.unref();
    }
  });

  if (typeof win.loadFile === 'function') {
    await win.loadFile(rendererHtmlPath, { query: { noteId: note.id } });
  }

  await readyPromise;

  if (win.isDestroyed()) {
    return {
      win,
      noteId: note.id,
      verification: {
        noteId: note.id,
        requestedBounds: targetBounds,
        observedBounds: null,
        matched: false,
        reason: 'Window destroyed before restoration completed'
      }
    };
  }

  // Apply target bounds explicitly before showing, without default centering
  win.setBounds(targetBounds);
  win.show();

  // Re-apply alwaysOnTop after mapping so X11/XWayland window managers honour _NET_WM_STATE_ABOVE
  if (typeof win.setAlwaysOnTop === 'function') {
    win.setAlwaysOnTop(Boolean(note.alwaysOnTop));
  }

  if (settleDelayMs > 0) {
    await delay(settleDelayMs);
  }

  let observedBounds = win.isDestroyed() ? null : win.getBounds();
  let comparison = compareBounds(targetBounds, observedBounds);
  let retriedPlacement = false;

  // If the window manager displaced the window during initial map, re-apply setBounds once
  if (!win.isDestroyed() && !comparison.matched) {
    retriedPlacement = true;
    win.setBounds(targetBounds);
    if (settleDelayMs > 0) {
      await delay(settleDelayMs);
    }
    observedBounds = win.isDestroyed() ? null : win.getBounds();
    comparison = compareBounds(targetBounds, observedBounds);
  }

  let x11Report = null;
  if (verifyX11 && !win.isDestroyed() && typeof win.getNativeWindowHandle === 'function') {
    try {
      const handleBuf = win.getNativeWindowHandle();
      x11Report = await verifyX11WindowClient({ nativeHandleBuffer: handleBuf });
      isConfirmedX11 = Boolean(x11Report && x11Report.isConfirmedX11Client);
    } catch (err) {
      x11Report = { isConfirmedX11Client: false, error: err.message };
      isConfirmedX11 = false;
    }
  }

  if (verifyX11 && !isConfirmedX11) {
    comparison = {
      ...comparison,
      matched: false,
      positionMatched: false,
      reason: 'Window is not an X11/XWayland client; Wayland compositor does not permit client-side global position verification'
    };
  } else if (x11Report && x11Report.x11Bounds) {
    observedBounds = x11Report.x11Bounds;
    comparison = compareBounds(targetBounds, observedBounds);
  }

  // Enable user move/resize persistence now that initial placement is complete
  isRestoring = false;

  const verification = {
    noteId: note.id,
    requestedBounds: targetBounds,
    observedBounds,
    x11ObservedBounds: x11Report ? x11Report.x11Bounds : null,
    clampedForDisplay: resolution.clamped,
    restoredOriginalMonitor: resolution.restoredOriginalMonitor,
    retriedPlacement,
    matched: comparison.matched,
    positionMatched: comparison.positionMatched,
    sizeMatched: comparison.sizeMatched,
    deltaX: comparison.deltaX,
    deltaY: comparison.deltaY,
    deltaWidth: comparison.deltaWidth,
    deltaHeight: comparison.deltaHeight,
    x11ClientConfirmed: x11Report ? x11Report.isConfirmedX11Client : null,
    x11WindowId: x11Report ? x11Report.xidHex : null,
    reason: comparison.reason
  };

  if (verification.matched) {
    logger.log(
      `[NoteWindow:${note.id}] Restored & verified bounds: ` +
      `requested=(${targetBounds.x},${targetBounds.y} ${targetBounds.width}x${targetBounds.height}) ` +
      `observed=(${observedBounds.x},${observedBounds.y} ${observedBounds.width}x${observedBounds.height}) ` +
      `x11=${verification.x11WindowId || 'n/a'}`
    );
  } else {
    logger.warn(
      `[NoteWindow:${note.id}] WARNING: Compositor overrode requested window placement! ` +
      `requested=(${targetBounds.x},${targetBounds.y} ${targetBounds.width}x${targetBounds.height}) ` +
      `observed=${observedBounds ? `(${observedBounds.x},${observedBounds.y} ${observedBounds.width}x${observedBounds.height})` : 'null'} ` +
      `(${comparison.reason})`
    );
  }

  return {
    win,
    noteId: note.id,
    verification
  };
}

module.exports = {
  createAndRestoreNoteWindow
};
