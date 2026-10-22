'use strict';

(function initControlsNamespace() {
  const VALID_COLOURS = ['yellow', 'pink', 'blue', 'green', 'lavender'];

  function applyThemeColour(colour) {
    const safeColour = VALID_COLOURS.includes(colour) ? colour : 'yellow';
    document.body.dataset.colour = safeColour;
    for (const c of VALID_COLOURS) {
      document.body.classList.toggle(`note-theme-${c}`, c === safeColour);
    }

    const swatches = document.querySelectorAll('.swatch-btn');
    swatches.forEach((btn) => {
      const isMatch = btn.dataset.colour === safeColour;
      btn.classList.toggle('active-swatch', isMatch);
      btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
    });
  }

  function applyPinnedState(alwaysOnTop) {
    const pinned = Boolean(alwaysOnTop);
    const pinBtn = document.getElementById('btn-pin');
    const pinBadge = document.getElementById('pin-badge');

    if (pinBtn) {
      pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      pinBtn.title = pinned
        ? 'Unpin Note (Currently Always on Top)'
        : 'Pin Note Always on Top';
    }
    if (pinBadge) {
      pinBadge.hidden = !pinned;
    }
  }

  function closeAllPopovers() {
    const colourBar = document.getElementById('colour-palette-bar');
    const menuBar = document.getElementById('app-menu-bar');
    const deleteBar = document.getElementById('delete-confirm-bar');
    const btnColour = document.getElementById('btn-colour');
    const btnMenu = document.getElementById('btn-menu');

    if (colourBar) colourBar.hidden = true;
    if (menuBar) menuBar.hidden = true;
    if (deleteBar) deleteBar.hidden = true;
    if (btnColour) btnColour.setAttribute('aria-expanded', 'false');
    if (btnMenu) btnMenu.setAttribute('aria-expanded', 'false');
  }

  function togglePopover(targetId, triggerBtn) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const wasHidden = target.hidden;
    closeAllPopovers();
    target.hidden = !wasHidden;
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', wasHidden ? 'true' : 'false');
    }
  }

  function updateGlobalMetaUI(meta) {
    if (!meta || typeof meta !== 'object') return;
    const chkLaunch = document.getElementById('chk-launch-login');
    const btnReopen = document.getElementById('btn-reopen-closed');

    if (chkLaunch && typeof meta.launchAtLogin === 'boolean') {
      chkLaunch.checked = meta.launchAtLogin;
    }
    if (btnReopen && typeof meta.closedNotesCount === 'number') {
      btnReopen.textContent = `Reopen Closed Notes (${meta.closedNotesCount})`;
      btnReopen.disabled = meta.closedNotesCount <= 0;
    }
  }

  window.SpotNotesControls = Object.freeze({
    VALID_COLOURS,
    applyThemeColour,
    applyPinnedState,
    closeAllPopovers,
    togglePopover,
    updateGlobalMetaUI
  });
})();
