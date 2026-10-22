'use strict';

const {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  clampDimension,
  normalizeCoordinate
} = require('../persistence/schema');

const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 48;
const DEFAULT_POSITION_TOLERANCE_PX = 16;

function getDisplayWorkArea(display) {
  if (!display || typeof display !== 'object') {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
  const area = display.workArea && typeof display.workArea === 'object'
    ? display.workArea
    : display.bounds;

  if (!area || typeof area !== 'object') {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }

  return {
    x: Number.isFinite(area.x) ? Math.round(area.x) : 0,
    y: Number.isFinite(area.y) ? Math.round(area.y) : 0,
    width: Number.isFinite(area.width) && area.width > 0 ? Math.round(area.width) : 1920,
    height: Number.isFinite(area.height) && area.height > 0 ? Math.round(area.height) : 1080
  };
}

function normalizeDisplays(displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return [{ id: 'fallback', workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  }
  return displays.map((d, idx) => ({
    id: d && d.id !== undefined ? d.id : idx,
    workArea: getDisplayWorkArea(d)
  }));
}

function getIntersectionRect(rectA, rectB) {
  const left = Math.max(rectA.x, rectB.x);
  const top = Math.max(rectA.y, rectB.y);
  const right = Math.min(rectA.x + rectA.width, rectB.x + rectB.width);
  const bottom = Math.min(rectA.y + rectA.height, rectB.y + rectB.height);

  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { x: left, y: top, width, height, area: width * height };
}

/**
 * Check whether the note's bounds (and specifically its top drag bar region) are sufficiently
 * visible on at least one connected display's workArea.
 */
function isBoundsVisibleOnDisplays(bounds, displays) {
  const normDisplays = normalizeDisplays(displays);
  const headerRect = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.min(bounds.height, MIN_VISIBLE_HEIGHT)
  };

  for (const disp of normDisplays) {
    const bodyOverlap = getIntersectionRect(bounds, disp.workArea);
    const headerOverlap = getIntersectionRect(headerRect, disp.workArea);
    const minVisibleW = Math.min(MIN_VISIBLE_WIDTH, bounds.width);
    const minVisibleH = Math.min(MIN_VISIBLE_HEIGHT, bounds.height);

    if (
      bodyOverlap.width >= minVisibleW &&
      bodyOverlap.height >= minVisibleH &&
      headerOverlap.width >= minVisibleW &&
      headerOverlap.height >= Math.min(28, bounds.height)
    ) {
      return { visible: true, display: disp };
    }
  }

  return { visible: false, display: null };
}

function findNearestDisplay(bounds, displays) {
  const normDisplays = normalizeDisplays(displays);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  let bestDisplay = normDisplays[0];
  let bestDistanceSq = Infinity;

  for (const disp of normDisplays) {
    const wa = disp.workArea;
    const clampedX = Math.max(wa.x, Math.min(centerX, wa.x + wa.width));
    const clampedY = Math.max(wa.y, Math.min(centerY, wa.y + wa.height));
    const dx = centerX - clampedX;
    const dy = centerY - clampedY;
    const distSq = dx * dx + dy * dy;

    if (distSq < bestDistanceSq) {
      bestDistanceSq = distSq;
      bestDisplay = disp;
    }
  }

  return bestDisplay;
}

function clampBoundsToWorkArea(bounds, workArea) {
  const margin = 12;
  const maxAllowedWidth = Math.max(MIN_WIDTH, workArea.width - margin * 2);
  const maxAllowedHeight = Math.max(MIN_HEIGHT, workArea.height - margin * 2);

  const width = clampDimension(bounds.width, MIN_WIDTH, Math.min(MAX_WIDTH, maxAllowedWidth), DEFAULT_WIDTH);
  const height = clampDimension(bounds.height, MIN_HEIGHT, Math.min(MAX_HEIGHT, maxAllowedHeight), DEFAULT_HEIGHT);

  const minX = workArea.x;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
  const minY = workArea.y;
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);

  const x = Math.max(minX, Math.min(maxX, Math.round(bounds.x)));
  const y = Math.max(minY, Math.min(maxY, Math.round(bounds.y)));

  return { x, y, width, height };
}

/**
 * Resolve the target window bounds for a saved note given the current displays.
 * - If the note had `unclampedBounds` from an earlier disconnected monitor and that monitor is now
 *   back online, restores `unclampedBounds`.
 * - If the saved bounds are visible on a current display, returns them unchanged.
 * - If the saved bounds are off-screen (e.g., monitor disconnected or resolution shrunk),
 *   clamps them into the nearest display's workArea and preserves `unclampedBounds`.
 */
function resolveNoteBoundsForDisplays(note, displays) {
  const rawBounds = {
    x: normalizeCoordinate(note.x, 120),
    y: normalizeCoordinate(note.y, 120),
    width: clampDimension(note.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH),
    height: clampDimension(note.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT)
  };

  if (note.unclampedBounds && typeof note.unclampedBounds === 'object') {
    const candidateOriginal = {
      x: normalizeCoordinate(note.unclampedBounds.x, rawBounds.x),
      y: normalizeCoordinate(note.unclampedBounds.y, rawBounds.y),
      width: clampDimension(note.unclampedBounds.width, MIN_WIDTH, MAX_WIDTH, rawBounds.width),
      height: clampDimension(note.unclampedBounds.height, MIN_HEIGHT, MAX_HEIGHT, rawBounds.height)
    };
    const originalCheck = isBoundsVisibleOnDisplays(candidateOriginal, displays);
    if (originalCheck.visible) {
      return {
        bounds: candidateOriginal,
        clamped: false,
        restoredOriginalMonitor: true,
        unclampedBounds: null,
        displayId: originalCheck.display.id,
        reason: 'Restored original bounds after monitor reconnected'
      };
    }
  }

  const currentCheck = isBoundsVisibleOnDisplays(rawBounds, displays);
  if (currentCheck.visible) {
    return {
      bounds: rawBounds,
      clamped: false,
      restoredOriginalMonitor: false,
      unclampedBounds: note.unclampedBounds || null,
      displayId: currentCheck.display.id,
      reason: 'Saved bounds are visible on active display'
    };
  }

  const nearestDisplay = findNearestDisplay(rawBounds, displays);
  const clampedBounds = clampBoundsToWorkArea(rawBounds, nearestDisplay.workArea);
  const preservedUnclamped = note.unclampedBounds || rawBounds;

  return {
    bounds: clampedBounds,
    clamped: true,
    restoredOriginalMonitor: false,
    unclampedBounds: preservedUnclamped,
    displayId: nearestDisplay.id,
    reason: `Saved bounds (${rawBounds.x},${rawBounds.y} ${rawBounds.width}x${rawBounds.height}) were outside available displays; clamped to display ${nearestDisplay.id}`
  };
}

/**
 * Compute initial cascaded position for a newly created note.
 */
function calculateNewNoteBounds(existingNotes = [], displays = [], anchorBounds = null) {
  const normDisplays = normalizeDisplays(displays);
  const primaryWorkArea = normDisplays[0].workArea;
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const step = 34;

  let baseX = primaryWorkArea.x + 80;
  let baseY = primaryWorkArea.y + 80;

  if (anchorBounds && Number.isFinite(anchorBounds.x) && Number.isFinite(anchorBounds.y)) {
    baseX = anchorBounds.x + step;
    baseY = anchorBounds.y + step;
  } else if (existingNotes.length > 0) {
    const offsetIndex = existingNotes.length % 10;
    baseX = primaryWorkArea.x + 80 + offsetIndex * step;
    baseY = primaryWorkArea.y + 80 + offsetIndex * step;
  }

  // Avoid exact overlap with any existing note
  let candidate = { x: baseX, y: baseY, width, height };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const collides = existingNotes.some(
      (n) => Math.abs((n.x || 0) - candidate.x) < 16 && Math.abs((n.y || 0) - candidate.y) < 16
    );
    if (!collides) break;
    candidate = {
      x: candidate.x + step,
      y: candidate.y + step,
      width,
      height
    };
  }

  const targetDisplay = findNearestDisplay(candidate, normDisplays);
  return clampBoundsToWorkArea(candidate, targetDisplay.workArea);
}

/**
 * Compare requested bounds against observed window bounds to detect compositor overrides.
 */
function compareBounds(requested, observed, tolerancePx = DEFAULT_POSITION_TOLERANCE_PX) {
  if (!requested || !observed) {
    return {
      matched: false,
      positionMatched: false,
      sizeMatched: false,
      reason: 'Missing requested or observed bounds'
    };
  }

  const deltaX = Math.abs(Math.round(observed.x) - Math.round(requested.x));
  const deltaY = Math.abs(Math.round(observed.y) - Math.round(requested.y));
  const deltaWidth = Math.abs(Math.round(observed.width) - Math.round(requested.width));
  const deltaHeight = Math.abs(Math.round(observed.height) - Math.round(requested.height));
  const maxPositionDelta = Math.max(deltaX, deltaY);
  const maxSizeDelta = Math.max(deltaWidth, deltaHeight);

  const positionMatched = deltaX <= tolerancePx && deltaY <= tolerancePx;
  const sizeMatched = deltaWidth <= tolerancePx && deltaHeight <= tolerancePx;
  const matched = positionMatched && sizeMatched;

  return {
    matched,
    positionMatched,
    sizeMatched,
    deltaX,
    deltaY,
    deltaWidth,
    deltaHeight,
    maxPositionDelta,
    maxSizeDelta,
    tolerancePx,
    reason: matched
      ? 'Observed bounds match requested bounds within tolerance'
      : `Bounds mismatch: requested (${requested.x},${requested.y} ${requested.width}x${requested.height}), observed (${observed.x},${observed.y} ${observed.width}x${observed.height})`
  };
}

module.exports = {
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  DEFAULT_POSITION_TOLERANCE_PX,
  getDisplayWorkArea,
  normalizeDisplays,
  getIntersectionRect,
  isBoundsVisibleOnDisplays,
  findNearestDisplay,
  clampBoundsToWorkArea,
  resolveNoteBoundsForDisplays,
  calculateNewNoteBounds,
  compareBounds
};
