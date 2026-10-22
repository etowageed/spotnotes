'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const AUTOSTART_FILENAME = 'spotnotes.desktop';
const MANAGED_KEY = 'X-SpotNotes-Managed=true';

/**
 * Quote a single argument for a Desktop Entry Exec= line per XDG Desktop Entry Specification.
 * Characters that must be escaped inside double quotes: ", `, $, \
 */
function quoteDesktopExecArg(arg) {
  if (typeof arg !== 'string' || arg.length === 0) {
    return '""';
  }
  const needsQuotes = /[\s"'\\><~|&;$*?#()`]/.test(arg);
  if (!needsQuotes) {
    return arg;
  }
  const escaped = arg.replace(/(["`$\\])/g, '\\$1');
  return `"${escaped}"`;
}

function getDefaultAutostartDir(env = process.env, homeDir = os.homedir()) {
  if (env && typeof env.SPOTNOTES_AUTOSTART_DIR === 'string' && env.SPOTNOTES_AUTOSTART_DIR.trim()) {
    return path.resolve(env.SPOTNOTES_AUTOSTART_DIR.trim());
  }
  if (env && typeof env.XDG_CONFIG_HOME === 'string' && path.isAbsolute(env.XDG_CONFIG_HOME)) {
    return path.join(env.XDG_CONFIG_HOME, 'autostart');
  }
  return path.join(homeDir, '.config', 'autostart');
}

/**
 * Resolve the Exec command array for packaged vs development environments.
 */
function resolveAutostartCommand(options = {}) {
  const isPackaged = Boolean(options.isPackaged);
  const execPath = options.execPath || process.execPath;
  const appPath = options.appPath || path.resolve(__dirname, '..', '..');
  const env = options.env || process.env;

  if (!path.isAbsolute(execPath)) {
    throw new Error(`Executable path must be absolute, received: ${execPath}`);
  }

  // Packaged AppImage
  if (isPackaged && env && typeof env.APPIMAGE === 'string' && path.isAbsolute(env.APPIMAGE)) {
    return [env.APPIMAGE, '--ozone-platform=x11'];
  }

  // Packaged Debian / Linux installation (prefer /usr/bin/spotnotes wrapper if installed and executable)
  if (isPackaged) {
    const systemWrapper = options.systemWrapperPath || '/usr/bin/spotnotes';
    if (options.preferSystemWrapper !== false && fs.existsSync(systemWrapper)) {
      return [systemWrapper, '--ozone-platform=x11'];
    }
    return [execPath, '--no-sandbox', '--ozone-platform=x11'];
  }

  // Development mode: Electron binary + --no-sandbox + --ozone-platform=x11 + absolute project directory
  if (!path.isAbsolute(appPath)) {
    throw new Error(`Application path must be absolute in development mode, received: ${appPath}`);
  }
  return [execPath, '--no-sandbox', '--ozone-platform=x11', appPath];
}

/**
 * Generate the full contents of the XDG autostart .desktop entry.
 */
function buildAutostartDesktopEntry(options = {}) {
  const cmdArgs = resolveAutostartCommand(options);
  const execLine = cmdArgs.map(quoteDesktopExecArg).join(' ');
  const iconValue = options.iconPath && path.isAbsolute(options.iconPath)
    ? options.iconPath
    : 'spotnotes';

  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=SpotNotes',
    'GenericName=Sticky Notes',
    'Comment=Desktop sticky notes with persistent window positions',
    `Exec=${execLine}`,
    `Icon=${iconValue}`,
    'Terminal=false',
    'Categories=Utility;GTK;',
    'StartupNotify=false',
    'StartupWMClass=spotnotes',
    'X-GNOME-Autostart-enabled=true',
    MANAGED_KEY,
    ''
  ];

  return lines.join('\n');
}

class LinuxAutostartManager {
  constructor(options = {}) {
    this.autostartDir = options.autostartDir || getDefaultAutostartDir(options.env, options.homeDir);
    this.desktopFilePath = path.join(this.autostartDir, AUTOSTART_FILENAME);
    this.isPackaged = Boolean(options.isPackaged);
    this.execPath = options.execPath || process.execPath;
    this.appPath = options.appPath || path.resolve(__dirname, '..', '..');
    this.iconPath = options.iconPath || null;
    this.env = options.env || process.env;
    this.preferSystemWrapper = options.preferSystemWrapper;
    this.systemWrapperPath = options.systemWrapperPath;
  }

  getDesktopFilePath() {
    return this.desktopFilePath;
  }

  async isEnabled() {
    try {
      const content = await fsp.readFile(this.desktopFilePath, 'utf8');
      return (
        content.includes('[Desktop Entry]') &&
        !content.includes('X-GNOME-Autostart-enabled=false') &&
        !content.includes('Hidden=true')
      );
    } catch {
      return false;
    }
  }

  async enable() {
    await fsp.mkdir(this.autostartDir, { recursive: true });
    const content = buildAutostartDesktopEntry({
      isPackaged: this.isPackaged,
      execPath: this.execPath,
      appPath: this.appPath,
      iconPath: this.iconPath,
      env: this.env,
      preferSystemWrapper: this.preferSystemWrapper,
      systemWrapperPath: this.systemWrapperPath
    });

    const tmpPath = `${this.desktopFilePath}.tmp.${process.pid}`;
    await fsp.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o644 });
    await fsp.rename(tmpPath, this.desktopFilePath);
    return {
      enabled: true,
      desktopFilePath: this.desktopFilePath,
      content
    };
  }

  async disable() {
    try {
      const stat = await fsp.stat(this.desktopFilePath);
      if (stat.isFile()) {
        await fsp.unlink(this.desktopFilePath);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        throw err;
      }
    }
    return {
      enabled: false,
      desktopFilePath: this.desktopFilePath
    };
  }

  async sync(shouldEnable) {
    if (shouldEnable) {
      return this.enable();
    }
    return this.disable();
  }
}

module.exports = {
  AUTOSTART_FILENAME,
  MANAGED_KEY,
  quoteDesktopExecArg,
  getDefaultAutostartDir,
  resolveAutostartCommand,
  buildAutostartDesktopEntry,
  LinuxAutostartManager
};
