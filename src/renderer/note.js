'use strict';

(async function initNoteRenderer() {
  const api = window.spotnotes;
  const controls = window.SpotNotesControls;

  const textarea = document.getElementById('note-textarea');
  const saveStatus = document.getElementById('save-status');
  const btnNewNote = document.getElementById('btn-new-note');
  const btnColour = document.getElementById('btn-colour');
  const btnPin = document.getElementById('btn-pin');
  const btnMenu = document.getElementById('btn-menu');
  const btnDelete = document.getElementById('btn-delete');
  const btnCloseWindow = document.getElementById('btn-close-window');
  const btnConfirmDelete = document.getElementById('btn-confirm-delete');
  const btnCancelDelete = document.getElementById('btn-cancel-delete');
  const chkLaunchLogin = document.getElementById('chk-launch-login');
  const btnReopenClosed = document.getElementById('btn-reopen-closed');
  const btnQuitApp = document.getElementById('btn-quit-app');

  if (!api || !controls) {
    if (saveStatus) saveStatus.textContent = 'Bridge unavailable';
    return;
  }

  const noteId = api.getInitialNoteId();
  if (!noteId) {
    if (saveStatus) saveStatus.textContent = 'Missing note ID';
    return;
  }

  let currentNote = null;
  let statusResetTimer = null;

  function setStatus(text, autoReset = false) {
    if (!saveStatus) return;
    saveStatus.textContent = text;
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
    if (autoReset) {
      statusResetTimer = setTimeout(() => {
        saveStatus.textContent = 'Saved';
      }, 900);
    }
  }

  try {
    const initPayload = await api.getNoteInitData(noteId);
    currentNote = initPayload.note;
    textarea.value = currentNote.text || '';
    controls.applyThemeColour(currentNote.colour);
    controls.applyPinnedState(currentNote.alwaysOnTop);
    controls.updateGlobalMetaUI(initPayload.meta);
    setStatus('Saved');
  } catch (err) {
    setStatus(`Load error: ${err.message}`);
    return;
  }

  api.onStateChanged((meta) => {
    controls.updateGlobalMetaUI(meta);
  });

  // Live text editing
  textarea.addEventListener('input', async () => {
    setStatus('Saving…');
    try {
      await api.updateText(noteId, textarea.value);
      setStatus('Saved', true);
    } catch {
      setStatus('Save error');
    }
  });

  // Clicking inside the editor closes open toolbar popovers
  textarea.addEventListener('mousedown', () => {
    controls.closeAllPopovers();
  });

  // Create new sticky note
  btnNewNote.addEventListener('click', async () => {
    controls.closeAllPopovers();
    await api.createNote(noteId);
  });

  // Toggle colour palette bar
  btnColour.addEventListener('click', () => {
    controls.togglePopover('colour-palette-bar', btnColour);
  });

  // Select colour swatch
  document.querySelectorAll('.swatch-btn').forEach((swatch) => {
    swatch.addEventListener('click', async () => {
      const nextColour = swatch.dataset.colour;
      if (!nextColour) return;
      controls.applyThemeColour(nextColour);
      controls.closeAllPopovers();
      const res = await api.updateColour(noteId, nextColour);
      if (res && res.note) {
        currentNote = res.note;
      }
      textarea.focus();
    });
  });

  // Toggle Always-on-Top pin
  btnPin.addEventListener('click', async () => {
    controls.closeAllPopovers();
    const nextPinned = !(currentNote && currentNote.alwaysOnTop);
    const res = await api.toggleAlwaysOnTop(noteId, nextPinned);
    if (res && res.ok) {
      currentNote.alwaysOnTop = res.alwaysOnTop;
      controls.applyPinnedState(currentNote.alwaysOnTop);
    }
  });

  // Toggle options menu
  btnMenu.addEventListener('click', () => {
    controls.togglePopover('app-menu-bar', btnMenu);
  });

  // Launch at login toggle
  chkLaunchLogin.addEventListener('change', async () => {
    await api.updateLaunchAtLogin(chkLaunchLogin.checked);
  });

  // Reopen closed notes
  btnReopenClosed.addEventListener('click', async () => {
    controls.closeAllPopovers();
    await api.reopenClosedNotes();
  });

  // Quit application
  btnQuitApp.addEventListener('click', async () => {
    await api.quitApplication();
  });

  // Open delete confirmation
  btnDelete.addEventListener('click', () => {
    controls.togglePopover('delete-confirm-bar', null);
    btnCancelDelete.focus();
  });

  btnCancelDelete.addEventListener('click', () => {
    controls.closeAllPopovers();
    textarea.focus();
  });

  btnConfirmDelete.addEventListener('click', async () => {
    await api.deleteNote(noteId);
  });

  // Close window without deleting note
  btnCloseWindow.addEventListener('click', async () => {
    await api.closeNoteWindow(noteId);
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      controls.closeAllPopovers();
      textarea.focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      await api.createNote(noteId);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      await api.closeNoteWindow(noteId);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      await api.quitApplication();
    }
  });
})();
