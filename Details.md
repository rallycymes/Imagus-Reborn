# Details

Deep technical reference for the **sieve engine** in Imagus Reborn: what
sieves receive as input, what they can output, and which extension features
each input/output form feeds. Everything below is verified against source
(`src/content/content.js`, `src/background/service.js`, `src/data/sieve.json`)
at version 2026.10.31 unless marked **inferred**.

Written primarily for the `@da` sieve project — this is the engine contract
that sieve authors code against.

---

## 1. Sieve database format (input to the extension)

`src/data/sieve.json` — a JSON **object** keyed by rule name (e.g.
`"[Google_Images]"`, `"032c"`). Object key order is the match order.
823 rules at the shipped version. Fields observed across the database:

| Field | Rules | Type | Purpose |
|---|---|---|---|
| `link` | 656 | regex string | Matches the hovered **link URL** |
| `img` | 497 | regex string | Matches the hovered **element's image URL** (src or CSS background) |
| `to` | 496 | string / `:\n`function / array | Local URL rewrite → final media URL |
| `res` | 577 | regex string / 2-line regex / `:\n`function | Resolves via a fetched page |
| `url` | 214 | inline `:`function | Computes the fetch URL (page-DOM aware), only used with `res` |
| `loop` | 85 | bitmask (1=link, 2=img) | Feed the result back into matching |
| `useimg` | 58 | flag | Rule `img` also tested against the hovered element's own image |
| `dc` | 17 | bitmask (1=link, 2=img) | Double `decodeURIComponent` the result |
| `ci` | 29 | bitmask (1=link, 2=img) | Case-insensitive matching |
| `off` | 7 | flag | Rule disabled (preserved across sieve updates) |
| `note` | 811 | string | Author credits/examples; stripped at compile time |

### Compilation (`cacheSieve`, service.js:124-158)

Background-side, whenever the sieve is saved/updated:

- Rules without `link` **and** `img` are dropped; `img`-only rules must have
  `to` or `res` or they are dropped.
- `off` rules are dropped (the `off` flag itself is preserved in the stored
  JSON so updates keep the state).
- `res` forms are classified:
  - starts with `":\n"` → function form; source stored in `cachedSieveRes`,
    `rule.res = 1` (marker).
  - otherwise → regex form; if it contains a newline it becomes
    `[RegExp(line1), RegExp(line2)]` (URL regex + caption regex), else a
    single `RegExp`.
- Multi-line `to` that does not start with `":\n"` → split into an **array
  of replacement strings** (service.js:153).
- `note` deleted from the runtime copy.
- `link`/`img` remain strings here; the content script compiles them into
  `RegExp` with the `ci` bit flags (`ci & 1` → link `"i"`, `ci & 2` → img
  `"i"`) in `convertSieveRegexes` (content.js:597-605).

### Sieve updates

Weekly alarm (`autoUpdateSieve`, service.js:655-678, gated by
`tls.autoUpdateSieve`) fetches `sieveRepository` (default:
`https://raw.githubusercontent.com/kuzn123/Imagus-Sieve-RuBoard/master/update.txt`).
Merge keeps local rules starting with `_` and copies the `off` state.

### Editor (`src/options/SieveUI.js`)

The sieve editor exposes exactly: `link` (+ ci/dc/loop checkboxes), `url`,
`res`, `useimg`, `img` (+ ci/dc/loop), `to`, `note`, per-rule disable.
The per-field checkboxes compile into the `ci`/`dc`/`loop` bitmasks.
Search covers notes and all fields.

---

## 2. Execution contexts

| Context | Where | Sieve code runs there |
|---|---|---|
| Content (user-script world) | `content.js`, all frames, CSP `unsafe-eval`, page DOM accessible | `link`/`img` matching, `url` functions, `to` functions, `:\n` `res` functions, loop re-entry |
| Background (service worker) | `service.js` | `res` regex execution against fetched bodies; the fetch itself |

The background fetch uses `host_permissions: <all_urls>` — no CORS
restrictions. The fetched `Content-Type` gates the outcome (see §5.3).

### 2.1 Global environment of sieve functions — `cfg` and other bindings (added 2026-11-13)

Sieve functions (`url`, `to`, `res` function forms) are compiled with the
`Function` constructor in the user-script world (content.js:1297, 3680), so
their scope chain ends at the **global lexical environment** of that world.
`common/app.js` runs as a separate classic user script in the *same* world
(service.js:622-639, at document_start) and declares top-level bindings —
all readable from sieve code:

| Binding | Contents | Sieve relevance |
|---|---|---|
| `cfg` | Settings snapshot: `hz`, `keys`, `tls`, `grants`, `grantUrls`, `sieve`, `sieveUpdateLast`, `sieveRepository` (app.js:111) | Settings flags (below) |
| `platform` | `"firefox"` / `"chrome"` (app.js:7) | Runtime detection (§4.3) |
| `Port`, `shortcut`, `app`, `readCfg`, `buildNodes`, `catchEvent` | Engine internals | None |

content.js is an IIFE — its internals (e.g. `PVI`) are not global; `PVI`
reaches sieve code only as `this` (§4.1–4.3).

Relevant `cfg` flags (defaults in `src/data/defaults.json`; all verified in
content.js at 2026.10.31):

| Flag | Default | Native behavior |
|---|---|---|
| `hz.hiRes` | `true` | "Prefer high resolution": for any returned array, `#`-prefixed entries are split from plain ones (content.js:2005-2020) and this flag decides which group shows first; the other is kept for the `keys.hiResToggle` toggle. The whole `#` mechanism is gated by it. |
| `hz.hiResOnFZ` | `3` | Auto-toggles to the hi-res group on fullzoom when the size ratio reaches the value (2812-2818) |
| `hz.capText` | `true` | Caption text visibility (751, 985, 1027, 3738); captions are still prepared/stored when off (3741-3742) |
| `hz.capWH` | `true` | Caption dimensions block; also gates `createCAP` (751) — used by the `@da` sieve (sieve-res.js:404) |
| `hz.capWrapByDef` | `true` | Caption `white-space: pre-line` vs `nowrap` (997); note `prepareCaption` flattens all `\n`/`\r` in sieve captions to spaces first (1019) |
| `hz.capPos` / `hz.capOver` / `hz.capStyle` / `hz.capFlashCount` | `0` / `true` / `0` / `1` | Caption bottom-vs-top, overlay-vs-outside, dark-vs-light, pile-cycling flicker (994-1006, 1038) |
| `hz.autoplay`, `hz.mediaLoop`, `hz.mediaVolume`, `hz.mediaVolOrient`, `hz.invertWheel`, `hz.hideControlsDelay` | `true` / `"default"` / `40` / `"horizontal"` / `false` / `2000` | VideoJS player behavior for returned media URLs (826-839, 963) |
| `hz.preload` | `0` | Preload depth 0-3: off / first item / on show / whole page (2042, 3249, 3766, 3877) |
| `hz.galleryGridSize`, `hz.pileWheel`, `hz.pileCycle`, `hz.singleArrowTimeJumpInAlbum` | `150` / `1` / `false` / `false` | Album strip UI (2775-2779) |
| `hz.scaleUp`, `hz.placement`, `hz.fullspace`, `hz.fzMode`, `hz.fzOnPress`, `hz.fzDefault`, `hz.lockedZoom` | `false` / `0` / `true` / `1` / `1` / `false` / `1` | Popup display and zoom modes |
| `hz.delay`, `hz.waitHide`, `hz.LDRdelay`, `hz.LDRbgOpacity`, `hz.LDRanimate` | `300` / `false` / `300` / `100` / `true` | Resolve timing and loader appearance (1361, 1694-1700) |
| `hz.history` | `true` | History recording; loop re-entries are flagged `IMGS_nohistory` when on (1526, 1645) |
| `keys.*` | — | Keybindings, e.g. `keys.hiResToggle` = `"Tab"`, `keys.openTab` = `"O"` |
| `tls.sendToHosts` | 6 entries | Toolbar send-to menu (219-221) |
| `grants` / `grantUrls` / `grantUrlsEnabled` | `[]` / `[]` / `true` | Site gating (§3.3) — also sieve-readable |

Sieve-actionable flags (reading them can legitimately change sieve output):

- `cfg.hz.hiRes` — tells the sieve which group of a mixed array will display
  first. Sieves must still emit BOTH groups (dropping `#` entries when
  `hiRes=false` would break the toggle). Plain arrays are not
  preference-ordered by the engine — `[low, high]` without `#` shows low
  first even for hi-res-preferring users; hand the choice to the engine
  via `#`.
- `cfg.hz.capWH` — layout of sieve-built caption text (the `@da` prefix).
- `platform` — engine/runtime divergences.

Everything else is display/player-side: the engine applies the user's
settings to whatever standard shape the sieve returns (§7). Re-implementing
them in a sieve would duplicate engine behavior and risk divergence between
Imagus Mod and Reborn.

---

## 3. Inputs: what gets matched

### 3.1 Candidate URLs (content.js `find`, 1365-1532)

- **Link URL** (`link` field): the `href` of the hovered `<a>`, else the
  nearest anchor among up to 5 ancestors. SVG `xlink:href` is treated as an
  href. Loop re-entries and album entries arrive as pseudo-elements
  `{ href: url }`.
- **Image URL** (`img` field), via `getImages` (1200-1235):
  - `imgSRC`: element `src`/`currentSrc` (IMG, SVG `image` xlink:href).
  - `imgBG`: CSS `background-image` `url()` of the element, or of an
    overlapping parent. Only single-`url()` backgrounds qualify.
  - Tiny images (<3 px on either side) are ignored.
- Anchors containing `iframe`/`object`/`embed` are skipped (1385).

### 3.2 URL normalization before matching

- Protocol-relative `//…` gets the page protocol; then the prefix
  `^https?://(www.)?` is **stripped** (`rgxHTTPs`, content.js:585).
- **`link`/`img` regexes match against the URL without scheme (and www)**.
- Capture groups of the match become the `$` parameters (see §4.2).

### 3.3 Gating before a rule applies

- Page-level grants (extension enabled/disabled per site).
- `grantUrls` ignore list (context-menu "ignore element", strings like
  `!:<url>` or `!!:<regex>`) — checked against the matched URL.
- The hovered anchor's href equal to the page URL is skipped (1451).
- If the rewritten result equals the trigger element's own `src`, it is
  discarded (no point re-showing the same image, 1468-1476).

### 3.4 Match order

Rules are tried in database order; the **first** rule whose `link` (or
`img`, when applicable) matches wins. `useimg` makes the rule's `img` also
test the hovered element's own image (SRC first, then BG) so that a link
whose thumbnail matches can be handled by the img part of the rule.

---

## 4. Field semantics, in execution order

### 4.1 `url` — inline fetch-URL function (content script)

Only meaningful together with `res`. Compiled by `toFunction(rule, "url",
inline=true)` (content.js:1294-1308): value must start with `":"` followed
by an **expression** (no newline required); compiled as
`Function("var $ = arguments; return <expr>")` bound to the content-script
object. Invoked as a `String.replace` callback against the stripped URL:

- `$[0]` — full matched (stripped) URL; `$[1..n]` — capture groups of the
  `link`/`img` regex.
- `this` — content-script API object; **`this.node`** — the hovered element.
  Full page DOM access (e.g. reading `document.URL`, querying selectors).
- Return value:
  - string → the URL to fetch (protocol-relative etc. re-prepended via
    `httpPrepend`).
  - `""` → **`skip_resolve`**: no fetch at all; the `res` function runs
    immediately with no body (content.js:1350-1354, 1454, 1461).
  - Errors are logged as `[rule N] <message>` and show the `R_js` error.

### 4.2 `to` — local rewrite, no network (content script)

Either a replacement string (`"$1…"`, standard `String.replace` semantics)
or a function (`":\n"` prefix, compiled with `var $ = arguments;` and bound
to the content-script object, content.js:1294-1308; invoked the same way as
`url`). Semantics (`replace`/`_replace`, content.js:1237-1291):

- `$[0]` = matched URL, `$[1..n]` = capture groups (function form).
- Return string → the final media URL (scheme re-prepended).
- **Multi-line function output → array of URLs** — each line is
  re-processed as its own URL (album/fallback list, §5.2).
- Multi-line *string* `to` was already split into an array at compile time;
  each entry is a replacement pattern.
- `dc` bit applies (link: `dc !== 2`; img: `dc > 1`) → result is double-
  URI-decoded (1258).
- `to[0] === "#"` → the result is prefixed with `#` (1259) — see hi-res
  groups (§5.2).
- Return `2` (empty replacement) → treated as "no enrichment";
  return `null` → abort.

### 4.3 `res` — network resolution (background + content)

**Regex form.** The background fetches the URL (§5.3) and applies the rule's
regex(es) to the body (service.js:406-437):

- Before matching, `$0`–`$n` appearing in the regex source are **pre-
  substituted** (regex-escaped) with the capture groups from the original
  `link`/`img` match (service.js:408-422). This is how the sieve "knows"
  the original URL when building the search pattern.
- `match[1]` → the resolved media URL, resolved against `<base href>` (from
  the first 4 KiB of the body) or the fetched URL (`withBaseURI`).
- `match[2]`+ (or the second-line caption regex's captures) → caption,
  captures joined with `" - "` (service.js:424-433).
- `dc` bit applies to `match[1]` (double decode, service.js:427-429).
- No match → `m: null` → failure path (§6).

**Function form (`":\n"`).** The background fetches the URL and returns the
body; the content script executes the code (content.js:3679-3687):

```js
Function("$", code).call(PVI, params)
```

Inside the function:

- `$[0]` — the original full href; `$[1..n]` — capture groups of the
  `link`/`img` match.
- `$._` — the fetched response **body text** (res:1 path, service.js:399-404).
- `$.base` — the base directory URL (used with `$.url` for absolute-izing
  relative paths).
- `$.url` — the fetch URL (array `[url, postData?]` until joined).
- `this` — content-script API object (`this.node` = hovered element,
  `this.TRG` = trigger, `this.set(...)`, `this.DIV`, etc.).
- May set `this.TRG.IMGS_ext_data` (extension items, §5.4) before returning.
- Observed `this` members used by community sieves (corpus evidence): `this.node`
  (hovered element, `this.node.src` as fallback return), `this.TRG`, `this.CNT`
  (mutable carrier — `this.CNT.filename` sets the download filename), and custom
  properties (e.g. `this._bunkr_data_`) used as a persistent per-sieve cache across
  invocations/loops.
- Browser APIs available in this content-script world: `document`, `window`,
  `location`, `XMLHttpRequest` (synchronous allowed), `DOMParser`,
  `  structuredClone`; some sieves read a `platform` object (`platform.firefox`)
  for runtime detection. User settings via `cfg` (e.g. `cfg.hz.capWH`,
  `cfg.hz.hiRes`, `cfg.hz.mediaVolume`) — full exposure map in §2.1.
- Return shapes: see §5.
- POST support: the fetch URL may embed `" :<postdata>"` after a space;
  the background sends it as a urlencoded POST body (service.js:365-378).

**`skip_resolve`** (from `url` returning `""`): the function still runs —
synchronously, with `$` params but **no `$._` body** — and its result goes
back to the caller (`return_url` path).

### 4.4 `loop` — chained resolution

Bitmask: `1` = loop when the `link` regex matched, `2` = when `img` matched
(content.js:1538; same mask logic for background results, 3749-3752). When
the final result is a string, it is **fed back into `find`** as a new
candidate URL and matched against the whole sieve again (max 5 hops,
`IMGS_loop_count`, 1539-1544). A `res` function can also return
`{ loop: "url" }` to force a loop regardless of the bitmask (3713-3715), and
the background can set `noloop` (direct-media case, 3684).

---

## 5. Outputs: result shapes and consumption

### 5.1 Normalization (`onMessage` "resolved", content.js:3670-3783)

A `res` result passes through:

- object with `""` key (and optional numeric `idx`) → unwrapped to `d.m[""]`,
  `idx` selects the album start position.
- object with string `loop` → forced loop (§4.4).
- array → album/caption handling (§5.2).

### 5.2 Output shapes

| Shape | Meaning |
|---|---|
| `"url"` string | Single media URL (image, or video/audio if it matches `isVideoUrl`) |
| `["url1","url2",…]` | Ordered **fallback list**: on load error the next entry is tried (`content_onerror`, 2096-2125) |
| entries prefixed `"#"` | **Hi-res group**: separated from the normal list; the hi-res toggle (`keys.hiResToggle`, default Tab; `hz.hiRes`) switches between groups (`set`, 2000-2021; `IMGS_HD_stack`) |
| `[[url,caption],…]` (2+) | **Album**: gallery strip + prev/next navigation; `caption` shown in the caption bar; first element of the stored stack is the current index (`album`, 1911-1970) |
| `[[url,caption]]` (1) | Single item **with caption** |
| `"imagus://extension"` | Triggers the extension host (§5.4) |
| `false` / `null` | Failure → error message or fallbacks (§6) |
| `""` from `url` | Skip the fetch; `res` function decides everything locally |

### 5.3 Background fetch semantics (`resolve` cmd, service.js:347-440)

- URL `"<url> :<postdata>"` → POST (`application/x-www-form-urlencoded`).
- If the response `Content-Type` is `image/*`, `video/*`, or `audio/*`, the
  fetch URL itself is returned as the resolved media with `noloop = true` —
  sieve regexes never run on binary media.
- Otherwise the whole body text is used for regex/function sieves.
- `<base href>` (first 4 KiB) overrides the base for relative resolution.

### 5.4 Extension items (the `imagus-extension` host)

A `res` function can set `this.TRG.IMGS_ext_data = [[mediaUrl, caption], …]`
and return `"imagus://extension"` (or an object `{ loop: "imagus://extension" }`).
Caption strings may embed tags like:

```html
<imagus-extension type="videojs" url="…" custom-style="…">fallback text</imagus-extension>
```

Types rendered by the host (`[Extension]` rule + content.js `show` override,
and `parseExtensionItem`, 1972-1975):

- `videojs` — embedded VideoJS player for the given URL (HLS/DASH via
  bundled VideoJS; `loop=false` in the URL disables looping).
- `iframe` — embedded page (YouTube URLs are converted to embed URLs;
  control toggle overlay).
- `sidebar` — 360 px text panel rendered next to the popup.
- `banner` — clickable banner with text, linked to `url`.
- `custom-style` attribute injects extra CSS for the host.

Album entries whose caption carries a `videojs` extension tag are converted
to playable items by `parseExtensionItem` (1954, 3699-3704).

---

## 6. Failure modes and fallbacks

| Situation | Behavior |
|---|---|
| No rule matches | Internal non-sieve features: `srcset` analysis and enlargeable-thumbnail zoom (`imgFallbackCheck`, 1572+) |
| `res` regex doesn't match | `R_res` error message; if the trigger has an `IMGS_fallback_zoom` (srcset-found larger source) it is shown instead (3772-3777) |
| `res` function throws | `R_js` error message (3688-3692) |
| `to` function compile error | Rule aborted (`1`) |
| Media load error | Next entry of the fallback array, then HD stack, then fallback zoom, else `R_load` (2096-2125) |
| Loop chain fails mid-way | Falls back to the previous chain result (1540-1544) |

Error labels shown in the popup: `R_res` (no resolution), `R_js` (rule JS
error), `R_load` (media failed to load).

---

## 7. Output → extension feature correlation

| Sieve output | Feature that consumes it |
|---|---|
| Image URL string | Popup viewer: zoom modes (orig/fit/fit-W/fit-H/locked, keys 1-5/0), rotate/flip (E/R/Q/W), fullZoom (`Z`), fullspace (`F`), drag, resize modes, caption bar with dimensions (`capWH`), history recording (`hz.history`), download (`S`/toolbar), copy URL, open in tab (`O`), send-to-hosts (`S`: Google Lens/TinEye/Bing/Yandex/ImgOps/QR), gallery preview on hover |
| Video/audio URL (`isVideoUrl`: `.m4a .m4b .m4p .m4r .m4v .mp3 .mp4 .oga .ogg .ogv .flac .webm .mov .mka .mkv .f4v .mpd .m3u8` extensions, or `#mp4 #mp3 #video` fragments; content.js:515-520) | Bundled VideoJS player: play/pause (`Space`, Ctrl+Space), seek arrows, speed rates, quality selector (max-quality-selector), volume (`hz.mediaVolume`, wheel scroll incl. inverted option), loop (`hz.mediaLoop`, `#`-param override), fullscreen |
| Fallback array | Sequential retry on load error |
| `#`-prefixed entries | Hi-res toggle feature (`Tab` key / `hz.hiRes` / `hiResOnFZ`) |
| Album array | Gallery strip (`A`), prev/next (`,`/`.` or arrows), pile wheel/cycling (`hz.pileWheel`, `hz.pileCycle`), per-item captions, jump-to-caption regex (`album(idx)` string form), preloading of upcoming items (`hz.preload`) |
| `[url, caption]` | Caption bar; copy-caption toolbar button; caption used by extension items |
| `imagus://extension` + `IMGS_ext_data` | Extension host: embedded VideoJS (HLS/DASH), iframes (incl. YouTube embed conversion), sidebar info panel, banner, custom CSS |
| SVG URL | Dimension probe (offscreen `<img>`, max 500 px) then correctly-sized display |
| Resolved URL + `hz.history` | Recorded into browser history |
| `res:1` + `$._` body | Page-scraping sieves (full DOM/regex freedom in content script) |
| `{ loop: … }` / `loop` bitmask | Multi-hop resolution chains (e.g. link → detail page → media) |
| `url` fn + page DOM | Site-aware fetch-URL construction (uses the real hovered element) |

Input-side correlations: `link` matching powers hover-on-link resolution;
`img` matching powers hover-on-thumbnail/background-image resolution;
`useimg` powers link+thumbnail rules; `grants`/`grantUrls` power the
site-toggle button (badge `X`) and the context-menu ignore feature.

---

## 8. Caching and debugging

- **Result cache:** content sends `resolve_cache` when `tls.sieveCacheRes`
  is set (content.js:3706-3707) — but the background has **no handler** for
  that command and `sieveCacheRes` is absent from `defaults.json`
  (**inferred**: vestigial/disabled feature; caching effectively does not
  happen). Album stacks (`PVI.stack`) and resolved-URL per-element caches
  (`IMGS_c_resolved`) are per-page memory only.
- **Rule debugging:** `hz.debugRules` injects `debugger;` into compiled
  rule functions and logs every rule match to the console
  (1298, 1442-1444, 1500-1502).

## 9. Known smells / quirks

- `package.json` version (`1.0.0`) never bumps; real version lives in the
  manifests (`2026.10.31`).
- `resolve_cache` dead path (see §8).
- `cachedSieve` local in `cacheSieve` shadows the module-level
  `cachedSieveRes` pairing — indices must stay in sync with rule order
  (rule `id` = index in the compiled array).
- `url` inline functions and `to` functions share the `":"` prefix but
  differ in newline requirement (`":\n"` vs `":expr"`); a `to` function
  missing the newline will not compile as a function.
- Vestigial settings read by code but absent from `defaults.json` (always
  undefined/falsy): `hz.capNoSBar` (content.js:1662, 3183, 3244),
  `hz.capLinkText` (only in commented-out code, 1667-1669); `cfg.messages`
  and `cfg.app` are read undefined-safe but never present. `tls.sieveCacheRes`
  (see §8) is likewise absent. What actually exists is listed in §2.1.

## 10. Relevance to the `@da` sieve project

- The `@da` sieve targets this engine's contract: `link`/`img` regexes see
  scheme-less URLs; `to`/`url`/`res` follow §4; output shapes follow §5.
- The `@da` project's generated `res` code must assume the function-form
  environment of §4.3 (`$`, `$._`, `$.base`, `this.node`, `this.TRG`).
- Fields the `@da` generator emits map 1:1 to the editor fields (§1) and
  the bitmask semantics (ci/dc/loop per link/img).
- DeviantArt sieves are tested in "Imagus Mod" (older engine); any
  Mod/Reborn divergences discovered should be recorded here and in the
  `@da` docs (**inferred**: divergence audit not yet done).

---

## 11. Hi-resolution ("hiRes") toggle mechanics (added 2026-11-21)

Documents the engine's resolution-preference machinery as of branch
`Sticky_Res` **before** the Sticky Resolution feature lands (see `TODO.md`);
line numbers will shift once that feature modifies these sites — re-verify
then. All in `src/content/content.js` (3973 lines at this version) unless
noted. Relevant to sieves because rules can read `cfg.hz.hiRes` directly
(§2.1) and emit `#`-prefixed entries (§4.2, §5.2).

### 11.1 `hz.hiRes` consumption sites

| Line | Role |
|---|---|
| 2014–2017 | `PVI.set()` `#`-split: seeds per-trigger HD flag and picks the displayed group |
| 2214 | `assign_src()` auto-upgrade: thumbnail not enlargeable + HD group stashed → auto `hiResToggle()` |
| 2807 | Shift+hotkey flips the global in-memory snapshot (undocumented in UI) |
| 2812–2816 | `switchToHiResInFZ()`: fullzoom auto-toggle gate (`hiResOnFZ` doubles as aspect-ratio limit) |
| 3492, 3558 | Preload selects the URL group matching the current `hiRes` |
| 1082, 2160, 2276 (indirect) | Caption "HD available" color; crosshair cursor when low group shown |

Sieve rules may also read `cfg.hz.hiRes` directly (e.g. the Instagram rule
in `sieve.json`) — they see the static snapshot, not any per-image override.

### 11.2 The `#`-split in `PVI.set()` (2000–2021)

For an array source, entries are split at load: `#`-prefixed → HD group,
plain → normal group (prefix stripped; `httpPrepend` applied). With both
groups present: `IMGS_HD` (bool) and `IMGS_HD_stack` (the non-displayed
group) are stored as **expando properties on the trigger DOM element**
(`PVI.TRG`); the displayed group goes to `IMGS_c_resolved`. Edge case: only
HD entries → no toggle state is created at all. Re-entering `set()` via the
toggle finds no `#` entries left, so the state is preserved across one swap.

### 11.3 `PVI.hiResToggle()` (2797–2809) and the `IMGS_HD_stack` swap

Swaps `IMGS_HD` and `IMGS_HD_stack` and reloads the other group. The stack
also participates in error-fallback (`content_onerror` 2111–2115, which
**deletes** both on the error path) and the auto-upgrade (11.1). The
Shift+hotkey variant additionally flips `cfg.hz.hiRes` **in the tab's
in-memory snapshot only** — no `savePrefs`, so it dies with the page; it is
a crude per-tab "default flip" with no UI documentation.

### 11.4 Why the toggle is "forgotten" in galleries

All toggle state lives on `PVI.TRG`. `PVI.album()` — the single navigation
primitive every gallery path funnels into (arrow keys 2637, wheel 3047/3055,
grid click 2787, gallery open 2734, resolver results 3763) — calls
`PVI.resetNode(PVI.TRG, true)` at 1957; the delete list (1149–1166) includes
`IMGS_HD`/`IMGS_HD_stack`. Each navigation re-derives state from the static
`cfg.hz.hiRes` via `set()`. This is also the root cause of the fullzoom
ratio-check "not sticking" (previously a TODO item).

### 11.5 State containers and lifetimes

- **TRG expandos** (`IMGS_HD`, `IMGS_HD_stack`, `IMGS_c`, …): per trigger
  element; wiped by `resetNode` (hover move, album nav, mutation sweeps).
- **`PVI` closure object** (550–571): one per frame, survives popup
  open/close; dies with the page/frame.
- **`PVI.stack`** (album arrays keyed by album ID; `album[0]` = position
  pointer): the only page-level container that persists across popups;
  entries are `[src, caption, preview]` triples — the raw (still
  `#`-prefixed) URLs survive, so each album entry re-splits on navigation,
  but **no HD flag is stored**. Wiped on `reinit` (3811).
- **`cfg` snapshot** (delivered by the `hello` handshake, content.js:3866;
  §2.1): per-tab, in-memory; content-side mutations are lost on page load
  unless explicitly sent via `Port.send({cmd:"savePrefs"})`.

### 11.6 Key plumbing

`shortcut.key(e)` (app.js:117–191) → `PVI.key_action` (2465–2718); the
hi-res branch at 2568 fires only when a popup is loading/visible (2526).
Unset/empty `keys.*` bindings simply never match. `hiResToggle` default
`"Tab"` (`defaults.json`); the Shortcuts page binds `keys_hiResToggle`
(options.html:603) with generic capture/duplicate detection (options.js
610–634).

### 11.7 Sticky Resolution feature targets (branch `Sticky_Res`)

The feature adds per-image / per-gallery / per-page override layers
(specificity: image > gallery > page > global `hz.hiRes`) with page-memory
lifetime, redesigning 11.2–11.4 accordingly; `set()`/preload consume an
effective-preference resolver, album navigation stops destroying per-image
state, and the Shift variant becomes a Per Page alias. Sieve-visible note:
sieves reading `cfg.hz.hiRes` will still see the global snapshot, not the
sticky overrides — do not expect sieve output to react to per-image/page
toggles.
