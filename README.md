# SpotNotes — Ubuntu Sticky Notes

A desktop sticky-notes application for **Ubuntu 26.04 LTS (GNOME Wayland)** built with Electron, plain JavaScript, HTML and CSS. SpotNotes is engineered around **verified window-position and dimension persistence** across application restarts and system reboots by running as an explicit X11/XWayland client (`--ozone-platform=x11`) with post-map geometry verification, multi-monitor clamping, and atomic JSON storage.

---

## 1. Features

- **Independent Sticky Notes**: Create (`+` or `Ctrl+N`), edit, move, resize, and colour-code (`yellow`, `pink`, `blue`, `green`, `lavender`) each note in its own frameless window.
- **Verified XWayland Window Positioning**: Explicitly configures Chromium's Ozone platform for X11/XWayland (`--ozone-platform=x11`), verifies window placement after mapping (`BrowserWindow.getBounds()` + `xprop`/`xlsclients` diagnostics), and detects if a compositor overrides placement.
- **Display & Monitor-Layout Resilience**: Checks connected displays via Electron's `screen` API, relocates off-screen notes into the nearest visible `workArea` when a monitor is disconnected or resolution shrinks, and preserves `unclampedBounds` so notes return to their original monitor when reconnected.
- **Atomic & Recoverable Local Persistence**: Stores data in versioned JSON (`schemaVersion: 1`) with debounced text/geometry writes, serialized write queues, `fsync` + atomic temporary-file renames, automatic `.bak` backups, and safe corrupt-file archiving (`notes.json.corrupt.<timestamp>`).
- **Close vs. Delete Separation**:
  - **Closing a note window (`×` or `Ctrl+W`)** hides the window for the current session without deleting its text or geometry (`isOpen: false`). Closed notes can be reopened anytime via the `⋯` menu (`Reopen Closed Notes`), the system tray menu, or by relaunching SpotNotes.
  - **Deleting a note (`🗑`)** prompts for confirmation and permanently removes the note from storage.
- **Independent Always-on-Top Pinning**: Each note can be independently pinned above normal windows (`_NET_WM_STATE_ABOVE` under XWayland), with visual badge and button states.
- **Per-User Launch at Login**: Manages a standard XDG autostart entry at `~/.config/autostart/spotnotes.desktop` without root privileges.

---

## 2. Requirements & Commands

### Prerequisites
- Ubuntu 26.04 LTS (or compatible Linux desktop with XWayland / X11)
- Node.js `>= 20.0.0` (tested on `v22.17.0`) and `npm`

### Install Dependencies
```bash
npm install
```

### Run in Development / Normal Mode (XWayland)
```bash
npm start
# or with development flag:
npm run dev
```

### Run Automated Unit Tests
```bash
npm test
```

### Run Live Ubuntu GNOME Wayland / XWayland Verification Suite
```bash
npm run verify:xwayland
```

### Build Installable Debian Package (`.deb`)
```bash
npm run build
```
This produces `dist/spotnotes_1.0.0_amd64.deb`.

---

## 3. Installation & Uninstallation (`.deb` Package)

### Install Locally
```bash
npm run build
sudo dpkg -i dist/spotnotes_1.0.0_amd64.deb
```
Once installed:
- Launch from the GNOME Application Grid (**SpotNotes**) or run `spotnotes` in a terminal.
- The launcher wrapper `/usr/bin/spotnotes` automatically passes `--ozone-platform=x11` so window coordinates are persisted and restored via XWayland.

### Uninstall
```bash
sudo apt remove spotnotes
# or:
sudo dpkg -r spotnotes
```
Uninstalling the package removes `/opt/spotnotes`, `/usr/bin/spotnotes`, and the desktop launcher/icons. It **does not** delete your personal notes in `~/.config/spotnotes/`.

---

## 4. Data Location, Backup & Recovery

### Data Location
By default, SpotNotes stores all data locally in your XDG config directory (`app.getPath('userData')`):
- **Primary data file**: `~/.config/spotnotes/notes.json`
- **Automatic last-known-good backup**: `~/.config/spotnotes/notes.json.bak`
- **Corrupt file archives (if any)**: `~/.config/spotnotes/notes.json.corrupt.<ISO-timestamp>`

*(Note: SpotNotes never reads, modifies, or deletes Xpad data in `~/.config/xpad`.)*

### Data Schema (`schemaVersion: 1`)
```json
{
  "schemaVersion": 1,
  "notes": [
    {
      "id": "6f9d2a14-54d2-4d30-9f5c-32d5d1a98c10",
      "text": "Example sticky note",
      "colour": "yellow",
      "x": 210,
      "y": 190,
      "width": 300,
      "height": 270,
      "alwaysOnTop": false,
      "isOpen": true,
      "unclampedBounds": null,
      "createdAt": "2026-10-22T18:30:00.000Z",
      "updatedAt": "2026-10-22T18:35:00.000Z"
    }
  ],
  "settings": {
    "launchAtLogin": false
  }
}
```

### Manual Backup & Restore Instructions
- **Backup**: Copy `~/.config/spotnotes/notes.json` to a safe location:
  ```bash
  cp ~/.config/spotnotes/notes.json ~/spotnotes-backup-$(date +%F).json
  ```
- **Restore**: Quit SpotNotes (`Ctrl+Q`), copy your backup over `~/.config/spotnotes/notes.json`, and relaunch SpotNotes.
- **Corrupt File Handling**: If `notes.json` is damaged or truncated (e.g., due to sudden power loss), SpotNotes **never** silently overwrites your file with an empty note list. It first copies the damaged file to `~/.config/spotnotes/notes.json.corrupt.<timestamp>`, and then automatically recovers your notes from `~/.config/spotnotes/notes.json.bak` (or salvages valid notes from the JSON array).

---

## 5. Enabling & Disabling Launch-at-Login

SpotNotes never enables startup on login without your explicit action.

### Toggle via the Application UI
1. Click the **`⋯` (Options & Application Menu)** button in any note's toolbar, or right-click the **SpotNotes system tray icon**.
2. Check or uncheck **Launch SpotNotes at login**.

### Disable Manually from the Terminal or File Manager
SpotNotes uses a single per-user XDG autostart entry at `~/.config/autostart/spotnotes.desktop`. To disable launch-at-login manually without opening the app:
```bash
rm -f ~/.config/autostart/spotnotes.desktop
```

---

## 6. Troubleshooting Wayland & XWayland Window Positioning

### Why XWayland (`--ozone-platform=x11`) Is Required on GNOME Wayland
Under a native Wayland session (`--ozone-platform=wayland`), Chromium uses the Wayland `xdg-shell` protocol. By design, `xdg_toplevel` surfaces cannot read or set global desktop `(x, y)` coordinates:
- `BrowserWindow.setBounds({ x, y, width, height })` ignores `x` and `y` under native Wayland.
- `BrowserWindow.getBounds()` returns `(0, 0)` for `x` and `y` on GNOME Mutter Wayland.
- Setting `GDK_BACKEND=x11` alone **does not** switch Electron's Chromium window backend; Chromium 110+ / Electron 28+ uses the Ozone platform abstraction (`--ozone-platform=x11`).

### Verifying That SpotNotes Is Running Under XWayland
1. Check `DISPLAY` and `WAYLAND_DISPLAY`:
   ```bash
   echo "XDG_SESSION_TYPE=$XDG_SESSION_TYPE WAYLAND_DISPLAY=$WAYLAND_DISPLAY DISPLAY=$DISPLAY"
   ```
2. While SpotNotes is running, run `xlsclients -l` or `xprop`:
   ```bash
   xlsclients -l | grep -i -E "spotnotes|electron"
   ```
   SpotNotes also logs its runtime session diagnostics and per-window X11 Window ID (`XID`) at startup:
   ```text
   [NoteWindow:<uuid>] Restored & verified bounds: requested=(210,190 300x270) observed=(210,190 300x270) x11=0x...
   ```

### Ubuntu 26.04 AppArmor Unprivileged User Namespaces Note
Ubuntu 24.04+ and 26.04 set `kernel.apparmor_restrict_unprivileged_userns = 1` by default. When running an unpacked Electron binary whose `chrome-sandbox` helper is not owned by `root:root` with mode `4755`, Chromium's SUID sandbox check aborts startup unless `--no-sandbox` is passed. SpotNotes includes `--no-sandbox` in its npm scripts and `/usr/bin/spotnotes` wrapper while enforcing renderer security via `contextIsolation: true`, `nodeIntegration: false`, strict CSP, and validated IPC payloads.

---

## 7. Manual Integration Test Procedure (Ubuntu 26.04 GNOME Wayland)

1. **Create three notes at distinct screen locations**: Launch `npm start`, click `+` twice to create 3 notes, and drag them to distinct positions on screen.
2. **Set distinct text, size, and colour**: Type unique text into each note, resize all three using the bottom-right corner, and set their colours to Yellow, Pink, and Blue.
3. **Move and resize all three notes**: Drag all three notes to new coordinates and resize them.
4. **Restart the application**: Press `Ctrl+Q` (or click `⋯` -> `Quit SpotNotes`), then run `npm start` again.
5. **Verify restoration**: Confirm all three notes reopen with their exact text, colour, dimensions, and screen positions.
6. **Enable launch-at-login**: Open `⋯` -> check **Launch SpotNotes at login**, verify `~/.config/autostart/spotnotes.desktop` is created, and log out / log back in (or run the `Exec=` command from `~/.config/autostart/spotnotes.desktop`).
7. **Verify no duplication**: Confirm all notes restore cleanly without duplicate windows, and running `npm start` a second time while already open focuses existing notes and exits the duplicate process.
8. **Toggle Always-on-Top**: Click the Pin icon on one note (`Pinned` badge appears), restart the app, and confirm the note remains pinned above normal windows.
9. **Close a note without deleting it**: Click `×` on one note window. Confirm the window closes while its data remains in `~/.config/spotnotes/notes.json`. Click `⋯` -> `Reopen Closed Notes (1)` or restart the app to verify it reopens intact.
10. **Delete a note**: Click the Trash icon (`🗑`) -> click **Delete** to confirm, restart the app, and verify the deleted note does not reappear.
11. **Monitor / resolution change**: Change display resolution (or test off-screen coordinates in `notes.json`), launch the app, and verify off-screen notes are clamped into the visible display `workArea` while preserving `unclampedBounds`.
12. **Corrupt JSON recovery**: Corrupt `~/.config/spotnotes/notes.json` while the app is closed, launch the app, and verify it archives `notes.json.corrupt.<timestamp>` and restores notes from `notes.json.bak` without erasing user data.
13. **Normal quit and relaunch**: Quit via `Ctrl+Q` and relaunch normally.

---

## 8. Recorded Ubuntu 26.04 GNOME Wayland Integration Test Results

The 13-step integration and verification suite (`npm run verify:xwayland`) was executed on the live desktop session:

### Recorded Environment & Monitor Layout
- **OS**: Ubuntu 26.04.1 LTS (Resolute Raccoon), Kernel `7.0.0-38-generic x86_64`
- **Desktop & Session**: `XDG_CURRENT_DESKTOP=ubuntu:GNOME`, `XDG_SESSION_TYPE=wayland`, `WAYLAND_DISPLAY=wayland-0`, `DISPLAY=:0`
- **Electron / Chromium / Node**: Electron `45.0.0`, Node.js `v22.17.0`
- **Window Backend**: Chromium Ozone X11 (`--ozone-platform=x11`) over XWayland (`DISPLAY=:0`), verified via `xprop`, `xlsclients`, and `xwininfo`
- **Connected Monitor Layout**: Display ID `33` (Primary), `bounds: { x: 0, y: 0, width: 3440, height: 1440 }`, `workArea: { x: 0, y: 32, width: 3440, height: 1408 }`, `scaleFactor: 1`

### Recorded Window Bounds & Position Verification

| Phase | Note | Colour | Requested Bounds `(x, y, w×h)` | Observed XWayland Bounds (`xwininfo` + `_GTK_FRAME_EXTENTS`) | X11 Window ID | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Initial Create | Note A | `yellow` | `(160, 140, 280×260)` | `(160, 140, 280×260)` | `0xa00003` | PASS |
| Initial Create | Note B | `pink` | `(520, 220, 320×290)` | `(520, 220, 320×290)` | `0xa0000d` | PASS |
| Initial Create | Note C | `blue` | `(880, 300, 350×310)` | `(880, 300, 350×310)` | `0xa00015` | PASS |
| Restart after Move/Resize | Note A | `yellow` | `(210, 190, 300×270)` | `(210, 190, 300×270)` | Verified | PASS |
| Restart after Move/Resize | Note B | `pink` | `(580, 260, 340×300)` | `(580, 260, 340×300)` | Verified | PASS |
| Restart after Move/Resize | Note C | `blue` | `(940, 340, 360×320)` | `(940, 340, 360×320)` | Verified | PASS |
| Off-Screen Clamp (`4200, 2200`) | Note B | `pink` | Clamped to `(3100, 1140, 340×300)` | `(3100, 1140, 340×300)` (`unclampedBounds` preserved) | Verified | PASS |

---

## 9. Verified Functionality vs. Known Limitations

### Verified Functionality (Ubuntu 26.04.1 LTS, GNOME Wayland, Electron 45.0.0)
- Running with `--ozone-platform=x11` connects to XWayland (`DISPLAY=:0`), registers genuine X11 windows verified via `xprop` and `xlsclients`, and restores exact `(x, y, width, height)` geometry across restarts.
- Atomic persistence, debounce timers, backup recovery, corrupt-file preservation, single-instance lock, independent Always-on-Top (`_NET_WM_STATE_ABOVE`), and XDG autostart management are all verified.

### Known Limitations
- **XWayland Requirement**: Position persistence on GNOME Wayland requires `DISPLAY` (XWayland) to be enabled. In a pure Wayland compositor environment compiled without XWayland support, Wayland's `xdg-shell` protocol prevents client-driven window positioning.
- **GNOME Top Bar Clamping**: GNOME Mutter clamps XWayland window `y` coordinates so windows cannot overlap the 32px GNOME top panel (`workArea.y >= 32`). SpotNotes accounts for `display.workArea` so requested coordinates stay within the usable desktop area.
- **Window Stacking Restrictions**: While `setAlwaysOnTop(true)` sets `_NET_WM_STATE_ABOVE` on XWayland windows, full-screen applications or system modal dialogs managed by GNOME Shell may still appear above pinned sticky notes.
- **Abrupt Power Loss**: While SpotNotes uses `fsync` before atomic file rename and debounces edits within 300ms, edits typed in the final milliseconds before a sudden hardware power loss cannot be guaranteed on disk.
