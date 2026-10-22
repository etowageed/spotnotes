'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CURRENT_SCHEMA_VERSION,
  VALID_COLOURS,
  MAX_TEXT_LENGTH,
  isValidUuid,
  isValidColour,
  isValidIsoTimestamp,
  createDefaultNote,
  validateNote,
  createDefaultStoreData,
  validateStoreData,
  validateIpcPayload
} = require('../src/persistence/schema');

test('Schema: UUID validation and uniqueness', () => {
  const generatedIds = new Set();
  for (let i = 0; i < 200; i += 1) {
    const note = createDefaultNote();
    assert.equal(isValidUuid(note.id), true, `Expected valid UUID, got ${note.id}`);
    assert.equal(generatedIds.has(note.id), false, `Duplicate UUID generated: ${note.id}`);
    generatedIds.add(note.id);
  }

  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid('12345678-1234-1234-1234-123456789012'), true);
  assert.equal(isValidUuid(''), false);
  assert.equal(isValidUuid(null), false);
});

test('Schema: colour validation supports all required sticky note colours', () => {
  const required = ['yellow', 'pink', 'blue', 'green', 'lavender'];
  for (const c of required) {
    assert.equal(VALID_COLOURS.includes(c), true);
    assert.equal(isValidColour(c), true);
  }
  assert.equal(isValidColour('infrared'), false);
  assert.equal(isValidColour(''), false);
  assert.equal(isValidColour(123), false);
});

test('Schema: note validation accepts valid notes and clamps dimensions safely', () => {
  const note = createDefaultNote({
    text: 'Buy oat milk',
    colour: 'pink',
    x: 450,
    y: 300,
    width: 320,
    height: 290,
    alwaysOnTop: true
  });

  const res = validateNote(note);
  assert.equal(res.valid, true);
  assert.equal(res.note.text, 'Buy oat milk');
  assert.equal(res.note.colour, 'pink');
  assert.equal(res.note.x, 450);
  assert.equal(res.note.y, 300);
  assert.equal(res.note.width, 320);
  assert.equal(res.note.height, 290);
  assert.equal(res.note.alwaysOnTop, true);
  assert.equal(isValidIsoTimestamp(res.note.createdAt), true);
  assert.equal(isValidIsoTimestamp(res.note.updatedAt), true);
});

test('Schema: note validation rejects malformed fields', () => {
  const base = createDefaultNote();

  assert.equal(validateNote(null).valid, false);
  assert.equal(validateNote({ ...base, id: 'bad-id' }).valid, false);
  assert.equal(validateNote({ ...base, text: 42 }).valid, false);
  assert.equal(validateNote({ ...base, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }).valid, false);
  assert.equal(validateNote({ ...base, colour: 'red' }).valid, false);
  assert.equal(validateNote({ ...base, x: NaN }).valid, false);
  assert.equal(validateNote({ ...base, y: 999999 }).valid, false);
  assert.equal(validateNote({ ...base, width: 'wide' }).valid, false);
  assert.equal(validateNote({ ...base, alwaysOnTop: 'yes' }).valid, false);
  assert.equal(validateNote({ ...base, createdAt: 'not-a-date' }).valid, false);
});

test('Schema: store validation checks schemaVersion, settings, and duplicate UUIDs', () => {
  const store = createDefaultStoreData();
  assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(validateStoreData(store).valid, true);

  assert.equal(validateStoreData({ ...store, schemaVersion: 99 }).valid, false);
  assert.equal(validateStoreData({ ...store, notes: 'not-array' }).valid, false);
  assert.equal(validateStoreData({ ...store, settings: null }).valid, false);
  assert.equal(validateStoreData({ ...store, settings: { launchAtLogin: 'true' } }).valid, false);

  const note1 = createDefaultNote();
  const duplicateStore = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    notes: [note1, { ...note1 }],
    settings: { launchAtLogin: false }
  };
  const dupRes = validateStoreData(duplicateStore);
  assert.equal(dupRes.valid, false);
  assert.match(dupRes.error, /Duplicate note UUID/);
});

test('Schema: IPC payload validation rejects untrusted or malformed messages', () => {
  const note = createDefaultNote();

  assert.equal(validateIpcPayload('update-text', { id: note.id, text: 'Hello' }).valid, true);
  assert.equal(validateIpcPayload('update-text', { id: 'bad', text: 'Hello' }).valid, false);
  assert.equal(validateIpcPayload('update-text', { id: note.id, text: 123 }).valid, false);

  assert.equal(validateIpcPayload('update-colour', { id: note.id, colour: 'lavender' }).valid, true);
  assert.equal(validateIpcPayload('update-colour', { id: note.id, colour: 'black' }).valid, false);

  assert.equal(validateIpcPayload('toggle-pin', { id: note.id, alwaysOnTop: true }).valid, true);
  assert.equal(validateIpcPayload('toggle-pin', { id: note.id, alwaysOnTop: 1 }).valid, false);

  assert.equal(validateIpcPayload('note-id', { id: note.id }).valid, true);
  assert.equal(validateIpcPayload('note-id', { id: '../etc/passwd' }).valid, false);

  assert.equal(validateIpcPayload('update-settings', { launchAtLogin: true }).valid, true);
  assert.equal(validateIpcPayload('update-settings', { launchAtLogin: 'yes' }).valid, false);
});
