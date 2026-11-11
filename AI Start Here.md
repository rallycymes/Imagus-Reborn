# AI Start Here

Read this file first, every session. It defines how to operate within this
repository.

## Purpose

Source of the **Imagus Reborn** Firefox/Chrome browser extension (MV3) — a
hover-zoom image/video viewer. This repository is an **upstream-tracking
clone** of the extension's source, registered in the AI Project Management
hub as the companion reference for the **deviantArt Imagus Sieve** (`@da`)
project: sieve updates — especially the `@da` sieve — are built against the
sieve engine implemented here.

This is *not* a rework project. The upstream codebase's own conventions
(style, structure, commit messages, versioning) take precedence here; do not
impose hub conventions on the code. Deep understanding of the sieve engine
is documented in `Details.md` so the `@da` project does not have to re-derive
it from source.

## Ecosystem context

- Hub: `C:\Synced Files\Code Experiments\AI Project Management` (primary
  operating context; rules on writes, commits, and registration live there).
- Companion project: `C:\Synced Files\Stuff\imagus saves\deviantart` (`@da`)
  — bespoke sieve for deviantart.com, built and tested in the older
  "Imagus Mod" extension but designed for this engine.
- The parent folder (`imagus saves`) contains reference material for `@da`
  and is off-limits except for this subfolder (a registered managed project).

## Rules of engagement

1. **No random internet research** without explicit permission. This
   extension and its sieve format are bespoke/undocumented; the trusted
   references are the source in `src/`, the bundled sieve database
   (`src/data/sieve.json`), and the `@da` project docs.
2. **Documentation set contract** (`Design.md`, `Details.md`, `TODO.md`,
   this file): update in tandem with every working session, in place, no
   session logs or history sections. When docs and code disagree, trust the
   code and re-audit the docs.
3. **Read-only zones:** everything in `src/` is upstream product code — do
   not modify unless the user explicitly asks for a change to the extension
   itself. `src/data/sieve.json` is a fetched/updated database (weekly auto
   update from `sieveRepository`); treat edits to it as data imports, not
   hand-maintenance.
4. **Commits:** never commit, push, or create PRs without explicit approval
   in the session (hub rule; this repo has no rules file of its own).
5. **Writes:** this is a managed folder with git; follow the hub's
   write-permission rules (pause and report on uncommitted changes — check
   with the hub's `git-status` skill).
6. **No test harness.** The upstream project has none (`build.js` only).
   Do not add one unless asked; analysis work should be verified by reading
   code paths and, where possible, dry-running pure functions in isolation.
7. **Mark inferred knowledge** as inferred in `Details.md` until verified
   against behavior.

## Standing reminder duties

- When work here reveals facts the `@da` project needs (sieve field
  semantics, output shapes, engine changes), record them in `Details.md`
  and flag them in the `@da` project's docs — the two documentation sets
  must not drift apart.
- Curate `TODO.md` every session.
