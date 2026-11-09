# File Blinders for GitHub

Personal Firefox extension + CLI that hide one half of a GitHub pull request
so you can review the other half: on PR **Files changed** pages, the
extension clicks GitHub's own per-file "Viewed" button for the file group
you pick in the toolbar popup — test files by default, or every non-test
file in "hide implementation" mode. The CLI does the same one-shot from a
terminal. All code is small and auditable: no network access, no cookies,
no tracking, and the only extension API used is local storage for the mode.

## Repository contents

| Path | What it is |
|---|---|
| `manifest.json` | MV3 manifest — id, `storage` permission, popup, content script |
| `content.js` | the entire page-side logic (single auditable file) |
| `popup.html` + `popup.js` | toolbar popup that sets the mode |
| `package.sh` | builds `file-blinders-for-github.xpi` (for temporary loads) |
| `sign.sh` | stages the shipped files, uploads + signs a new version on your AMO account (unlisted); reads `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` from the environment |
| `verify.js` | runs the shipped classifier against a real PR's changed files (parity check vs the CLI) |
| `cli/mark-tests-viewed` | terminal companion: marks test files (or, with `--invert`, everything else) as Viewed via GitHub's GraphQL API using `gh` |

## Modes (toolbar button → popup)

* **Hide test files** (default) — test files are marked Viewed; implementation stays visible.
* **Hide implementation files** — everything not matching the test conventions is marked Viewed, and previously-hidden test files are un-marked so tests show again.

Semantics:

* The mode is stored in the extension's own local storage (one key, `markTestsViewedMode`). It survives reloads and restarts, applies to every PR you open, and every open GitHub tab follows changes made in the popup.
* Switching modes reconciles the open PR immediately: it un-marks the files the new mode wants visible (including marks from earlier sessions — on GitHub, marks persist server-side) and marks the ones it wants hidden.
* In **hide implementation** mode, opening a PR also reconciles it, so tests hidden earlier reappear. In the default mode, page load only marks — your manual "Viewed" clicks on implementation files are never undone.
* **Manual per-file clicks always win, in both directions, until the page reloads.**
* "Implementation" = anything not matching the test conventions, including changesets and locale files.

## What it never does

* No network requests of any kind, no cookies, no background page, no remote code.
* Storage: exactly one key in the extension's **own** local storage (the mode). No site data is touched.
* Runs only on `https://github.com/*`; only acts on `/pull/N/files` and `/pull/N/changes` pages.
* If a file's path cannot be identified, it is skipped — it would rather miss a file than mark the wrong one.

## Audit it yourself

```bash
# must print NOTHING — no network / remote-code APIs:
grep -nE 'fetch\(|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie|eval\(|new Function|window\.open|\.src\s*=' content.js popup.js

# every hit must be one of the declared mode-key accessors (browser.storage):
grep -n 'browser\.storage' content.js popup.js

wc -l content.js popup.js    # the whole extension
```

## Debugging

On any PR Files-changed page, open DevTools:

* `window.__markTestsViewed` — extension version after load
* `window.__markTestsViewedMode` — current mode
* every decision is logged with the `[mark-tests-viewed]` prefix (console.info)

## Install

* **Temporary (until browser restart)**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → select `manifest.json` or the built `.xpi` (`./package.sh`).
* **Permanent (release Firefox)**: sign on your own (free) AMO account — unlisted/self-distributed — then `about:addons` → ⚙️ → *Install Add-on From File*. Installing a newer signed file upgrades in place; reload your GitHub tab afterwards (open tabs keep the old script).
* Chrome works too: `chrome://extensions` → Developer mode → *Load unpacked* (this repo root).

## CLI quick start

```bash
install -m755 cli/mark-tests-viewed ~/.local/bin/

mark-tests-viewed --dry-run 20541        # preview the test files it would mark
mark-tests-viewed 20541                  # mark them as Viewed (your gh account)
mark-tests-viewed --invert 20541         # hide IMPLEMENTATION instead, tests stay visible
mark-tests-viewed --undo 20541           # restore everything to your review queue

# optional gh alias (args pass through):
gh alias set mark-tests-viewed --clobber '!'"$HOME"'/.local/bin/mark-tests-viewed "$@"'
gh alias set mtv --clobber '!'"$HOME"'/.local/bin/mark-tests-viewed "$@"'
```

The CLI authenticates as whatever account `gh` is logged in as. After editing
the CLI in this repo, re-run the `install` line to update `~/.local/bin/`.

## Releasing a new version

1. Edit `content.js` / `popup.html` / `popup.js`, and bump `"version"` in `manifest.json` (AMO requires a strictly newer number).
2. `./package.sh` to rebuild the local `.xpi`, and optionally check classifier parity: `node verify.js <owner/repo> <pr-number>`.
3. `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… ./sign.sh` — stages the shipped files, uploads, and signs on your AMO account (unlisted). The signed file lands in `web-ext-artifacts/`.
4. `about:addons` → ⚙️ → *Install Add-on From File* → the new signed file → reload your GitHub tab.

## Known conservative skips

* Files whose path can't be identified from the page (unusual markup) are left visible and logged.
* Renamed-file entries (ambiguous two-path headers) are skipped.
* The Viewed-button selectors target the English aria-labels `Viewed` / `Not Viewed`. Other GitHub UI languages (or future GitHub markup changes) need a one-line update in `content.js` (`NOT_VIEWED_SELECTOR` / `VIEWED_NOW_SELECTOR`).
