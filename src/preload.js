'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_COLOURS = ['yellow', 'pink', 'blue', 'green', 'lavender'];

function assertValidUuid(id) {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new Error('Invalid note UUID');
  }
  return id.toLowerCase();
}

const api = Object.freeze({
  getInitialNoteId() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('noteId');
    return id && UUID_REGEX.test(id) ? id.toLowerCase() : null;
  },

  async getNoteInitData(id) {
    const validId = assertValidUuid(id);
    return ipcRenderer.invoke('spotnotes:get-init-data', { id: validId });
  },

  async updateText(id, text) {
    const validId = assertValidUuid(id);
    if (typeof text !== 'string') {
      throw new Error('Note text must be a string');
    }
    return ipcRenderer.invoke('spotnotes:update-text', {
      id: validId,
      text: text.slice(0, 100000)
    });
  },

  async updateColour(id, colour) {
    const validId = assertValidUuid(id);
    if (typeof colour !== 'string' || !VALID_COLOURS.includes(colour)) {
      throw new Error('Invalid colour value');
    }
    return ipcRenderer.invoke('spotnotes:update-colour', { id: validId, colour });
  },

  async toggleAlwaysOnTop(id, alwaysOnTop) {
    const validId = assertValidUuid(id);
    return ipcRenderer.invoke('spotnotes:toggle-pin', {
      id: validId,
      alwaysOnTop: Boolean(alwaysOnTop)
    });
  },

  async createNote(anchorId) {
    const payload = anchorId && UUID_REGEX.test(anchorId)
      ? { id: anchorId.toLowerCase() }
      : {};
    return ipcRenderer.invoke('spotnotes:create-note', payload);
  },

  async closeNoteWindow(id) {
    const validId = assertValidUuid(id);
    return ipcRenderer.invoke('spotnotes:close-note', { id: validId });
  },

  async deleteNote(id) {
    const validId = assertValidUuid(id);
    return ipcRenderer.invoke('spotnotes:delete-note', { id: validId });
  },

  async reopenClosedNotes() {
    return ipcRenderer.invoke('spotnotes:reopen-closed-notes', {});
  },

  async updateLaunchAtLogin(launchAtLogin) {
    return ipcRenderer.invoke('spotnotes:update-settings', {
      launchAtLogin: Boolean(launchAtLogin)
    });
  },

  async quitApplication() {
    return ipcRenderer.invoke('spotnotes:quit-app', {});
  },

  onStateChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('spotnotes:state-changed', handler);
    return () => ipcRenderer.removeListener('spotnotes:state-changed', handler);
  }
});

contextBridge.exposeInMainWorld('spotnotes', api);
