'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');

async function copyDirRecursive(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(srcPath);
      await fsp.symlink(linkTarget, destPath);
    } else if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
      const stat = await fsp.stat(srcPath);
      await fsp.chmod(destPath, stat.mode);
    }
  }
}

async function buildDebPackage() {
  const rootDir = path.resolve(__dirname, '..');
  const electronDistDir = path.join(rootDir, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(electronDistDir)) {
    throw new Error(`Electron distribution not found at ${electronDistDir}. Run "npm install" first.`);
  }

  const distDir = path.join(rootDir, 'dist');
  const stageDir = path.join(distDir, 'deb-stage');
  const debFileName = `${pkg.name}_${pkg.version}_amd64.deb`;
  const debOutPath = path.join(distDir, debFileName);

  console.log('[build-deb] Cleaning staging directory...');
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  const optAppDir = path.join(stageDir, 'opt', 'spotnotes');
  const resourcesAppDir = path.join(optAppDir, 'resources', 'app');
  const usrBinDir = path.join(stageDir, 'usr', 'bin');
  const applicationsDir = path.join(stageDir, 'usr', 'share', 'applications');
  const icon128Dir = path.join(stageDir, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps');
  const iconSvgDir = path.join(stageDir, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps');
  const debianDir = path.join(stageDir, 'DEBIAN');

  await fsp.mkdir(optAppDir, { recursive: true });
  await fsp.mkdir(usrBinDir, { recursive: true });
  await fsp.mkdir(applicationsDir, { recursive: true });
  await fsp.mkdir(icon128Dir, { recursive: true });
  await fsp.mkdir(iconSvgDir, { recursive: true });
  await fsp.mkdir(debianDir, { recursive: true });

  console.log('[build-deb] Copying Electron runtime...');
  await copyDirRecursive(electronDistDir, optAppDir);

  // Rename electron binary to spotnotes inside /opt/spotnotes
  const electronBin = path.join(optAppDir, 'electron');
  const spotnotesBin = path.join(optAppDir, 'spotnotes');
  if (fs.existsSync(electronBin)) {
    await fsp.rename(electronBin, spotnotesBin);
    await fsp.chmod(spotnotesBin, 0o755);
  }

  // Remove default_app.asar if present
  const defaultAppAsar = path.join(optAppDir, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAppAsar)) {
    await fsp.rm(defaultAppAsar, { force: true });
  }

  console.log('[build-deb] Bundling SpotNotes application code...');
  await fsp.mkdir(resourcesAppDir, { recursive: true });
  await fsp.copyFile(path.join(rootDir, 'package.json'), path.join(resourcesAppDir, 'package.json'));
  await fsp.copyFile(path.join(rootDir, 'LICENSE'), path.join(resourcesAppDir, 'LICENSE'));
  await copyDirRecursive(path.join(rootDir, 'src'), path.join(resourcesAppDir, 'src'));
  await copyDirRecursive(path.join(rootDir, 'assets'), path.join(resourcesAppDir, 'assets'));

  // Create /usr/bin/spotnotes launcher script forcing X11/XWayland by default unless overridden
  const wrapperScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'OZONE_FLAG="--ozone-platform=x11"',
    'for arg in "$@"; do',
    '  if [[ "$arg" == --ozone-platform=* ]]; then',
    '    OZONE_FLAG=""',
    '  fi',
    'done',
    'if [[ -n "$OZONE_FLAG" ]]; then',
    '  exec /opt/spotnotes/spotnotes --no-sandbox "$OZONE_FLAG" "$@"',
    'else',
    '  exec /opt/spotnotes/spotnotes --no-sandbox "$@"',
    'fi',
    ''
  ].join('\n');

  const wrapperPath = path.join(usrBinDir, 'spotnotes');
  await fsp.writeFile(wrapperPath, wrapperScript, { encoding: 'utf8', mode: 0o755 });
  await fsp.chmod(wrapperPath, 0o755);

  // Copy desktop entry and icons
  await fsp.copyFile(
    path.join(rootDir, 'assets', 'spotnotes.desktop'),
    path.join(applicationsDir, 'spotnotes.desktop')
  );
  await fsp.copyFile(
    path.join(rootDir, 'assets', 'icon.png'),
    path.join(icon128Dir, 'spotnotes.png')
  );
  await fsp.copyFile(
    path.join(rootDir, 'assets', 'icon.svg'),
    path.join(iconSvgDir, 'spotnotes.svg')
  );

  // Create DEBIAN/control metadata
  const controlContent = [
    `Package: ${pkg.name}`,
    `Version: ${pkg.version}`,
    'Section: utils',
    'Priority: optional',
    'Architecture: amd64',
    'Maintainer: SpotNotes Contributors <maintainers@spotnotes.local>',
    'Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libx11-6, libxcomposite1, libxdamage1, libxrandr2, libgbm1',
    `Description: ${pkg.description}`,
    ' SpotNotes is a desktop sticky-notes application for Ubuntu GNOME Wayland',
    ' sessions using XWayland for verified window-position persistence.',
    ''
  ].join('\n');

  const controlPath = path.join(debianDir, 'control');
  await fsp.writeFile(controlPath, controlContent, { encoding: 'utf8', mode: 0o644 });

  console.log('[build-deb] Building Debian package via dpkg-deb...');
  execFileSync('dpkg-deb', ['-Zzstd', '-z3', '--build', '--root-owner-group', stageDir, debOutPath], {
    stdio: 'inherit'
  });

  // Clean staging folder to save disk space while keeping the unpacked app binary option if needed
  await fsp.rm(stageDir, { recursive: true, force: true });

  const stat = await fsp.stat(debOutPath);
  console.log(`[build-deb] Built ${debOutPath} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
}

buildDebPackage().catch((err) => {
  console.error('[build-deb] Failed:', err);
  process.exit(1);
});
