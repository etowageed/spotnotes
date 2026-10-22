'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const XID_REGEX = /^0x[0-9a-f]+$/i;

/**
 * Extract the integer X11 Window ID (XID) from Electron's BrowserWindow.getNativeWindowHandle() buffer.
 */
function parseNativeX11WindowId(handleBuffer) {
  if (!Buffer.isBuffer(handleBuffer) || handleBuffer.length < 4) {
    return null;
  }
  const xid = handleBuffer.readUInt32LE(0);
  if (!Number.isFinite(xid) || xid <= 0) {
    return null;
  }
  return `0x${xid.toString(16)}`;
}

/**
 * Inspect environment variables and command-line flags to determine the configured Ozone platform.
 */
function getRuntimeSessionDiagnostics(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const versions = options.versions || process.versions;

  const xdgSessionType = env.XDG_SESSION_TYPE || 'unknown';
  const waylandDisplay = env.WAYLAND_DISPLAY || null;
  const x11Display = env.DISPLAY || null;
  const desktop = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || 'unknown';
  const gdkBackend = env.GDK_BACKEND || null;
  const ozoneHintEnv = env.ELECTRON_OZONE_PLATFORM_HINT || null;

  let ozonePlatformArg = null;
  let ozonePlatformHintArg = null;
  for (const arg of argv) {
    if (typeof arg === 'string') {
      if (arg.startsWith('--ozone-platform=')) {
        ozonePlatformArg = arg.slice('--ozone-platform='.length);
      } else if (arg.startsWith('--ozone-platform-hint=')) {
        ozonePlatformHintArg = arg.slice('--ozone-platform-hint='.length);
      }
    }
  }

  const effectiveOzoneTarget = ozonePlatformArg || ozonePlatformHintArg || ozoneHintEnv || 'auto';
  const isWaylandSession = xdgSessionType.toLowerCase() === 'wayland' || Boolean(waylandDisplay);
  const xwaylandConfigured =
    effectiveOzoneTarget === 'x11' && Boolean(x11Display);

  return {
    electronVersion: versions.electron || null,
    chromeVersion: versions.chrome || null,
    nodeVersion: versions.node || null,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    xdgSessionType,
    waylandDisplay,
    x11Display,
    desktop,
    gdkBackend,
    ozonePlatformArg,
    ozonePlatformHintArg,
    ozoneHintEnv,
    effectiveOzoneTarget,
    isWaylandSession,
    xwaylandConfigured
  };
}

/**
 * Format Electron screen.getAllDisplays() into a clean diagnostic array.
 */
function getDisplaysSummary(screenApi) {
  if (!screenApi || typeof screenApi.getAllDisplays !== 'function') {
    return [];
  }
  try {
    const primary = typeof screenApi.getPrimaryDisplay === 'function'
      ? screenApi.getPrimaryDisplay()
      : null;
    const primaryId = primary ? primary.id : null;
    return screenApi.getAllDisplays().map((d) => ({
      id: d.id,
      primary: d.id === primaryId,
      scaleFactor: d.scaleFactor,
      bounds: d.bounds,
      workArea: d.workArea,
      rotation: d.rotation
    }));
  } catch {
    return [];
  }
}

/**
 * Use system tools (`xprop` and `xlsclients`) to verify whether a specific BrowserWindow
 * or the current Electron process is genuinely registered as an X11/XWayland client.
 */
async function verifyX11WindowClient(options = {}) {
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;
  let xidHex = null;

  if (typeof options.xidHex === 'string' && XID_REGEX.test(options.xidHex)) {
    xidHex = options.xidHex.toLowerCase();
  } else if (options.nativeHandleBuffer) {
    xidHex = parseNativeX11WindowId(options.nativeHandleBuffer);
  }

  const report = {
    xidHex,
    pid,
    xpropVerified: false,
    xlsclientsVerified: false,
    xwininfoVerified: false,
    isConfirmedX11Client: false,
    wmClass: null,
    x11Bounds: null,
    xpropOutput: null,
    error: null
  };

  // 1. If we have a valid native XID from BrowserWindow.getNativeWindowHandle(), query xprop -id <xid>
  let frameExtents = { left: 0, right: 0, top: 0, bottom: 0 };
  if (xidHex && XID_REGEX.test(xidHex)) {
    try {
      const { stdout } = await execFileAsync(
        'xprop',
        ['-id', xidHex, 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE', '_GTK_FRAME_EXTENTS'],
        { timeout: 2500 }
      );
      if (stdout && !stdout.includes('No such window')) {
        report.xpropOutput = stdout.trim();
        report.xpropVerified = true;
        const wmClassMatch = stdout.match(/WM_CLASS\(STRING\)\s*=\s*(.+)/);
        if (wmClassMatch) {
          report.wmClass = wmClassMatch[1].trim();
        }
        const extentsMatch = stdout.match(
          /_GTK_FRAME_EXTENTS\(CARDINAL\)\s*=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/
        );
        if (extentsMatch) {
          frameExtents = {
            left: Number.parseInt(extentsMatch[1], 10),
            right: Number.parseInt(extentsMatch[2], 10),
            top: Number.parseInt(extentsMatch[3], 10),
            bottom: Number.parseInt(extentsMatch[4], 10)
          };
        }
      }
    } catch (err) {
      report.error = `xprop query failed: ${err.message}`;
    }

    // Also query xwininfo -id <xid> for actual XServer/XWayland geometry on screen
    try {
      const { stdout: winInfoOut } = await execFileAsync(
        'xwininfo',
        ['-id', xidHex],
        { timeout: 2500 }
      );
      if (winInfoOut) {
        const absX = winInfoOut.match(/Absolute upper-left X:\s*(-?\d+)/);
        const absY = winInfoOut.match(/Absolute upper-left Y:\s*(-?\d+)/);
        const wMatch = winInfoOut.match(/Width:\s*(\d+)/);
        const hMatch = winInfoOut.match(/Height:\s*(\d+)/);
        if (absX && absY && wMatch && hMatch) {
          const rawX = Number.parseInt(absX[1], 10);
          const rawY = Number.parseInt(absY[1], 10);
          const rawW = Number.parseInt(wMatch[1], 10);
          const rawH = Number.parseInt(hMatch[1], 10);
          report.x11Bounds = {
            x: rawX + frameExtents.left,
            y: rawY + frameExtents.top,
            width: rawW - frameExtents.left - frameExtents.right,
            height: rawH - frameExtents.top - frameExtents.bottom
          };
          report.xwininfoVerified = true;
        }
      }
    } catch {
      // xwininfo is optional; ignore if unavailable
    }
  }

  // 2. Check xlsclients -l for this specific XID (or process name if no XID was provided)
  try {
    const { stdout } = await execFileAsync('xlsclients', ['-l'], { timeout: 2500 });
    if (stdout) {
      const lower = stdout.toLowerCase();
      if (xidHex) {
        if (lower.includes(xidHex.toLowerCase())) {
          report.xlsclientsVerified = true;
        }
      } else if (lower.includes('spotnotes')) {
        report.xlsclientsVerified = true;
      }
    }
  } catch (err) {
    if (!report.error) {
      report.error = `xlsclients query failed: ${err.message}`;
    }
  }

  report.isConfirmedX11Client = xidHex ? report.xpropVerified : report.xlsclientsVerified;
  return report;
}

module.exports = {
  parseNativeX11WindowId,
  getRuntimeSessionDiagnostics,
  getDisplaysSummary,
  verifyX11WindowClient
};
