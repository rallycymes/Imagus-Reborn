# TODO

Focused, actionable items only. Mark done as items complete; keep curated.

## Sticky Resolution (branch `Sticky_Res`)

Toggle which preferred resolution the user currently wants to operate in,
instead of the preference being a static setting. Active feature work; the
engine mechanics it modifies are analyzed in `Details.md` §11.

### Design decisions (recorded 2026-11-21)

- **Main toggle hotkey**: the existing `keys.hiResToggle` (default `Tab`) is
  reused as the main day-to-day toggle; it drives whichever of the first
  three scopes is selected. Relabeled on the Shortcuts page; no new main key
  entry.
- **Individual Hotkeys mode**: the main toggle key is inert; three
  re-bindable sub-hotkeys (Per Image / Per Gallery / Per Page) take over.
  Sub-hotkeys default unbound; their Shortcuts section is greyed/disabled
  unless this mode is selected.
- **Per Gallery on standalone images**: falls back to per-image remembering.
- **Per Page**: state lives in the top frame and governs all popups on the
  page, including popups triggered inside iframes (via the existing frame
  `postMessage` channel).
- **Shift+hotkey** (currently a hidden, undocumented global in-memory flip
  of `hz.hiRes`, content.js:2806-2808): kept, remapped as a Per Page toggle
  alias regardless of the selected mode. Inert when remembering is disabled.
- **Override specificity**: per-image > per-gallery > per-page > global
  `hz.hiRes` (explained in the parent setting's tooltip; more specific
  toggles override more general ones).
- **"Remember toggled resolution preferences" unchecked**: exactly the
  current behavior (toggle affects the current single image only, forgotten
  on gallery navigation); the scope radios grey out.
- **No persistence across page loads** — all sticky state is page memory
  (the parent setting's tooltip explains this).
- **New prefs** (`defaults.json`): `hz.hiResRemember` (bool, default
  `true`), `hz.hiResScope` (string enum `"image"|"gallery"|"page"|"hotkeys"`,
  default `"image"`), `keys.hiResToggleImage` / `hiResToggleGallery` /
  `hiResTogglePage` (default unbound, `""`).
- **UI placement**: a new "Resolution" section on the Preferences page at
  the same level as General and Media, slotted between them. "Prefer images
  with higher resolution" moves there, renamed "Generally prefer images with
  higher resolution" (its `hiResOnFZ` sub-item moves along), followed by the
  new "Remember toggled resolution preferences" parent checkbox (default
  checked, with a tooltip) and its scope radio group (Per Image default,
  Per Gallery, Per Page, Individual Hotkeys).
- Only `_locales/en/messages.json` gets new strings; the other 13 locales
  fall back to English (`default_locale`).
- No test harness exists; verification is manual (build, then exercise each
  mode — deviantart galleries as the test bed).

### Tasks

- [x] `defaults.json`: add the new prefs/keys listed in the design decisions.
- [x] Engine (`content.js`) — override containers: per-image map keyed by
      resolved URL (page memory; survives `resetNode`), gallery flag stored
      on the album array object in `PVI.stack`, per-page flag in the top
      frame with iframe relay; plus the effective-preference resolver
      (per-image > per-gallery > per-page > global `hz.hiRes`).
- [x] Engine (`content.js`) — rewiring: `set()` `#`-group split and preload
      selection consume the resolver; `hiResToggle()` writes the flip at the
      active scope with Shift as the Per Page alias; `key_action` dispatches
      by mode, main key inert in Individual Hotkeys mode; `album()`
      navigation no longer loses per-image state (`resetNode` wipes only the
      trigger expandos; the URL-keyed map survives); error-fallback,
      `assign_src` auto-upgrade and fullzoom auto-toggle stay per-image swap
      only; `hiResRemember=false` bypasses the sticky system entirely
      (legacy behavior). Implementation documented in `Details.md` §11.7.
- [x] Preferences page (`options.html` + en locale): new Resolution section
      header between General and Media; moved the `hz_hiRes` row +
      `hz_hiResOnFZ` sub-item; renamed label; Remember checkbox with
      tooltip; scope radio group (bespoke radio handling in
      `load()`/`save()`/`onValueChange`, custom radio styling).
- [x] `options.js`: bespoke radio-group load/save and dirty tracking;
      grey-out wiring (`updateHiResUi`: Remember unchecked -> radios
      disabled; scope != "hotkeys" -> sub-hotkeys disabled).
- [x] Shortcuts page (`options.html` + `options.css`): relabeled the main
      toggle entry; new "Resolution" group header + three sub-hotkey inputs;
      greyed/disabled styling for inputs.
- [x] `_locales/en/messages.json`: all new keys (section header, renamed
      hi-res label, Remember label + tooltip, scope label + radio labels,
      SC_ labels for the main and sub-hotkeys). Other locales untouched
      (English fallback).
- [ ] Manual verification: build; exercise all four modes on galleries
      (deviantart test bed), single images, and iframe-hosting pages; verify
      the Shift alias and the Remember-off legacy path.
- [x] Post-feature doc sync: `Details.md` §2.1 cfg flags table and §11.7
      implementation notes, `Design.md` persistence notes.

## Decisions needed from the user

- Report the dead `resolve_cache` path upstream? (Confirmed vestigial 2026-11-10:
  content sends it only when `tls.sieveCacheRes` is set — a pref absent from
  `defaults.json` — and the background has no handler for the command; caching
  effectively never happens.)

## Tasks

- [x] Record this bootstrap in the hub registration file (done 2026-11-10).
- [x] Cross-link the `@da` project docs to the sieve I/O analysis in `Details.md`
      (done 2026-11-10: `@da` now references this repository as the source of truth
      for sieve I/O details and keeps only highest-level summaries locally).
- [ ] When any extension update lands and has a new tagged release version (git pull), re-verify `Details.md`
      against the changed sieve engine before the `@da` project relies on
      it.
- [ ] **Transform the sieve analysis in `Details.md` into a proper documentation
      suite.** Propose an organization and work with the user interactively to create
      something useful, first from the developers' perspective (engine internals,
      rule formats, debugging/contribution), then from the standard users' perspective
      (features, settings, day-to-day usage). Evaluate a **bifurcated documentation
      setup** (separate dev-docs and user-docs trees) and decide with the user whether
      it is useful or unnecessarily complex.
- [x] Create a userscript for toggling the "Prefer images with higher resolution" setting with a hotkey. Useful for deviantart.
      (superseded 2026-11-21 by the Sticky Resolution feature — in-extension hotkey control instead.)
- [x] Investigate full zoom -> ratio check. Works inconsistently and doesn't appear to stick when switching between images in a gallery.
      (root cause found 2026-11-21: `PVI.album()` calls `resetNode`, which wipes the per-image hi-res toggle state on every
      gallery navigation — content.js:1957 and 1149-1166. Handling is folded into the Sticky Resolution tasks; the
      fullzoom auto-toggle itself keeps per-image semantics by design decision.)