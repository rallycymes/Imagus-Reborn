# Design

High-level architecture of Imagus Reborn. Deliberately free of code detail —
see `Details.md` for the sieve engine internals.

## What it is

A Manifest V3 browser extension (Firefox-first, Chrome-compatible) that
shows images/videos in a hover popup ("hover zoom") and resolves link
thumbnails to full-size media using **sieves**: a community-maintained
database of per-site rules.

## Components

| Component | File(s) | Role |
|---|---|---|
| Content script | `src/content/content.js` | Runs in every frame in the `USER_SCRIPT` world (registered via `chrome.userScripts`, CSP allows `eval`). Detects hover targets, matches URLs against the sieve, resolves media, renders the popup UI (viewer, caption, gallery strip, toolbar, VideoJS player, extension host). |
| Relay | `src/content/relay.js` | Tiny regular content script that bridges messages between the user-script world and the background. |
| Background | `src/background/service.js` | Service worker. Owns preferences/storage, sieve database updates and compilation, `res`-regex execution (fetches pages), downloads, history, ignore lists, tab grants. |
| Sieve database | `src/data/sieve.json` | The rule set (~820 rules), auto-updated weekly from a remote repository. |
| Options UI | `src/options/` | Settings pages incl. the sieve editor (`SieveUI.js`, Ace-based) with per-field regex/JS editing. |
| Bundled libs | `src/lib/` | VideoJS build (modded), Ace editor, beautifier. |
| Build | `build.js` / `build.sh` | Packages `src/` into a zip (archiver + terser). |

## Data flow (one hover)

1. Content script detects hover on an anchor / media element.
2. URL (stripped of `https?://(www.)?`) is tested against `link`/`img`
   regexes of the compiled sieve, in order; first match wins.
3. The rule's `url`/`to` fields rewrite the URL locally (page DOM is
   accessible), or the rule's `res` field hands off to the background.
4. Background fetches the page (if `res`), applies the rule's regex(es) to
   the body, and returns a media URL / album / caption — or, for function
   sieves (`res` starting with `:\n`), returns the body so the content
   script can execute the rule's JavaScript against it.
5. Content script renders the result: image, VideoJS player, album with
   captions, or an "extension item" (embedded player / iframe / sidebar /
   banner).

## Persistence

- Preferences: `chrome.storage.local` (JSON-stringified values), defaults in
  `src/data/defaults.json`, merged in `updatePrefs`.
- Sieve: `sieve` storage key; weekly alarm-driven update merges remote
  changes while preserving user-disabled rules and `_`-prefixed custom rules.
- Per-session caches (resolved albums, SVG dimensions) live in page memory.
- Sticky resolution overrides (per image / gallery / page toggles) are
  per-page memory only — never written to storage (see `Details.md` §11.7).

## Upstream

Tracked from the upstream Imagus Reborn repository (versioned
`vYYYY.M.D` release tags; current: 2026.10.31). Fork/merge history is in
git; no local divergence is intended.
