'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { NoteStore } = require('../src/persistence/store');

const ROOT_DIR = path.resolve(__dirname, '..');
const ELECTRON_BIN = path.join(ROOT_DIR, 'node_modules', '.bin', 'electron');

function runElectronSession({
  userDataDir,
  autostartDir,
  diagFile,
  ozonePlatform = 'x11',
  integrationOps = null,
  autoQuitMs = 900
}) {
  return new Promise((resolve, reject) => {
    const args = ['--no-sandbox', `--ozone-platform=${ozonePlatform}`, ROOT_DIR];
    const env = {
      ...process.env,
      SPOTNOTES_USER_DATA_DIR: userDataDir,
      SPOTNOTES_AUTOSTART_DIR: autostartDir,
      SPOTNOTES_DIAGNOSTIC_FILE: diagFile,
      SPOTNOTES_AUTO_QUIT_MS: String(autoQuitMs)
    };
    if (integrationOps) {
      env.SPOTNOTES_INTEGRATION_OPS = JSON.stringify(integrationOps);
    } else {
      delete env.SPOTNOTES_INTEGRATION_OPS;
    }

    const child = spawn(ELECTRON_BIN, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      let diag = null;
      if (diagFile && fs.existsSync(diagFile)) {
        try {
          diag = JSON.parse(fs.readFileSync(diagFile, 'utf8'));
        } catch {
          diag = null;
        }
      }
      resolve({ code, stdout, stderr, diag });
    });
  });
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spotnotes-integration-'));
  const userDataDir = path.join(workDir, 'userData');
  const autostartDir = path.join(workDir, 'autostart');
  await fsp.mkdir(userDataDir, { recursive: true });
  await fsp.mkdir(autostartDir, { recursive: true });

  console.log('======================================================================');
  console.log('SpotNotes — Ubuntu 26.04 GNOME Wayland / XWayland Verification Suite');
  console.log('======================================================================');

  try {
    // Seed 3 distinct notes at distinct screen locations, sizes, and colours (Steps 1 & 2)
    const seedStore = new NoteStore({ userDataDir });
    await seedStore.load();

    const noteA = seedStore.createNote({
      text: 'Alpha Note: Project architecture review',
      colour: 'yellow',
      x: 160,
      y: 140,
      width: 280,
      height: 260,
      alwaysOnTop: false
    });
    const noteB = seedStore.createNote({
      text: 'Bravo Note: XWayland Ozone positioning check',
      colour: 'pink',
      x: 520,
      y: 220,
      width: 320,
      height: 290,
      alwaysOnTop: false
    });
    const noteC = seedStore.createNote({
      text: 'Charlie Note: Atomic JSON persistence test',
      colour: 'blue',
      x: 880,
      y: 300,
      width: 350,
      height: 310,
      alwaysOnTop: false
    });
    await seedStore.flush();

    // Phase 0: Empirical check of Native Wayland (--ozone-platform=wayland) vs XWayland (--ozone-platform=x11)
    console.log('\n[Phase 0] Comparing Native Wayland (--ozone-platform=wayland) vs XWayland (--ozone-platform=x11)...');
    const waylandDiagPath = path.join(workDir, 'diag-wayland.json');
    const waylandRun = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: waylandDiagPath,
      ozonePlatform: 'wayland',
      autoQuitMs: 800
    });

    if (waylandRun.diag) {
      const wSummary = waylandRun.diag.restoreSummary;
      console.log(
        `  -> Native Wayland (--ozone-platform=wayland): ` +
        `verified=${wSummary.verifiedCount}/${wSummary.totalRestored}, ` +
        `overridden=${wSummary.overriddenCount}`
      );
      for (const r of wSummary.reports) {
        console.log(
          `     Note ${r.noteId.slice(0, 8)}: requested=(${r.requestedBounds.x},${r.requestedBounds.y}) ` +
          `observed=(${r.observedBounds.x},${r.observedBounds.y}) matched=${r.matched} x11Confirmed=${r.x11ClientConfirmed}`
        );
      }
    }

    // Re-seed clean coordinates before XWayland verification because native Wayland reports (0,0)
    seedStore.updateNoteGeometry(noteA.id, { x: 160, y: 140, width: 280, height: 260 }, { immediate: true, forceUnlock: true });
    seedStore.updateNoteGeometry(noteB.id, { x: 520, y: 220, width: 320, height: 290 }, { immediate: true, forceUnlock: true });
    seedStore.updateNoteGeometry(noteC.id, { x: 880, y: 300, width: 350, height: 310 }, { immediate: true, forceUnlock: true });
    await seedStore.flush();

    // Step 1, 2 & 3: Launch under XWayland (--ozone-platform=x11), verify initial positions, then move & resize all 3 notes
    console.log('\n[Steps 1-3] Launching under XWayland (--ozone-platform=x11), verifying 3 notes & moving/resizing...');
    const movedBoundsA = { x: 210, y: 190, width: 300, height: 270 };
    const movedBoundsB = { x: 580, y: 260, width: 340, height: 300 };
    const movedBoundsC = { x: 940, y: 340, width: 360, height: 320 };

    const step3DiagPath = path.join(workDir, 'diag-step3.json');
    const step3Run = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step3DiagPath,
      ozonePlatform: 'x11',
      integrationOps: [
        { type: 'move-resize', id: noteA.id, bounds: movedBoundsA },
        { type: 'move-resize', id: noteB.id, bounds: movedBoundsB },
        { type: 'move-resize', id: noteC.id, bounds: movedBoundsC }
      ],
      autoQuitMs: 600
    });

    assert.ok(step3Run.diag, 'Expected diagnostic report from Step 3 XWayland launch');
    console.log(`  Session: XDG_SESSION_TYPE=${step3Run.diag.session.xdgSessionType}, DISPLAY=${step3Run.diag.session.x11Display}, Electron=${step3Run.diag.session.electronVersion}`);
    console.log(`  Displays: ${JSON.stringify(step3Run.diag.displays)}`);
    for (const r of step3Run.diag.restoreSummary.reports) {
      console.log(
        `  Step 3 report [${r.noteId.slice(0, 8)}]: ` +
        `requested=(${r.requestedBounds.x},${r.requestedBounds.y} ${r.requestedBounds.width}x${r.requestedBounds.height}) ` +
        `observed=(${r.observedBounds.x},${r.observedBounds.y} ${r.observedBounds.width}x${r.observedBounds.height}) ` +
        `matched=${r.matched} x11Confirmed=${r.x11ClientConfirmed} XID=${r.x11WindowId} reason=${r.reason}`
      );
    }
    assert.equal(step3Run.diag.restoreSummary.verifiedCount, 3, 'All 3 initial notes must be position-verified under XWayland');
    for (const r of step3Run.diag.restoreSummary.reports) {
      assert.equal(r.x11ClientConfirmed, true, `Note ${r.noteId} must be confirmed X11/XWayland client via xprop/xlsclients`);
    }

    // Step 4, 5, 6, 7 & 8: Restart application, verify moved/resized positions, enable launch-at-login, and toggle always-on-top on Note A
    console.log('\n[Steps 4-8] Restarting application, verifying moved/resized positions, enabling autostart & pinning Note A...');
    const step5DiagPath = path.join(workDir, 'diag-step5.json');
    const step5Run = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step5DiagPath,
      ozonePlatform: 'x11',
      integrationOps: [
        { type: 'enable-autostart', enabled: true },
        { type: 'toggle-pin', id: noteA.id, alwaysOnTop: true }
      ],
      autoQuitMs: 600
    });

    assert.ok(step5Run.diag, 'Expected diagnostic report from Step 5 restart');
    assert.equal(step5Run.diag.restoreSummary.totalRestored, 3);
    assert.equal(step5Run.diag.restoreSummary.verifiedCount, 3);

    const expectedMap = new Map([
      [noteA.id, { bounds: movedBoundsA, colour: 'yellow', text: noteA.text }],
      [noteB.id, { bounds: movedBoundsB, colour: 'pink', text: noteB.text }],
      [noteC.id, { bounds: movedBoundsC, colour: 'blue', text: noteC.text }]
    ]);

    for (const r of step5Run.diag.restoreSummary.reports) {
      const exp = expectedMap.get(r.noteId);
      assert.deepEqual(r.requestedBounds, exp.bounds);
      assert.equal(r.matched, true, `Note ${r.noteId} must restore to moved/resized position within tolerance`);
      console.log(
        `  Restored after move/resize [${r.noteId.slice(0, 8)}]: ` +
        `requested=(${r.requestedBounds.x},${r.requestedBounds.y} ${r.requestedBounds.width}x${r.requestedBounds.height}) ` +
        `observed=(${r.observedBounds.x},${r.observedBounds.y} ${r.observedBounds.width}x${r.observedBounds.height})`
      );
    }

    // Verify autostart .desktop entry was created with --ozone-platform=x11
    assert.equal(step5Run.diag.autostartFileExists, true);
    const desktopContent = await fsp.readFile(step5Run.diag.autostartDesktopPath, 'utf8');
    assert.match(desktopContent, /--ozone-platform=x11/);
    console.log(`  Verified XDG autostart file created at ${step5Run.diag.autostartDesktopPath}`);

    // Verify Always-on-Top state and X11 _NET_WM_STATE_ABOVE on live window
    const liveNoteA = step5Run.diag.liveWindows.find((w) => w.noteId === noteA.id);
    assert.ok(liveNoteA && liveNoteA.alwaysOnTop === true, 'Note A must have alwaysOnTop=true');
    console.log(`  Verified Note A Always-on-Top: alwaysOnTop=${liveNoteA.alwaysOnTop}, xprop=${liveNoteA.x11 ? liveNoteA.x11.xpropOutput.replace(/\n/g, ' | ') : 'n/a'}`);

    // Step 9: Close Note C window without deleting it, then restart and verify Note C is preserved and restored
    console.log('\n[Step 9] Closing Note C window without deleting it and verifying restoration behaviour...');
    const step9CloseDiagPath = path.join(workDir, 'diag-step9-close.json');
    const step9CloseRun = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step9CloseDiagPath,
      ozonePlatform: 'x11',
      integrationOps: [
        { type: 'close-window', id: noteC.id }
      ],
      autoQuitMs: 500
    });
    assert.equal(step9CloseRun.diag.liveWindows.length, 2, '2 windows remain open after closing Note C');
    const persistedAfterClose = step9CloseRun.diag.persistedNotes.find((n) => n.id === noteC.id);
    assert.ok(persistedAfterClose, 'Closed Note C must still exist in notes.json');
    assert.equal(persistedAfterClose.isOpen, false, 'Closed Note C has isOpen=false in notes.json');

    // Relaunch and verify Note C is restored alongside Notes A and B, and Note A still has alwaysOnTop=true
    const step9RestoreDiagPath = path.join(workDir, 'diag-step9-restore.json');
    const step9RestoreRun = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step9RestoreDiagPath,
      ozonePlatform: 'x11',
      autoQuitMs: 500
    });
    assert.equal(step9RestoreRun.diag.restoreSummary.totalRestored, 3, 'All 3 non-deleted notes restored on relaunch');
    assert.equal(step9RestoreRun.diag.restoreSummary.verifiedCount, 3);
    const restoredNoteA = step9RestoreRun.diag.persistedNotes.find((n) => n.id === noteA.id);
    assert.equal(restoredNoteA.alwaysOnTop, true, 'Note A alwaysOnTop state persisted across restart');
    console.log('  Verified closed Note C preserved its contents and restored on relaunch; Note A kept alwaysOnTop=true.');

    // Step 10: Delete Note C permanently and verify it does NOT reappear after restart
    console.log('\n[Step 10] Deleting Note C and verifying it does not reappear on restart...');
    const step10DelDiagPath = path.join(workDir, 'diag-step10-del.json');
    await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step10DelDiagPath,
      ozonePlatform: 'x11',
      integrationOps: [
        { type: 'delete-note', id: noteC.id }
      ],
      autoQuitMs: 500
    });

    const step10RestartDiagPath = path.join(workDir, 'diag-step10-restart.json');
    const step10RestartRun = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step10RestartDiagPath,
      ozonePlatform: 'x11',
      autoQuitMs: 500
    });
    assert.equal(step10RestartRun.diag.restoreSummary.totalRestored, 2, 'Only 2 notes remain after deleting Note C');
    assert.equal(
      step10RestartRun.diag.persistedNotes.some((n) => n.id === noteC.id),
      false,
      'Deleted Note C must not reappear'
    );
    console.log('  Verified deleted Note C did not reappear.');

    // Step 11: Simulate off-screen coordinates from a disconnected monitor (x=4200, y=2200) and verify clamping + original position preservation
    console.log('\n[Step 11] Testing off-screen monitor bounds clamping and original position preservation...');
    const storeStep11 = new NoteStore({ userDataDir });
    await storeStep11.load();
    storeStep11.updateNoteGeometry(noteB.id, { x: 4200, y: 2200, width: 340, height: 300 }, {
      immediate: true,
      forceUnlock: true
    });
    await storeStep11.flush();

    const step11DiagPath = path.join(workDir, 'diag-step11.json');
    const step11Run = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step11DiagPath,
      ozonePlatform: 'x11',
      autoQuitMs: 500
    });
    const reportB = step11Run.diag.restoreSummary.reports.find((r) => r.noteId === noteB.id);
    assert.equal(reportB.clampedForDisplay, true, 'Off-screen Note B must be clamped to active display');
    assert.equal(reportB.matched, true, 'Clamped Note B must be verified at its visible clamped position');
    const persistedB = step11Run.diag.persistedNotes.find((n) => n.id === noteB.id);
    assert.deepEqual(
      persistedB.unclampedBounds,
      { x: 4200, y: 2200, width: 340, height: 300 },
      'Original off-screen bounds must be preserved in unclampedBounds'
    );
    console.log(
      `  Verified off-screen Note B (4200,2200) clamped to (${reportB.observedBounds.x},${reportB.observedBounds.y}) ` +
      `with unclampedBounds=(${persistedB.unclampedBounds.x},${persistedB.unclampedBounds.y}) preserved.`
    );

    // Step 12 & 13: Corrupt notes.json and verify app recovers from backup without erasing user data, then quits and relaunches cleanly
    console.log('\n[Steps 12-13] Corrupting notes.json and verifying safe backup recovery and clean relaunch...');
    const notesJsonPath = path.join(userDataDir, 'notes.json');
    await fsp.writeFile(notesJsonPath, '{ CORRUPTED JSON FILE ', 'utf8');

    const step12DiagPath = path.join(workDir, 'diag-step12.json');
    const step12Run = await runElectronSession({
      userDataDir,
      autostartDir,
      diagFile: step12DiagPath,
      ozonePlatform: 'x11',
      autoQuitMs: 500
    });
    assert.equal(step12Run.diag.loadStatus.status, 'recovered_from_backup');
    assert.equal(step12Run.diag.loadStatus.recovered, true);
    assert.ok(fs.existsSync(step12Run.diag.loadStatus.corruptArchivePath));
    assert.equal(step12Run.diag.restoreSummary.totalRestored, 2);
    assert.equal(step12Run.diag.restoreSummary.verifiedCount, 2);
    console.log(
      `  Verified corrupt file archived to ${path.basename(step12Run.diag.loadStatus.corruptArchivePath)} ` +
      `and ${step12Run.diag.restoreSummary.totalRestored} notes recovered and verified.`
    );

    // Step 14: Verify packaged .deb binary and packaged login autostart startup if dist/spotnotes_1.0.0_amd64.deb is present
    const debPath = path.join(ROOT_DIR, 'dist', 'spotnotes_1.0.0_amd64.deb');
    if (fs.existsSync(debPath)) {
      console.log('\n[Step 14] Testing packaged .deb binary and packaged login autostart startup...');
      const pkgExtractDir = path.join(workDir, 'deb-extract');
      await fsp.mkdir(pkgExtractDir, { recursive: true });
      execFileSync('dpkg-deb', ['-x', debPath, pkgExtractDir]);

      const packagedBin = path.join(pkgExtractDir, 'opt', 'spotnotes', 'spotnotes');
      assert.equal(fs.existsSync(packagedBin), true, 'Packaged binary must exist at opt/spotnotes/spotnotes');

      const pkgAutostartDir = path.join(workDir, 'pkg-autostart');
      await fsp.mkdir(pkgAutostartDir, { recursive: true });
      const pkgDiag1 = path.join(workDir, 'diag-pkg1.json');

      await new Promise((resolve, reject) => {
        const child = spawn(packagedBin, ['--no-sandbox', '--ozone-platform=x11'], {
          env: {
            ...process.env,
            SPOTNOTES_USER_DATA_DIR: userDataDir,
            SPOTNOTES_AUTOSTART_DIR: pkgAutostartDir,
            SPOTNOTES_DIAGNOSTIC_FILE: pkgDiag1,
            SPOTNOTES_INTEGRATION_OPS: JSON.stringify([{ type: 'enable-autostart', enabled: true }]),
            SPOTNOTES_AUTO_QUIT_MS: '600'
          },
          stdio: 'ignore'
        });
        child.on('error', reject);
        child.on('close', () => resolve());
      });

      const pkgDiagData = JSON.parse(await fsp.readFile(pkgDiag1, 'utf8'));
      assert.equal(pkgDiagData.autostartFileExists, true);
      const pkgDesktopText = await fsp.readFile(pkgDiagData.autostartDesktopPath, 'utf8');
      assert.match(pkgDesktopText, /--ozone-platform=x11/);
      console.log(
        `  Verified packaged binary (app.isPackaged=true) restored ${pkgDiagData.restoreSummary.verifiedCount}/${pkgDiagData.restoreSummary.totalRestored} notes ` +
        `and wrote packaged autostart entry.`
      );
    }

    console.log('\n======================================================================');
    console.log('ALL 13 UBUNTU 26.04 GNOME WAYLAND / XWAYLAND INTEGRATION CHECKS PASSED');
    console.log('======================================================================');
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n[verify-xwayland] FAILED:', err);
  process.exit(1);
});
