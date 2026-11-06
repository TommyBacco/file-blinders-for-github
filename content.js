// mark-tests-viewed — personal Firefox content script.
//
// What it does: on GitHub pull-request "Files changed" pages, finds each
// file's own "Not Viewed" toggle and clicks it for the file group selected
// by the mode. GitHub's own UI then persists the viewed state with your
// session, exactly as if you had clicked the button yourself.
//
// Modes (pick in the extension's toolbar popup):
//   hide-tests          — test files are marked Viewed (tests hidden).
//                          Default; identical to v1.0.1 behavior.
//   hide-implementation — every file that is NOT a test is marked Viewed
//                          (implementation hidden), and any Viewed test
//                          file is un-marked so tests show again.
//
// The mode lives in the extension's own local storage
// (browser.storage.local, key "markTestsViewedMode") — the only browser API
// this extension uses.
//
// Reconcile rules:
//   * Switching modes sweeps the open PR: un-marks what the new mode wants
//     visible (including marks from earlier sessions) and marks what it
//     wants hidden.
//   * In hide-implementation mode, a freshly loaded PR is reconciled too,
//     so previously-hidden tests reappear.
//   * In hide-tests mode, page load only marks (never un-marks), so your
//     manual "Viewed" clicks on implementation files are never undone.
//   * Manual per-file clicks are respected in both directions (visible or
//     hidden) until the page reloads.
//
// Guarantees (auditable in these files):
//   * No network requests of any kind.
//   * No eval, no remote code, no background page.
//   * Storage: exactly one key in the extension's own local storage.
//   * Only runs on https://github.com/* and only acts on
//     /owner/repo/pull/<number>/files or /changes pages.
//   * If a file's path cannot be identified, it is skipped — it would
//     rather miss a file than mark or un-mark the wrong one.
//
// Diagnostics: window.__markTestsViewed (version) and
// window.__markTestsViewedMode (current mode); decisions are logged with
// the "[mark-tests-viewed]" prefix via console.info.

(() => {
  'use strict';

  const EXTENSION_VERSION = '1.0.2';
  const DEBUG_TAG = '[mark-tests-viewed]';
  const HANDLED_ATTR = 'data-mtv-handled';
  const NO_PATH_ATTR = 'data-mtv-nopath';
  const MAX_CLICK_ATTEMPTS = 3;
  const MAX_ANCESTOR_HOPS = 12;
  const MAX_CANDIDATES_PER_SCOPE = 20;
  const FILES_CHANGED_URL = /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)\/?$/;

  const MODE_KEY = 'markTestsViewedMode';
  const MODE_HIDE_TESTS = 'hide-tests';
  const MODE_HIDE_IMPL = 'hide-implementation';
  let mode = MODE_HIDE_TESTS; // set from storage before the first sweep

  // Path attributes, checked on ancestors and on in-scope candidates
  // (legacy markup and the React diff view both evolved here).
  const PATH_ATTRIBUTES = [
    'data-path',
    'data-file-path',
    'data-tagsearch-path',
    'data-code-nav-path',
    'data-filename'
  ];

  // Filename-bearing elements inside a per-file scope.
  const PATH_CANDIDATE_SELECTOR = [
    '[data-path]',
    '[data-file-path]',
    '[data-tagsearch-path]',
    '[data-code-nav-path]',
    '[data-filename]',
    'a[title]',
    '[aria-label^="File:"]',
    '[aria-label^="file:"]'
  ].join(',');

  // Every per-file Viewed control regardless of state (React buttons and
  // the legacy reviewed checkbox) — used to detect ambiguous scopes.
  const ANY_VIEWED_CONTROL_SELECTOR = 'button[aria-pressed], input.js-reviewed-checkbox';
  const VIEWED_LABEL = /^(?:not\s+)?viewed$/i;

  // The toggle we may click: GitHub's "Not Viewed" button (React) or the
  // legacy unchecked reviewed checkbox. English aria-label only — see
  // README if your GitHub language differs.
  const NOT_VIEWED_SELECTOR = [
    'button[aria-label="Not Viewed"][aria-pressed="false"]',
    'input.js-reviewed-checkbox:not(:checked)'
  ].join(',');

  // The mirror image: currently-viewed controls we may un-mark.
  const VIEWED_NOW_SELECTOR = [
    'button[aria-label="Viewed"][aria-pressed="true"]',
    'input.js-reviewed-checkbox:checked'
  ].join(',');

  const autoMarked = new Set();  // paths we marked on the current PR
  const userOpened = new Set();   // paths the user manually un-marked (keep visible)
  const userClosed = new Set();   // paths the user manually marked (keep hidden)
  const attempts = new Map();     // path -> click attempts, capped to avoid loops
  const textPathCache = new WeakMap(); // scope -> unique path-like strings

  // Test-file conventions — the same rules as the companion CLI
  // (`gh mark-tests-viewed` / `gh mtv`). Edit here to change them.
  function isTestFile(rawPath) {
    const path = String(rawPath).replace(/\\/g, '/').trim().toLowerCase();
    const base = path.split('/').pop() ?? path;
    if (/\.(spec|test)\.[a-z0-9]+$/.test(base)) return true;  // Button.spec.tsx, utils.test.ts
    if (/^[a-z0-9][a-z0-9._-]*_test\.(go|py|cc|cpp|cxx)$/.test(base)) return true; // server_test.go
    if (/^(test|spec)[._-]/.test(base)) return true;         // test_user.py
    if (/\.snap$/.test(base)) return true;                   // snapshot artifacts
    return /(^|\/)(__tests__|__mocks__|__snapshots__|__pacts__|pacts|test|tests|testing|e2e|test-utils|testutils)(\/|$)/.test(path);
  }

  // Which group does the current mode hide? Everything that does not match
  // the test conventions counts as "implementation" (including changesets
  // and locale files).
  function shouldHide(path) {
    return mode === MODE_HIDE_TESTS ? isTestFile(path) : !isTestFile(path);
  }

  function looksLikePath(text) {
    const s = String(text).trim();
    return !/\s/.test(s) && (s.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(s));
  }

  // A Viewed control is any aria-pressed button labeled "Viewed"/"Not Viewed"
  // or the legacy reviewed checkbox. Unrelated toggle buttons never match.
  function isViewedControl(el) {
    if (el instanceof HTMLInputElement) return el.classList.contains('js-reviewed-checkbox');
    return VIEWED_LABEL.test(el.getAttribute('aria-label') ?? '');
  }

  // Reads a path from a filename-bearing candidate element.
  function parseCandidate(el) {
    if (!el) return null;
    for (const attr of PATH_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value) return value;
    }
    const title = el.getAttribute('title');
    if (title && looksLikePath(title)) return title;
    const labelled = (el.getAttribute('aria-label') ?? '').match(/^file:\s*(.*)$/i);
    if (labelled && looksLikePath(labelled[1])) return labelled[1];
    return null;
  }

  // Unique path-like strings in a scope's text (last resort: accepted only
  // when exactly one is found).
  function textPaths(scope) {
    const cached = textPathCache.get(scope);
    if (cached) return cached;
    const text = (scope.textContent ?? '').replace(/\u00a0/g, ' ');
    const class_ = '[A-Za-z0-9@_.()+\\[\\]~#%&=,;{}!-]';
    const token = new RegExp(class_ + '+(?:/' + class_ + '+)*\\.[A-Za-z0-9]+', 'g');
    const found = [...new Set((text.match(token) ?? []).filter(looksLikePath))];
    textPathCache.set(scope, found);
    return found;
  }

  // Returns the path of the file this Viewed control belongs to, or null.
  // Walks scope by scope from the control outward; a scope is trusted only
  // while it contains exactly one Viewed control, i.e. exactly one file.
  function ownedPath(control) {
    for (let node = control, depth = 0; node && depth <= MAX_ANCESTOR_HOPS; node = node.parentElement, depth += 1) {
      // Tier 1: path attribute on the ancestor itself.
      for (const attr of PATH_ATTRIBUTES) {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value) return value;
      }

      // Ambiguity guard: this scope must hold exactly one Viewed control
      // (querySelectorAll never returns the scope itself).
      let viewedInScope = 0;
      for (const c of node.querySelectorAll(ANY_VIEWED_CONTROL_SELECTOR)) {
        if (isViewedControl(c)) viewedInScope += 1;
      }
      if (node === control) viewedInScope += 1;
      if (viewedInScope !== 1) continue;

      // Tier 2: filename-bearing candidates inside this scope.
      const candidates = node.querySelectorAll(PATH_CANDIDATE_SELECTOR);
      for (let i = 0; i < candidates.length && i < MAX_CANDIDATES_PER_SCOPE; i += 1) {
        const parsed = parseCandidate(candidates[i]);
        if (parsed) return parsed;
      }

      // Tier 3: exactly one path-like string in this scope's text.
      const unique = textPaths(node);
      if (unique.length === 1) return unique[0];
    }
    return null;
  }

  function isFilesChangedPage() {
    return FILES_CHANGED_URL.test(window.location.pathname);
  }

  function isViewed(control) {
    if (control instanceof HTMLInputElement) return control.checked;
    return control.getAttribute('aria-pressed') === 'true';
  }

  // Hiding direction — clicks GitHub's Viewed button for every identified
  // file the current mode wants hidden.
  function scan() {
    if (!isFilesChangedPage()) return;

    for (const control of document.querySelectorAll(NOT_VIEWED_SELECTOR)) {
      if (control.hasAttribute(HANDLED_ATTR) || control.hasAttribute(NO_PATH_ATTR)) continue;

      const path = ownedPath(control);
      if (!path) {
        // Unknown markup: skip forever (on this node) — never guess.
        control.setAttribute(NO_PATH_ATTR, 'true');
        console.info(DEBUG_TAG, 'could not identify the file for a toggle — left it visible');
        continue;
      }
      if (!shouldHide(path)) continue;     // visible per current mode
      if (autoMarked.has(path)) continue;   // already handled
      if (userOpened.has(path)) continue;   // user wants to read it
      if (userClosed.has(path)) continue;   // user hid it manually already
      if ((attempts.get(path) ?? 0) >= MAX_CLICK_ATTEMPTS) continue;

      control.setAttribute(HANDLED_ATTR, 'true');
      autoMarked.add(path);
      control.click(); // GitHub persists the state with your session
      console.info(DEBUG_TAG, 'marked viewed (' + mode + '):', path);

      // Verify on the next frame that GitHub accepted the click; if not,
      // release the path for a bounded retry when the DOM settles.
      window.requestAnimationFrame(() => {
        if (control.isConnected && !isViewed(control)) {
          autoMarked.delete(path);
          attempts.set(path, (attempts.get(path) ?? 0) + 1);
          console.info(DEBUG_TAG, 'click not confirmed, will retry:', path);
          scheduleScan();
        }
      });
    }
  }

  // Showing direction — un-marks currently-Viewed files the current mode
  // wants visible. Only runs as part of a reconcile sweep (mode switch or
  // page load in hide-implementation mode), never in the steady-state
  // observer loop, so it can never fight the user's own clicks.
  function unmarkSweep() {
    if (!isFilesChangedPage()) return;

    for (const control of document.querySelectorAll(VIEWED_NOW_SELECTOR)) {
      const path = ownedPath(control);
      if (!path) continue;
      if (shouldHide(path)) continue;      // hidden per current mode — leave
      if (userClosed.has(path)) continue;  // user chose to hide it — respect

      autoMarked.delete(path);
      control.click(); // un-mark: back to "Not Viewed"
      console.info(DEBUG_TAG, 'un-marked to show (' + mode + '):', path);
    }
  }

  // One full sweep toward the current mode.
  function reconcileToMode() {
    scan();
    unmarkSweep();
  }

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }

  // Human clicks on a per-file Viewed control express a per-file wish:
  // un-marking -> keep visible, marking -> keep hidden. Our own synthetic
  // clicks are not trusted events, so they never end up here.
  function respectManualClicks() {
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const control = target.closest('button[aria-label], input.js-reviewed-checkbox');
      if (!control) return;

      const label = (control.getAttribute('aria-label') ?? '').trim().toLowerCase();
      const wasMarking = control instanceof HTMLInputElement
        ? !control.checked
        : label === 'not viewed';
      const wasUnmarking = control instanceof HTMLInputElement
        ? control.checked
        : label === 'viewed';

      const path = ownedPath(control);
      if (!path) return;

      if (wasUnmarking) {
        userOpened.add(path);
        console.info(DEBUG_TAG, 'user un-marked, keeping visible:', path);
      } else if (wasMarking) {
        userClosed.add(path);
        console.info(DEBUG_TAG, 'user marked, keeping hidden:', path);
      }
    }, true);
  }

  function resetState() {
    autoMarked.clear();
    userOpened.clear();
    userClosed.clear();
    attempts.clear();
  }

  // Reads the mode from the extension's local storage and follows later
  // changes made from the popup (or any other GitHub tab).
  async function loadMode() {
    const storage = typeof browser !== 'undefined' ? browser.storage : undefined;
    if (!storage || !storage.local || !storage.local.get) return;

    try {
      const stored = await storage.local.get(MODE_KEY);
      if (stored[MODE_KEY] === MODE_HIDE_IMPL) mode = MODE_HIDE_IMPL;
    } catch (error) {
      console.info(DEBUG_TAG, 'could not read mode, using default:', error);
    }

    if (storage.onChanged) {
      storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !(MODE_KEY in changes)) return;
        mode = changes[MODE_KEY].newValue === MODE_HIDE_IMPL ? MODE_HIDE_IMPL : MODE_HIDE_TESTS;
        window.__markTestsViewedMode = mode;
        console.info(DEBUG_TAG, 'mode changed to:', mode);
        if (isFilesChangedPage()) reconcileToMode();
      });
    }
  }

  function watchNavigation() {
    let lastPathname = window.location.pathname;

    // GitHub's SPA navigation does not always fire browser events, so poll
    // the pathname lightly. Moving to another PR resets the per-PR state.
    window.setInterval(() => {
      if (window.location.pathname === lastPathname) return;
      lastPathname = window.location.pathname;
      resetState();
      if (isFilesChangedPage()) reconcileToMode();
    }, 250);

    // Turbo/PJAX re-rendering and lazily loaded diffs.
    ['turbo:load', 'turbo:render', 'pjax:end', 'popstate'].forEach((name) => {
      window.addEventListener(name, scheduleScan);
    });
    new MutationObserver(scheduleScan)
      .observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    window.__markTestsViewed = EXTENSION_VERSION;
    window.__markTestsViewedMode = mode;
    console.info(DEBUG_TAG, 'v' + EXTENSION_VERSION + ' loaded');

    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    respectManualClicks();
    watchNavigation();

    await loadMode();
    window.__markTestsViewedMode = mode;
    console.info(DEBUG_TAG, 'mode:', mode);

    // Page-load reconcile: full sweep in show-tests mode; marking only in
    // the default mode, so manual implementation views are never undone.
    if (mode === MODE_HIDE_IMPL) {
      reconcileToMode();
    } else {
      scan();
    }
  }

  init();
})();
