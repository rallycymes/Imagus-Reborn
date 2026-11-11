# TODO

Focused, actionable items only. Mark done as items complete; keep curated.

## Decisions needed from the user

- (none currently)

## Tasks

- [ ] Record this bootstrap in the hub registration file
      (`Projects/Imagus Reborn.md`): rules file now exists, bootstrapped
      status, doc set pointers.
- [ ] Cross-link the `@da` project docs to the sieve I/O analysis in
      `Details.md` (§3-§7) — the `@da` docs should reference, not duplicate.
- [ ] Divergence audit: "Imagus Mod" (the `@da` test environment) vs this
      engine — record differences relevant to sieve authors in
      `Details.md` §10.
- [ ] Confirm `resolve_cache` is vestigial (content sends it, background
      has no handler, `tls.sieveCacheRes` not in defaults); decide whether
      it is worth reporting upstream.
- [ ] When any extension update lands and has a new tagged release version (git pull), re-verify `Details.md`
      against the changed sieve engine before the `@da` project relies on
      it.
