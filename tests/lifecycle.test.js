'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NoteStore } = require('../src/persistence/store');
const { NoteWindowManager } = require('../src/windows/restore-notes');

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {}
};

function createMockBrowserWindowClass(options = {}) {
  const forceCompositorOverride = Boolean(options.forceCompositorOverride);
  const instances = [];

  class MockBrowserWindow extends EventEmitter {
    constructor(winOpts) {
      super();
      this.options = winOpts;
      this._bounds = {
        x: forceCompositorOverride ? 0 : winOpts.x,
        y: forceCompositorOverride ? 0 : winOpts.y,
        width: winOpts.width,
        height: winOpts.height
      };
      this._destroyed = false;
      this._shown = false;
      this._alwaysOnTop = Boolean(winOpts.alwaysOnTop);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      instances.push(this);
    }

    async loadFile(filePath, loadOpts) {
      this.loadedFile = filePath;
      this.loadedQuery = loadOpts && loadOpts.query;
      setImmediate(() => {
        this.emit('ready-to-show');
        this.webContents.emit('did-finish-load');
      });
    }

    getBounds() {
      return { ...this._bounds };
    }

    setBounds(newBounds) {
      if (forceCompositorOverride) {
        this._bounds = {
          x: 0,
          y: 0,
          width: newBounds.width,
          height: newBounds.height
        };
      } else {
        this._bounds = { ...newBounds };
      }
      this.emit('move');
      this.emit('resize');
    }

    show() {
      this._shown = true;
    }

    focus() {
      this._focused = true;
    }

    setAlwaysOnTop(flag) {
      this._alwaysOnTop = Boolean(flag);
    }

    isAlwaysOnTop() {
      return this._alwaysOnTop;
    }

    isMinimized() {
      return false;
    }

    isDestroyed() {
      return this._destroyed;
    }

    close() {
      if (this._destroyed) return;
      this.emit('close');
      this._destroyed = true;
      this.emit('closed');
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.emit('closed');
    }
  }

  MockBrowserWindow.instances = instances;
  return MockBrowserWindow;
}

const mockScreen = {
  getAllDisplays: () => [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 32, width: 1920, height: 1048 }
    }
  ],
  getPrimaryDisplay: () => ({
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 32, width: 1920, height: 1048 }
  })
};

test('Lifecycle: restores saved notes sequentially, prevents duplicate windows, and verifies bounds', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spotnotes-lifecycle-'));
  try {
    const store = new NoteStore({
      userDataDir: dir,
      textDebounceMs: 10,
      geometryDebounceMs: 10,
      logger: silentLogger
    });
    await store.load();

    const n1 = store.createNote({ text: 'Note 1', colour: 'yellow', x: 180, y: 160, width: 280, height: 260 });
    const n2 = store.createNote({ text: 'Note 2', colour: 'pink', x: 520, y: 240, width: 310, height: 290, alwaysOnTop: true });
    await store.flush();

    const MockBW = createMockBrowserWindowClass();
    const manager = new NoteWindowManager({
      store,
      BrowserWindowClass: MockBW,
      screenApi: mockScreen,
      restoreDelayMs: 5,
      settleDelayMs: 5,
      verifyX11: false,
      logger: silentLogger
    });

    const summary = await manager.restoreAllNotes();
    assert.equal(summary.totalRestored, 2);
    assert.equal(summary.verifiedCount, 2);
    assert.equal(summary.overriddenCount, 0);
    assert.equal(manager.getOpenWindowCount(), 2);

    // Attempting to open an already open note returns the existing window instead of duplicating
    const dupResult = await manager.openNoteWindow(n1);
    assert.equal(dupResult.deduplicated, true);
    assert.equal(manager.getOpenWindowCount(), 2);
    assert.equal(MockBW.instances.length, 2);

    const win2 = manager.getWindow(n2.id);
    assert.deepEqual(win2.getBounds(), { x: 520, y: 240, width: 310, height: 290 });
    assert.equal(win2.isAlwaysOnTop(), true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Lifecycle: distinguishes closing a note window from deleting a note', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spotnotes-close-delete-'));
  try {
    const store = new NoteStore({
      userDataDir: dir,
      textDebounceMs: 10,
      geometryDebounceMs: 10,
      logger: silentLogger
    });
    await store.load();

    const n1 = store.createNote({ text: 'Keep when closed', colour: 'blue', x: 250, y: 200 });
    const n2 = store.createNote({ text: 'Delete permanently', colour: 'lavender', x: 600, y: 200 });
    await store.flush();

    const MockBW = createMockBrowserWindowClass();
    const manager = new NoteWindowManager({
      store,
      BrowserWindowClass: MockBW,
      screenApi: mockScreen,
      restoreDelayMs: 5,
      settleDelayMs: 5,
      verifyX11: false,
      logger: silentLogger
    });

    await manager.restoreAllNotes();
    assert.equal(manager.getOpenWindowCount(), 2);

    // Close n1 without deleting
    manager.closeNoteWindow(n1.id);
    assert.equal(manager.getOpenWindowCount(), 1);
    const savedN1 = store.getNote(n1.id);
    assert.ok(savedN1, 'Closed note must remain in storage');
    assert.equal(savedN1.text, 'Keep when closed');
    assert.equal(savedN1.isOpen, false);

    // Delete n2 permanently
    manager.deleteNoteAndCloseWindow(n2.id);
    assert.equal(manager.getOpenWindowCount(), 0);
    assert.equal(store.getNote(n2.id), null, 'Deleted note must be removed from storage');

    await store.flush();

    // Relaunch application: n1 is restored, n2 does not reappear
    const store2 = new NoteStore({ userDataDir: dir, logger: silentLogger });
    await store2.load();
    const MockBW2 = createMockBrowserWindowClass();
    const manager2 = new NoteWindowManager({
      store: store2,
      BrowserWindowClass: MockBW2,
      screenApi: mockScreen,
      restoreDelayMs: 5,
      settleDelayMs: 5,
      verifyX11: false,
      logger: silentLogger
    });

    const summary2 = await manager2.restoreAllNotes();
    assert.equal(summary2.totalRestored, 1);
    assert.equal(store2.getAllNotes().length, 1);
    assert.equal(store2.getAllNotes()[0].id, n1.id);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Lifecycle: detects and reports when compositor overrides requested window position', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spotnotes-override-'));
  try {
    const store = new NoteStore({ userDataDir: dir, logger: silentLogger });
    await store.load();
    store.createNote({ text: 'Wayland overridden note', x: 400, y: 350, width: 280, height: 260 });
    await store.flush();

    const OverridingBW = createMockBrowserWindowClass({ forceCompositorOverride: true });
    const manager = new NoteWindowManager({
      store,
      BrowserWindowClass: OverridingBW,
      screenApi: mockScreen,
      restoreDelayMs: 5,
      settleDelayMs: 5,
      verifyX11: false,
      logger: silentLogger
    });

    const summary = await manager.restoreAllNotes();
    assert.equal(summary.totalRestored, 1);
    assert.equal(summary.verifiedCount, 0);
    assert.equal(summary.overriddenCount, 1);
    assert.equal(summary.reports[0].matched, false);
    assert.equal(summary.reports[0].positionMatched, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
