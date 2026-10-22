'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  isBoundsVisibleOnDisplays,
  resolveNoteBoundsForDisplays,
  calculateNewNoteBounds,
  compareBounds
} = require('../src/windows/geometry');
const {
  quoteDesktopExecArg,
  buildAutostartDesktopEntry,
  LinuxAutostartManager
} = require('../src/platform/linux-autostart');

const singleMonitor1080p = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 32, width: 1920, height: 1048 }
  }
];

const dualMonitors = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 32, width: 1920, height: 1048 }
  },
  {
    id: 2,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1440 }
  }
];

test('Geometry: keeps visible bounds untouched on active display', () => {
  const note = { x: 340, y: 220, width: 280, height: 260, unclampedBounds: null };
  const resolved = resolveNoteBoundsForDisplays(note, singleMonitor1080p);

  assert.equal(resolved.clamped, false);
  assert.deepEqual(resolved.bounds, { x: 340, y: 220, width: 280, height: 260 });
  assert.equal(resolved.unclampedBounds, null);
});

test('Geometry: clamps off-screen note to visible workArea and preserves unclampedBounds', () => {
  const offscreenNote = {
    x: 2400,
    y: 300,
    width: 300,
    height: 280,
    unclampedBounds: null
  };

  // On dual monitors, (2400, 300) is visible on display 2
  const onDual = resolveNoteBoundsForDisplays(offscreenNote, dualMonitors);
  assert.equal(onDual.clamped, false);
  assert.equal(onDual.displayId, 2);

  // When monitor 2 is disconnected, (2400, 300) is off-screen and must be clamped to display 1
  const onSingle = resolveNoteBoundsForDisplays(offscreenNote, singleMonitor1080p);
  assert.equal(onSingle.clamped, true);
  assert.equal(onSingle.displayId, 1);
  assert.equal(isBoundsVisibleOnDisplays(onSingle.bounds, singleMonitor1080p).visible, true);
  assert.deepEqual(onSingle.unclampedBounds, { x: 2400, y: 300, width: 300, height: 280 });

  // When monitor 2 is reconnected, the note restores its original unclampedBounds on display 2
  const noteAfterClamp = {
    ...onSingle.bounds,
    unclampedBounds: onSingle.unclampedBounds
  };
  const onReconnect = resolveNoteBoundsForDisplays(noteAfterClamp, dualMonitors);
  assert.equal(onReconnect.clamped, false);
  assert.equal(onReconnect.restoredOriginalMonitor, true);
  assert.equal(onReconnect.unclampedBounds, null);
  assert.deepEqual(onReconnect.bounds, { x: 2400, y: 300, width: 300, height: 280 });
});

test('Geometry: handles resolution reduction safely', () => {
  const noteAtBottomRight = { x: 1600, y: 780, width: 280, height: 260, unclampedBounds: null };
  const smallerDisplay = [
    {
      id: 1,
      workArea: { x: 0, y: 28, width: 1280, height: 692 }
    }
  ];

  const resolved = resolveNoteBoundsForDisplays(noteAtBottomRight, smallerDisplay);
  assert.equal(resolved.clamped, true);
  assert.equal(isBoundsVisibleOnDisplays(resolved.bounds, smallerDisplay).visible, true);
  assert.ok(resolved.bounds.x + resolved.bounds.width <= 1280);
  assert.ok(resolved.bounds.y + resolved.bounds.height <= 720);
});

test('Geometry: calculateNewNoteBounds cascades positions and stays inside workArea', () => {
  const b1 = calculateNewNoteBounds([], singleMonitor1080p);
  const b2 = calculateNewNoteBounds([b1], singleMonitor1080p);
  assert.notDeepEqual({ x: b1.x, y: b1.y }, { x: b2.x, y: b2.y });
  assert.equal(isBoundsVisibleOnDisplays(b1, singleMonitor1080p).visible, true);
  assert.equal(isBoundsVisibleOnDisplays(b2, singleMonitor1080p).visible, true);
});

test('Geometry: compareBounds detects exact match and compositor override beyond tolerance', () => {
  const req = { x: 400, y: 300, width: 280, height: 260 };
  const exact = compareBounds(req, { x: 400, y: 300, width: 280, height: 260 }, 10);
  assert.equal(exact.matched, true);

  const withinTol = compareBounds(req, { x: 404, y: 296, width: 280, height: 260 }, 10);
  assert.equal(withinTol.matched, true);

  const overridden = compareBounds(req, { x: 0, y: 0, width: 280, height: 260 }, 10);
  assert.equal(overridden.matched, false);
  assert.equal(overridden.positionMatched, false);
});

test('Autostart: quotes paths with spaces and special chars and generates XWayland Exec line', async () => {
  assert.equal(quoteDesktopExecArg('/usr/bin/spotnotes'), '/usr/bin/spotnotes');
  assert.equal(
    quoteDesktopExecArg('/home/user/My Apps/spotnotes'),
    '"/home/user/My Apps/spotnotes"'
  );

  const devEntry = buildAutostartDesktopEntry({
    isPackaged: false,
    execPath: '/opt/node/My Electron/electron',
    appPath: '/home/user/My Workspace/spotnotes'
  });

  assert.match(
    devEntry,
    /Exec="\/opt\/node\/My Electron\/electron" --no-sandbox --ozone-platform=x11 "\/home\/user\/My Workspace\/spotnotes"/
  );
  assert.match(devEntry, /X-GNOME-Autostart-enabled=true/);

  const packagedEntry = buildAutostartDesktopEntry({
    isPackaged: true,
    execPath: '/opt/spotnotes/spotnotes',
    preferSystemWrapper: false
  });
  assert.match(packagedEntry, /Exec=\/opt\/spotnotes\/spotnotes --no-sandbox --ozone-platform=x11/);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spotnotes-autostart-'));
  try {
    const manager = new LinuxAutostartManager({
      autostartDir: tmpDir,
      isPackaged: true,
      execPath: '/opt/spotnotes/spotnotes',
      preferSystemWrapper: false
    });

    assert.equal(await manager.isEnabled(), false);

    const enabledRes = await manager.enable();
    assert.equal(enabledRes.enabled, true);
    assert.equal(await manager.isEnabled(), true);
    assert.equal(fs.existsSync(manager.getDesktopFilePath()), true);

    // Calling enable again updates in-place without creating duplicate files
    await manager.enable();
    const files = await fsp.readdir(tmpDir);
    assert.deepEqual(files, ['spotnotes.desktop']);

    await manager.disable();
    assert.equal(await manager.isEnabled(), false);
    assert.equal(fs.existsSync(manager.getDesktopFilePath()), false);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
