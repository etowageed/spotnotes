'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NoteStore } = require('../src/persistence/store');

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {}
};

async function createTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'spotnotes-test-'));
}

test('Persistence: initializes empty store, creates notes, persists and reloads accurately', async () => {
  const dir = await createTempDir();
  try {
    const store = new NoteStore({
      userDataDir: dir,
      textDebounceMs: 20,
      geometryDebounceMs: 20,
      logger: silentLogger
    });

    const initial = await store.load();
    assert.equal(initial.notes.length, 0);
    assert.equal(initial.settings.launchAtLogin, false);

    const n1 = store.createNote({
      text: 'First sticky note',
      colour: 'green',
      x: 220,
      y: 180,
      width: 300,
      height: 250,
      alwaysOnTop: true
    });

    store.updateSettings({ launchAtLogin: true });
    await store.flush();

    const reloadedStore = new NoteStore({ userDataDir: dir, logger: silentLogger });
    const reloaded = await reloadedStore.load();

    assert.equal(reloaded.notes.length, 1);
    assert.equal(reloaded.notes[0].id, n1.id);
    assert.equal(reloaded.notes[0].text, 'First sticky note');
    assert.equal(reloaded.notes[0].colour, 'green');
    assert.equal(reloaded.notes[0].x, 220);
    assert.equal(reloaded.notes[0].y, 180);
    assert.equal(reloaded.notes[0].width, 300);
    assert.equal(reloaded.notes[0].height, 250);
    assert.equal(reloaded.notes[0].alwaysOnTop, true);
    assert.equal(reloaded.settings.launchAtLogin, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Persistence: debounces rapid text and geometry updates and flushes cleanly', async () => {
  const dir = await createTempDir();
  try {
    const store = new NoteStore({
      userDataDir: dir,
      textDebounceMs: 60,
      geometryDebounceMs: 60,
      logger: silentLogger
    });
    await store.load();

    const note = store.createNote({ text: 'init', x: 100, y: 100 });
    await store.flush();

    for (let i = 1; i <= 10; i += 1) {
      store.updateNoteText(note.id, `typing step ${i}`);
      store.updateNoteGeometry(note.id, { x: 100 + i * 5, y: 100 + i * 3, width: 280 + i, height: 260 + i });
    }

    // Wait for debounce timer to fire and settle
    await new Promise((resolve) => setTimeout(resolve, 120));
    await store.flush();

    const store2 = new NoteStore({ userDataDir: dir, logger: silentLogger });
    await store2.load();
    const persisted = store2.getNote(note.id);
    assert.equal(persisted.text, 'typing step 10');
    assert.equal(persisted.x, 150);
    assert.equal(persisted.y, 130);
    assert.equal(persisted.width, 290);
    assert.equal(persisted.height, 270);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Persistence: ignores stale geometry updates after window is locked for closing', async () => {
  const dir = await createTempDir();
  try {
    const store = new NoteStore({
      userDataDir: dir,
      geometryDebounceMs: 40,
      logger: silentLogger
    });
    await store.load();

    const note = store.createNote({ x: 350, y: 420, width: 300, height: 260 });
    await store.flush();

    // Lock geometry as window begins closing
    store.lockNoteGeometry(note.id);

    // Late/stale move event from window destruction should be ignored
    const result = store.updateNoteGeometry(note.id, { x: 0, y: 0, width: 100, height: 100 });
    assert.equal(result, null);

    await store.flush();
    const reloaded = new NoteStore({ userDataDir: dir, logger: silentLogger });
    await reloaded.load();
    const saved = reloaded.getNote(note.id);
    assert.equal(saved.x, 350);
    assert.equal(saved.y, 420);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Persistence: recovers from backup when primary JSON file is corrupted and preserves corrupt file', async () => {
  const dir = await createTempDir();
  try {
    const store = new NoteStore({ userDataDir: dir, logger: silentLogger });
    await store.load();
    const note = store.createNote({ text: 'Important note to recover', colour: 'blue', x: 500, y: 400 });
    await store.flush();

    // Corrupt the primary notes.json file
    await fsp.writeFile(store.filePath, '{ "schemaVersion": 1, "notes": [ INVALID JSON', 'utf8');

    const recoveryStore = new NoteStore({ userDataDir: dir, logger: silentLogger });
    const recoveredData = await recoveryStore.load();
    const status = recoveryStore.getLoadStatus();

    assert.equal(status.status, 'recovered_from_backup');
    assert.equal(status.recovered, true);
    assert.ok(status.corruptArchivePath && fs.existsSync(status.corruptArchivePath));
    assert.equal(recoveredData.notes.length, 1);
    assert.equal(recoveredData.notes[0].id, note.id);
    assert.equal(recoveredData.notes[0].text, 'Important note to recover');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Persistence: never silently overwrites corrupt JSON file with empty collection when no backup exists', async () => {
  const dir = await createTempDir();
  try {
    const filePath = path.join(dir, 'notes.json');
    const rawCorruptContent = '<<< CORRUPTED USER DATA WITHOUT BACKUP >>>';
    await fsp.writeFile(filePath, rawCorruptContent, 'utf8');

    const store = new NoteStore({ userDataDir: dir, logger: silentLogger });
    await store.load();
    const status = store.getLoadStatus();

    assert.equal(status.status, 'corrupt_unrecoverable');
    assert.ok(status.corruptArchivePath && fs.existsSync(status.corruptArchivePath));

    // Even if flush() or flushSync() is called without user modifications, original file must not be erased
    await store.flush();
    store.flushSync();

    const diskContent = await fsp.readFile(filePath, 'utf8');
    assert.equal(diskContent, rawCorruptContent);
    const archiveContent = await fsp.readFile(status.corruptArchivePath, 'utf8');
    assert.equal(archiveContent, rawCorruptContent);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
