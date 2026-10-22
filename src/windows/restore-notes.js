'use strict';

const { calculateNewNoteBounds, resolveNoteBoundsForDisplays } = require('./geometry');
const { createAndRestoreNoteWindow } = require('./note-window');

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class NoteWindowManager {
  constructor(options) {
    if (!options || !options.store || !options.BrowserWindowClass) {
      throw new Error('NoteWindowManager requires store and BrowserWindowClass');
    }

    this.store = options.store;
    this.BrowserWindowClass = options.BrowserWindowClass;
    this.screenApi = options.screenApi || null;
    this.preloadPath = options.preloadPath;
    this.rendererHtmlPath = options.rendererHtmlPath;
    this.iconPath = options.iconPath || null;
    this.restoreDelayMs = typeof options.restoreDelayMs === 'number' ? options.restoreDelayMs : 60;
    this.settleDelayMs = typeof options.settleDelayMs === 'number' ? options.settleDelayMs : 80;
    this.verifyX11 = options.verifyX11 !== undefined ? Boolean(options.verifyX11) : true;
    this.logger = options.logger || console;
    this.onWindowsChanged = typeof options.onWindowsChanged === 'function' ? options.onWindowsChanged : () => {};

    this.windows = new Map();
    this._pendingCreations = new Map();
    this.verificationReports = new Map();
    this.isQuitting = false;
  }

  setQuitting(quitting) {
    this.isQuitting = Boolean(quitting);
  }

  getWindow(noteId) {
    if (typeof noteId !== 'string') return null;
    const id = noteId.toLowerCase();
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) {
      this.windows.delete(id);
      return null;
    }
    return win;
  }

  getOpenWindowCount() {
    let count = 0;
    for (const [id, win] of this.windows.entries()) {
      if (win && !win.isDestroyed()) {
        count += 1;
      } else {
        this.windows.delete(id);
      }
    }
    return count;
  }

  getDisplays() {
    if (this.screenApi && typeof this.screenApi.getAllDisplays === 'function') {
      return this.screenApi.getAllDisplays();
    }
    return [];
  }

  /**
   * Open or focus a single note window, preventing duplicate windows for the same UUID.
   */
  async openNoteWindow(note) {
    const id = note.id.toLowerCase();

    const existing = this.getWindow(id);
    if (existing) {
      existing.show();
      if (typeof existing.focus === 'function') {
        existing.focus();
      }
      return {
        win: existing,
        noteId: id,
        deduplicated: true,
        verification: this.verificationReports.get(id) || null
      };
    }

    if (this._pendingCreations.has(id)) {
      return this._pendingCreations.get(id);
    }

    const creationPromise = (async () => {
      try {
        this.store.updateNoteOpenState(id, true);
        const freshNote = this.store.getNote(id) || note;

        const result = await createAndRestoreNoteWindow({
          note: freshNote,
          store: this.store,
          BrowserWindowClass: this.BrowserWindowClass,
          screenApi: this.screenApi,
          preloadPath: this.preloadPath,
          rendererHtmlPath: this.rendererHtmlPath,
          iconPath: this.iconPath,
          getIsQuitting: () => this.isQuitting,
          onWindowClosed: (closedId) => {
            this.windows.delete(closedId);
            this.onWindowsChanged();
          },
          settleDelayMs: this.settleDelayMs,
          verifyX11: this.verifyX11,
          logger: this.logger
        });

        if (result.win && !result.win.isDestroyed()) {
          this.windows.set(id, result.win);
        }
        if (result.verification) {
          this.verificationReports.set(id, result.verification);
        }
        this.onWindowsChanged();
        return { ...result, deduplicated: false };
      } finally {
        this._pendingCreations.delete(id);
      }
    })();

    this._pendingCreations.set(id, creationPromise);
    return creationPromise;
  }

  /**
   * Restore saved notes sequentially at application startup.
   * Creates a default welcome note if no notes exist in storage.
   */
  async restoreAllNotes(options = {}) {
    let notes = this.store.getAllNotes();
    const onlyOpen = Boolean(options.onlyOpen);

    if (notes.length === 0 && options.createDefaultIfEmpty !== false) {
      const initialBounds = calculateNewNoteBounds([], this.getDisplays());
      const defaultNote = this.store.createNote({
        text: '',
        colour: 'yellow',
        ...initialBounds,
        alwaysOnTop: false,
        isOpen: true
      });
      notes = [defaultNote];
    }

    const notesToRestore = onlyOpen
      ? notes.filter((n) => n.isOpen !== false)
      : notes;

    const reports = [];
    for (let i = 0; i < notesToRestore.length; i += 1) {
      const note = notesToRestore[i];
      const res = await this.openNoteWindow(note);
      if (res.verification) {
        reports.push(res.verification);
      }
      if (i < notesToRestore.length - 1 && this.restoreDelayMs > 0) {
        await delay(this.restoreDelayMs);
      }
    }

    const verifiedCount = reports.filter((r) => r.matched).length;
    const overriddenCount = reports.length - verifiedCount;

    return {
      totalRestored: reports.length,
      verifiedCount,
      overriddenCount,
      reports
    };
  }

  /**
   * Create a brand new sticky note with cascaded geometry and open its window.
   */
  async createNewNoteWindow(anchorNoteId = null, overrides = {}) {
    const existingNotes = this.store.getAllNotes();
    let anchorBounds = null;
    if (anchorNoteId) {
      const anchorWin = this.getWindow(anchorNoteId);
      if (anchorWin) {
        anchorBounds = anchorWin.getBounds();
      } else {
        const anchorNote = this.store.getNote(anchorNoteId);
        if (anchorNote) {
          anchorBounds = {
            x: anchorNote.x,
            y: anchorNote.y,
            width: anchorNote.width,
            height: anchorNote.height
          };
        }
      }
    }

    const bounds = calculateNewNoteBounds(existingNotes, this.getDisplays(), anchorBounds);
    const createdNote = this.store.createNote({
      ...bounds,
      ...overrides,
      isOpen: true
    });

    const result = await this.openNoteWindow(createdNote);
    return {
      note: this.store.getNote(createdNote.id),
      ...result
    };
  }

  /**
   * Close a note window without deleting its persisted contents.
   */
  closeNoteWindow(noteId) {
    const win = this.getWindow(noteId);
    if (!win) {
      this.store.updateNoteOpenState(noteId, false);
      return false;
    }
    win.close();
    return true;
  }

  /**
   * Permanently delete a note and close/destroy its window.
   */
  deleteNoteAndCloseWindow(noteId) {
    if (typeof noteId !== 'string') return false;
    const id = noteId.toLowerCase();
    const win = this.getWindow(id);
    this.store.deleteNote(id);
    this.verificationReports.delete(id);

    if (win && !win.isDestroyed()) {
      this.windows.delete(id);
      if (typeof win.destroy === 'function') {
        win.destroy();
      } else {
        win.close();
      }
    }
    this.onWindowsChanged();
    return true;
  }

  /**
   * Reopen any saved notes whose windows are currently closed.
   */
  async reopenClosedNotes() {
    const allNotes = this.store.getAllNotes();
    const reopened = [];
    for (const note of allNotes) {
      if (!this.getWindow(note.id)) {
        const res = await this.openNoteWindow(note);
        reopened.push(res);
        if (this.restoreDelayMs > 0) {
          await delay(this.restoreDelayMs);
        }
      }
    }
    return reopened;
  }

  /**
   * Re-evaluate open note windows when displays are added, removed, or resized.
   */
  handleDisplayChange() {
    const displays = this.getDisplays();
    const results = [];

    for (const [id, win] of this.windows.entries()) {
      if (!win || win.isDestroyed()) continue;
      const note = this.store.getNote(id);
      if (!note) continue;

      const resolved = resolveNoteBoundsForDisplays(note, displays);
      if (resolved.clamped || resolved.restoredOriginalMonitor) {
        this.logger.log(`[NoteWindowManager] Display layout change for ${id}: ${resolved.reason}`);
        win.setBounds(resolved.bounds);
        this.store.updateNoteGeometry(id, resolved.bounds, {
          immediate: true,
          unclampedBounds: resolved.unclampedBounds,
          silentTimestamp: true,
          forceUnlock: true
        });
        results.push({ noteId: id, ...resolved });
      }
    }

    return results;
  }

  /**
   * Capture current bounds of all open windows before shutdown.
   */
  captureAllOpenWindowBounds() {
    for (const [id, win] of this.windows.entries()) {
      if (!win || win.isDestroyed()) continue;
      const ver = this.verificationReports.get(id);
      if (this.verifyX11 && ver && ver.x11ClientConfirmed === false) {
        this.store.lockNoteGeometry(id);
        continue;
      }
      const minimized = typeof win.isMinimized === 'function' && win.isMinimized();
      if (!minimized) {
        const bounds = win.getBounds();
        this.store.updateNoteGeometry(id, bounds, {
          immediate: true,
          preserveUnclamped: true,
          silentTimestamp: true
        });
      }
      this.store.lockNoteGeometry(id);
    }
  }
}

module.exports = {
  NoteWindowManager
};
