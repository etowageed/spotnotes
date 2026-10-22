'use strict';

const crypto = require('node:crypto');

const CURRENT_SCHEMA_VERSION = 1;

const VALID_COLOURS = Object.freeze(['yellow', 'pink', 'blue', 'green', 'lavender']);
const DEFAULT_COLOUR = 'yellow';

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 260;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 160;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const MIN_COORD = -32768;
const MAX_COORD = 32768;
const MAX_TEXT_LENGTH = 100000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id) {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

function isValidColour(colour) {
  return typeof colour === 'string' && VALID_COLOURS.includes(colour);
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length < 10) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function isFiniteInteger(val) {
  return typeof val === 'number' && Number.isFinite(val);
}

function clampDimension(value, min, max, fallback) {
  if (!isFiniteInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeCoordinate(value, fallback = null) {
  if (!isFiniteInteger(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < MIN_COORD || rounded > MAX_COORD) {
    return fallback;
  }
  return rounded;
}

function validateBoundsObject(bounds) {
  if (!bounds || typeof bounds !== 'object') {
    return null;
  }
  const x = normalizeCoordinate(bounds.x, null);
  const y = normalizeCoordinate(bounds.y, null);
  const width = clampDimension(bounds.width, MIN_WIDTH, MAX_WIDTH, null);
  const height = clampDimension(bounds.height, MIN_HEIGHT, MAX_HEIGHT, null);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  return { x, y, width, height };
}

function createDefaultNote(overrides = {}) {
  const now = new Date().toISOString();
  const id = isValidUuid(overrides.id) ? overrides.id.toLowerCase() : crypto.randomUUID();
  const text = typeof overrides.text === 'string'
    ? overrides.text.slice(0, MAX_TEXT_LENGTH)
    : '';
  const colour = isValidColour(overrides.colour) ? overrides.colour : DEFAULT_COLOUR;
  const x = normalizeCoordinate(overrides.x, 120);
  const y = normalizeCoordinate(overrides.y, 120);
  const width = clampDimension(overrides.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH);
  const height = clampDimension(overrides.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT);
  const alwaysOnTop = Boolean(overrides.alwaysOnTop);
  const isOpen = overrides.isOpen === undefined ? true : Boolean(overrides.isOpen);
  const unclampedBounds = validateBoundsObject(overrides.unclampedBounds);
  const createdAt = isValidIsoTimestamp(overrides.createdAt) ? overrides.createdAt : now;
  const updatedAt = isValidIsoTimestamp(overrides.updatedAt) ? overrides.updatedAt : now;

  return {
    id,
    text,
    colour,
    x,
    y,
    width,
    height,
    alwaysOnTop,
    isOpen,
    unclampedBounds,
    createdAt,
    updatedAt
  };
}

function validateNote(rawNote) {
  if (!rawNote || typeof rawNote !== 'object' || Array.isArray(rawNote)) {
    return { valid: false, error: 'Note must be a plain object' };
  }
  if (!isValidUuid(rawNote.id)) {
    return { valid: false, error: `Invalid note UUID: ${String(rawNote.id)}` };
  }
  if (typeof rawNote.text !== 'string') {
    return { valid: false, error: `Invalid text for note ${rawNote.id}` };
  }
  if (rawNote.text.length > MAX_TEXT_LENGTH) {
    return { valid: false, error: `Note text exceeds maximum length (${MAX_TEXT_LENGTH})` };
  }
  if (!isValidColour(rawNote.colour)) {
    return { valid: false, error: `Invalid colour "${String(rawNote.colour)}" for note ${rawNote.id}` };
  }
  const x = normalizeCoordinate(rawNote.x, null);
  const y = normalizeCoordinate(rawNote.y, null);
  if (x === null || y === null) {
    return { valid: false, error: `Invalid coordinates (x=${rawNote.x}, y=${rawNote.y}) for note ${rawNote.id}` };
  }
  if (!isFiniteInteger(rawNote.width) || !isFiniteInteger(rawNote.height)) {
    return { valid: false, error: `Invalid dimensions (width=${rawNote.width}, height=${rawNote.height}) for note ${rawNote.id}` };
  }
  if (typeof rawNote.alwaysOnTop !== 'boolean') {
    return { valid: false, error: `Invalid alwaysOnTop flag for note ${rawNote.id}` };
  }
  if (!isValidIsoTimestamp(rawNote.createdAt) || !isValidIsoTimestamp(rawNote.updatedAt)) {
    return { valid: false, error: `Invalid timestamps for note ${rawNote.id}` };
  }

  const normalized = {
    id: rawNote.id.toLowerCase(),
    text: rawNote.text,
    colour: rawNote.colour,
    x,
    y,
    width: clampDimension(rawNote.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH),
    height: clampDimension(rawNote.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT),
    alwaysOnTop: rawNote.alwaysOnTop,
    isOpen: rawNote.isOpen === undefined ? true : Boolean(rawNote.isOpen),
    unclampedBounds: validateBoundsObject(rawNote.unclampedBounds),
    createdAt: rawNote.createdAt,
    updatedAt: rawNote.updatedAt
  };

  return { valid: true, note: normalized };
}

function createDefaultSettings(overrides = {}) {
  return {
    launchAtLogin: Boolean(overrides && overrides.launchAtLogin)
  };
}

function createDefaultStoreData() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    notes: [],
    settings: createDefaultSettings()
  };
}

function validateStoreData(rawData) {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return { valid: false, error: 'Root store data must be a JSON object' };
  }
  if (rawData.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `Unsupported schemaVersion: ${String(rawData.schemaVersion)} (expected ${CURRENT_SCHEMA_VERSION})`
    };
  }
  if (!Array.isArray(rawData.notes)) {
    return { valid: false, error: 'Store "notes" field must be an array' };
  }
  if (!rawData.settings || typeof rawData.settings !== 'object' || Array.isArray(rawData.settings)) {
    return { valid: false, error: 'Store "settings" field must be an object' };
  }
  if (typeof rawData.settings.launchAtLogin !== 'boolean') {
    return { valid: false, error: 'Store "settings.launchAtLogin" must be a boolean' };
  }

  const seenIds = new Set();
  const validatedNotes = [];

  for (let i = 0; i < rawData.notes.length; i += 1) {
    const result = validateNote(rawData.notes[i]);
    if (!result.valid) {
      return { valid: false, error: `Invalid note at index ${i}: ${result.error}` };
    }
    if (seenIds.has(result.note.id)) {
      return { valid: false, error: `Duplicate note UUID detected: ${result.note.id}` };
    }
    seenIds.add(result.note.id);
    validatedNotes.push(result.note);
  }

  return {
    valid: true,
    data: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      notes: validatedNotes,
      settings: {
        launchAtLogin: rawData.settings.launchAtLogin
      }
    }
  };
}

function validateIpcPayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'IPC payload must be an object' };
  }

  switch (type) {
    case 'update-text': {
      if (!isValidUuid(payload.id)) {
        return { valid: false, error: 'Invalid note ID' };
      }
      if (typeof payload.text !== 'string') {
        return { valid: false, error: 'Text must be a string' };
      }
      if (payload.text.length > MAX_TEXT_LENGTH) {
        return { valid: false, error: `Text exceeds max length of ${MAX_TEXT_LENGTH}` };
      }
      return { valid: true, value: { id: payload.id.toLowerCase(), text: payload.text } };
    }
    case 'update-colour': {
      if (!isValidUuid(payload.id)) {
        return { valid: false, error: 'Invalid note ID' };
      }
      if (!isValidColour(payload.colour)) {
        return { valid: false, error: 'Invalid note colour' };
      }
      return { valid: true, value: { id: payload.id.toLowerCase(), colour: payload.colour } };
    }
    case 'toggle-pin': {
      if (!isValidUuid(payload.id)) {
        return { valid: false, error: 'Invalid note ID' };
      }
      if (typeof payload.alwaysOnTop !== 'boolean') {
        return { valid: false, error: 'alwaysOnTop must be a boolean' };
      }
      return {
        valid: true,
        value: { id: payload.id.toLowerCase(), alwaysOnTop: payload.alwaysOnTop }
      };
    }
    case 'note-id': {
      if (!isValidUuid(payload.id)) {
        return { valid: false, error: 'Invalid note ID' };
      }
      return { valid: true, value: { id: payload.id.toLowerCase() } };
    }
    case 'update-settings': {
      if (typeof payload.launchAtLogin !== 'boolean') {
        return { valid: false, error: 'launchAtLogin must be a boolean' };
      }
      return { valid: true, value: { launchAtLogin: payload.launchAtLogin } };
    }
    default:
      return { valid: false, error: `Unknown IPC validation type: ${String(type)}` };
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  VALID_COLOURS,
  DEFAULT_COLOUR,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  MIN_COORD,
  MAX_COORD,
  MAX_TEXT_LENGTH,
  isValidUuid,
  isValidColour,
  isValidIsoTimestamp,
  clampDimension,
  normalizeCoordinate,
  validateBoundsObject,
  createDefaultNote,
  validateNote,
  createDefaultSettings,
  createDefaultStoreData,
  validateStoreData,
  validateIpcPayload
};
