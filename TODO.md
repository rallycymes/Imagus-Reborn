# TODO

Focused, actionable items only. Mark done as items complete; keep curated.

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
- [ ] Create a userscript for toggling the "Prefer images with higher resolution" setting with a hotkey. Useful for deviantart.
- [ ] Investigate full zoom -> ratio check. Works inconsistently and doesn't appear to stick when switching between images in a gallery.