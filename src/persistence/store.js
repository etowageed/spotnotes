'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  CURRENT_SCHEMA_VERSION,
  createDefaultNote,
  createDefaultStoreData,
  validateNote,
  validateStoreData,
  clampDimension,
  normalizeCoordinate,
  validateBoundsObject,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT
} = require('./schema');

class NoteStore {
  /**
   * @param {object} options
   * @param {string} options.userDataDir - Directory path where notes.json is stored
   * @param {string} [options.fileName='notes.json'] - Storage file name
   * @param {number} [options.textDebounceMs=300] - Debounce interval for text edits
   * @param {number} [options.geometryDebounceMs=250] - Debounce interval for move/resize
   * @param { Console } [options.logger=console] - Logger instance
   */
  constructor(options = {}) {
    if (!options.userDataDir || typeof options.userDataDir !== 'string') {
      throw new Error('NoteStore requires a valid userDataDir path');
    }

    this.userDataDir = options.userDataDir;
    this.fileName = options.fileName || 'notes.json';
    this.filePath = path.join(this.userDataDir, this.fileName);
    this.backupPath = `${this.filePath}.bak`;

    this.textDebounceMs = typeof options.textDebounceMs === 'number' ? options.textDebounceMs : 300;
    this.geometryDebounceMs = typeof options.geometryDebounceMs === 'number' ? options.geometryDebounceMs : 250;
    this.logger = options.logger || console;

    this._data = createDefaultStoreData();
    this._loaded = false;
    this._loadStatus = { status: 'unloaded', recovered: false, error: null, corruptArchivePath: null };
    this._protectCorruptFile = false;

    this._textTimers = new Map();
    this._geometryTimers = new Map();
    this._geometryLockedNotes = new Set();

    this._writeCounter = 0;
    this._writeChain = Promise.resolve();
    this._pendingWriteCount = 0;
    this._hasPendingChanges = false;
  }

  getLoadStatus() {
    return { ...this._loadStatus };
  }

  /**
   * Load and validate persisted data from disk.
   * Handles missing, malformed, or partially written files safely without silently erasing user data.
   */
  async load() {
    await fsp.mkdir(this.userDataDir, { recursive: true });

    const mainExists = fs.existsSync(this.filePath);
    const backupExists = fs.existsSync(this.backupPath);

    if (!mainExists && !backupExists) {
      this._data = createDefaultStoreData();
      this._loaded = true;
      this._protectCorruptFile = false;
      this._loadStatus = {
        status: 'initialized_empty',
        recovered: false,
        error: null,
        corruptArchivePath: null
      };
      return this.getSnapshot();
    }

    if (mainExists) {
      const mainResult = await this._readAndValidateFile(this.filePath);
      if (mainResult.valid) {
        this._data = mainResult.data;
        this._loaded = true;
        this._protectCorruptFile = false;
        this._loadStatus = {
          status: 'loaded_ok',
          recovered: false,
          error: null,
          corruptArchivePath: null
        };
        // Update backup copy from verified valid main file
        await this._writeBackupSafe(mainResult.rawText);
        return this.getSnapshot();
      }

      // Main file is malformed or failed validation!
      // 1. Archive the corrupt file immediately so user data is never lost.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptArchivePath = `${this.filePath}.corrupt.${timestamp}`;
      try {
        await fsp.copyFile(this.filePath, corruptArchivePath);
        this.logger.error(
          `[NoteStore] Corrupt storage detected at ${this.filePath} (${mainResult.error}). ` +
          `Preserved corrupt file at ${corruptArchivePath}`
        );
      } catch (copyErr) {
        this.logger.error(`[NoteStore] Failed to archive corrupt file: ${copyErr.message}`);
      }

      // 2. Attempt recovery from backup file if present.
      if (backupExists) {
        const backupResult = await this._readAndValidateFile(this.backupPath);
        if (backupResult.valid) {
          this._data = backupResult.data;
          this._loaded = true;
          this._protectCorruptFile = false;
          this._loadStatus = {
            status: 'recovered_from_backup',
            recovered: true,
            error: mainResult.error,
            corruptArchivePath
          };
          this.logger.warn(
            `[NoteStore] Successfully recovered ${this._data.notes.length} note(s) from backup ${this.backupPath}`
          );
          await this._atomicWriteData(this._data);
          return this.getSnapshot();
        }
      }

      // 3. Attempt partial salvage if JSON parsed as an object with some valid notes.
      if (mainResult.salvagedData && mainResult.salvagedData.notes.length > 0) {
        this._data = mainResult.salvagedData;
        this._loaded = true;
        this._protectCorruptFile = false;
        this._loadStatus = {
          status: 'recovered_partial_notes',
          recovered: true,
          error: mainResult.error,
          corruptArchivePath
        };
        this.logger.warn(
          `[NoteStore] Salvaged ${this._data.notes.length} valid note(s) from partially damaged file.`
        );
        await this._atomicWriteData(this._data);
        return this.getSnapshot();
      }

      // 4. Unparseable file with no valid backup:
      // Never silently overwrite the corrupt file with an empty note collection on load!
      this._data = createDefaultStoreData();
      this._loaded = true;
      this._protectCorruptFile = true;
      this._loadStatus = {
        status: 'corrupt_unrecoverable',
        recovered: false,
        error: mainResult.error,
        corruptArchivePath
      };
      return this.getSnapshot();
    }

    // Main file missing, but backup exists: recover from backup
    const backupResult = await this._readAndValidateFile(this.backupPath);
    if (backupResult.valid) {
      this._data = backupResult.data;
      this._loaded = true;
      this._protectCorruptFile = false;
      this._loadStatus = {
        status: 'recovered_from_backup',
        recovered: true,
        error: 'Primary notes.json was missing; restored from backup',
        corruptArchivePath: null
      };
      await this._atomicWriteData(this._data);
      return this.getSnapshot();
    }

    this._data = createDefaultStoreData();
    this._loaded = true;
    this._protectCorruptFile = true;
    this._loadStatus = {
      status: 'corrupt_unrecoverable',
      recovered: false,
      error: backupResult.error,
      corruptArchivePath: null
    };
    return this.getSnapshot();
  }

  async _readAndValidateFile(targetPath) {
    let rawText;
    try {
      rawText = await fsp.readFile(targetPath, 'utf8');
    } catch (err) {
      return { valid: false, error: `Read error: ${err.message}` };
    }

    if (!rawText || !rawText.trim()) {
      return { valid: false, error: 'File is empty' };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      return { valid: false, error: `JSON parse error: ${err.message}`, rawText };
    }

    const validation = validateStoreData(parsed);
    if (validation.valid) {
      return { valid: true, data: validation.data, rawText };
    }

    // Attempt partial salvage of valid individual notes if parsed.notes is an array
    let salvagedData = null;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.notes)) {
      const salvagedNotes = [];
      const seen = new Set();
      for (const candidate of parsed.notes) {
        const res = validateNote(candidate);
        if (res.valid && !seen.has(res.note.id)) {
          seen.add(res.note.id);
          salvagedNotes.push(res.note);
        }
      }
      const launchAtLogin = Boolean(parsed.settings && parsed.settings.launchAtLogin);
      salvagedData = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        notes: salvagedNotes,
        settings: { launchAtLogin }
      };
    }

    return {
      valid: false,
      error: validation.error,
      rawText,
      salvagedData
    };
  }

  async _writeBackupSafe(rawText) {
    try {
      const tmpBak = `${this.backupPath}.tmp.${process.pid}.${++this._writeCounter}`;
      await fsp.writeFile(tmpBak, rawText, 'utf8');
      await fsp.rename(tmpBak, this.backupPath);
    } catch (err) {
      this.logger.warn(`[NoteStore] Warning: could not update backup file: ${err.message}`);
    }
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this._data));
  }

  getAllNotes() {
    return this._data.notes.map((n) => ({ ...n, unclampedBounds: n.unclampedBounds ? { ...n.unclampedBounds } : null }));
  }

  getNote(id) {
    if (typeof id !== 'string') return null;
    const normalizedId = id.toLowerCase();
    const found = this._data.notes.find((n) => n.id === normalizedId);
    if (!found) return null;
    return {
      ...found,
      unclampedBounds: found.unclampedBounds ? { ...found.unclampedBounds } : null
    };
  }

  getSettings() {
    return { ...this._data.settings };
  }

  /**
   * Create and immediately persist a new note.
   */
  createNote(overrides = {}) {
    const existingIds = new Set(this._data.notes.map((n) => n.id));
    let note = createDefaultNote(overrides);
    while (existingIds.has(note.id)) {
      note = createDefaultNote({ ...overrides, id: undefined });
    }
    this._data.notes.push(note);
    this._geometryLockedNotes.delete(note.id);
    // Explicit user creation unlocks writing (corrupt file was already archived in load())
    this._protectCorruptFile = false;
    this._scheduleImmediateWrite();
    return { ...note };
  }

  /**
   * Update note text with debouncing to avoid excessive disk I/O during rapid typing.
   */
  updateNoteText(id, text) {
    if (typeof id !== 'string' || typeof text !== 'string') {
      return null;
    }
    const normalizedId = id.toLowerCase();
    const note = this._data.notes.find((n) => n.id === normalizedId);
    if (!note) return null;

    const boundedText = text.slice(0, 100000);
    if (note.text === boundedText) {
      return { ...note };
    }

    note.text = boundedText;
    note.updatedAt = new Date().toISOString();
    this._protectCorruptFile = false;
    this._hasPendingChanges = true;

    if (this._textTimers.has(normalizedId)) {
      clearTimeout(this._textTimers.get(normalizedId));
    }

    if (this.textDebounceMs <= 0) {
      this._textTimers.delete(normalizedId);
      this._scheduleImmediateWrite();
    } else {
      const timer = setTimeout(() => {
        this._textTimers.delete(normalizedId);
        this._scheduleImmediateWrite();
      }, this.textDebounceMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this._textTimers.set(normalizedId, timer);
    }

    return { ...note };
  }

  /**
   * Update note geometry with debouncing.
   * Ignores updates if the note's window has been locked for closing/destruction.
   */
  updateNoteGeometry(id, bounds, options = {}) {
    if (typeof id !== 'string' || !bounds || typeof bounds !== 'object') {
      return null;
    }
    const normalizedId = id.toLowerCase();
    if (this._geometryLockedNotes.has(normalizedId) && !options.forceUnlock) {
      return null;
    }

    const note = this._data.notes.find((n) => n.id === normalizedId);
    if (!note) return null;

    const nextX = normalizeCoordinate(bounds.x, note.x);
    const nextY = normalizeCoordinate(bounds.y, note.y);
    const nextW = clampDimension(bounds.width, MIN_WIDTH, MAX_WIDTH, note.width);
    const nextH = clampDimension(bounds.height, MIN_HEIGHT, MAX_HEIGHT, note.height);

    // If user manually moved or resized the window, clear unclampedBounds unless preserveUnclamped is set
    let nextUnclamped = note.unclampedBounds;
    if (options.unclampedBounds !== undefined) {
      nextUnclamped = validateBoundsObject(options.unclampedBounds);
    } else if (!options.preserveUnclamped) {
      nextUnclamped = null;
    }

    const changed =
      note.x !== nextX ||
      note.y !== nextY ||
      note.width !== nextW ||
      note.height !== nextH ||
      JSON.stringify(note.unclampedBounds) !== JSON.stringify(nextUnclamped);

    if (!changed && !options.forceWrite) {
      return { ...note };
    }

    note.x = nextX;
    note.y = nextY;
    note.width = nextW;
    note.height = nextH;
    note.unclampedBounds = nextUnclamped;
    if (!options.silentTimestamp) {
      note.updatedAt = new Date().toISOString();
    }
    this._protectCorruptFile = false;
    this._hasPendingChanges = true;

    if (this._geometryTimers.has(normalizedId)) {
      clearTimeout(this._geometryTimers.get(normalizedId));
    }

    if (options.immediate || this.geometryDebounceMs <= 0) {
      this._geometryTimers.delete(normalizedId);
      this._scheduleImmediateWrite();
    } else {
      const timer = setTimeout(() => {
        this._geometryTimers.delete(normalizedId);
        this._scheduleImmediateWrite();
      }, this.geometryDebounceMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this._geometryTimers.set(normalizedId, timer);
    }

    return { ...note };
  }

  /**
   * Lock geometry updates for a note whose window is closing or destroyed,
   * preventing stale move/resize events during window teardown from overwriting valid bounds.
   */
  lockNoteGeometry(id) {
    if (typeof id !== 'string') return;
    const normalizedId = id.toLowerCase();
    this._geometryLockedNotes.add(normalizedId);
    if (this._geometryTimers.has(normalizedId)) {
      clearTimeout(this._geometryTimers.get(normalizedId));
      this._geometryTimers.delete(normalizedId);
      this._scheduleImmediateWrite();
    }
  }

  unlockNoteGeometry(id) {
    if (typeof id !== 'string') return;
    this._geometryLockedNotes.delete(id.toLowerCase());
  }

  isNoteGeometryLocked(id) {
    if (typeof id !== 'string') return false;
    return this._geometryLockedNotes.has(id.toLowerCase());
  }

  updateNoteColour(id, colour) {
    if (typeof id !== 'string') return null;
    const normalizedId = id.toLowerCase();
    const note = this._data.notes.find((n) => n.id === normalizedId);
    if (!note) return null;

    const validation = validateNote({ ...note, colour });
    if (!validation.valid) return null;

    note.colour = colour;
    note.updatedAt = new Date().toISOString();
    this._protectCorruptFile = false;
    this._scheduleImmediateWrite();
    return { ...note };
  }

  updateNoteAlwaysOnTop(id, alwaysOnTop) {
    if (typeof id !== 'string') return null;
    const normalizedId = id.toLowerCase();
    const note = this._data.notes.find((n) => n.id === normalizedId);
    if (!note) return null;

    note.alwaysOnTop = Boolean(alwaysOnTop);
    note.updatedAt = new Date().toISOString();
    this._protectCorruptFile = false;
    this._scheduleImmediateWrite();
    return { ...note };
  }

  updateNoteOpenState(id, isOpen) {
    if (typeof id !== 'string') return null;
    const normalizedId = id.toLowerCase();
    const note = this._data.notes.find((n) => n.id === normalizedId);
    if (!note) return null;

    note.isOpen = Boolean(isOpen);
    note.updatedAt = new Date().toISOString();
    this._protectCorruptFile = false;
    this._scheduleImmediateWrite();
    return { ...note };
  }

  deleteNote(id) {
    if (typeof id !== 'string') return false;
    const normalizedId = id.toLowerCase();

    if (this._textTimers.has(normalizedId)) {
      clearTimeout(this._textTimers.get(normalizedId));
      this._textTimers.delete(normalizedId);
    }
    if (this._geometryTimers.has(normalizedId)) {
      clearTimeout(this._geometryTimers.get(normalizedId));
      this._geometryTimers.delete(normalizedId);
    }
    this._geometryLockedNotes.add(normalizedId);

    const index = this._data.notes.findIndex((n) => n.id === normalizedId);
    if (index === -1) return false;

    this._data.notes.splice(index, 1);
    this._protectCorruptFile = false;
    this._scheduleImmediateWrite();
    return true;
  }

  updateSettings(partialSettings) {
    if (!partialSettings || typeof partialSettings !== 'object') {
      return this.getSettings();
    }
    if (typeof partialSettings.launchAtLogin === 'boolean') {
      this._data.settings.launchAtLogin = partialSettings.launchAtLogin;
      this._protectCorruptFile = false;
      this._scheduleImmediateWrite();
    }
    return this.getSettings();
  }

  _clearAllTimers() {
    let clearedAny = false;
    for (const timer of this._textTimers.values()) {
      clearTimeout(timer);
      clearedAny = true;
    }
    this._textTimers.clear();

    for (const timer of this._geometryTimers.values()) {
      clearTimeout(timer);
      clearedAny = true;
    }
    this._geometryTimers.clear();
    return clearedAny;
  }

  _scheduleImmediateWrite() {
    if (this._protectCorruptFile) {
      return this._writeChain;
    }

    this._hasPendingChanges = true;
    this._pendingWriteCount += 1;
    const snapshot = this.getSnapshot();

    this._writeChain = this._writeChain
      .then(async () => {
        try {
          await this._atomicWriteData(snapshot);
        } finally {
          this._pendingWriteCount -= 1;
          if (this._pendingWriteCount === 0) {
            this._hasPendingChanges = false;
          }
        }
      })
      .catch((err) => {
        this.logger.error(`[NoteStore] Failed to write persistence file: ${err.message}`);
      });

    return this._writeChain;
  }

  async _atomicWriteData(dataSnapshot) {
    if (this._protectCorruptFile) {
      return;
    }

    const validation = validateStoreData(dataSnapshot);
    if (!validation.valid) {
      throw new Error(`Refusing to persist invalid store data: ${validation.error}`);
    }

    await fsp.mkdir(this.userDataDir, { recursive: true });

    const serialized = `${JSON.stringify(validation.data, null, 2)}\n`;
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${++this._writeCounter}`;

    let fileHandle;
    try {
      fileHandle = await fsp.open(tmpPath, 'w', 0o600);
      await fileHandle.writeFile(serialized, 'utf8');
      await fileHandle.sync();
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }

    await fsp.rename(tmpPath, this.filePath);
    await this._writeBackupSafe(serialized);
  }

  /**
   * Flush all pending debounced writes and wait for the write queue to complete.
   */
  async flush() {
    const hadTimers = this._clearAllTimers();
    if (hadTimers || this._hasPendingChanges) {
      this._scheduleImmediateWrite();
    }
    await this._writeChain;
  }

  /**
   * Synchronous best-effort flush for final process exit / shutdown hooks.
   */
  flushSync() {
    this._clearAllTimers();
    if (this._protectCorruptFile) {
      return false;
    }

    const validation = validateStoreData(this._data);
    if (!validation.valid) {
      this.logger.error(`[NoteStore] flushSync aborted: ${validation.error}`);
      return false;
    }

    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      const serialized = `${JSON.stringify(validation.data, null, 2)}\n`;
      const tmpPath = `${this.filePath}.tmp.sync.${process.pid}.${++this._writeCounter}`;
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeFileSync(fd, serialized, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this.filePath);
      const tmpBak = `${this.backupPath}.tmp.sync.${process.pid}.${++this._writeCounter}`;
      fs.writeFileSync(tmpBak, serialized, 'utf8');
      fs.renameSync(tmpBak, this.backupPath);
      this._hasPendingChanges = false;
      return true;
    } catch (err) {
      this.logger.error(`[NoteStore] flushSync failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = {
  NoteStore
};
