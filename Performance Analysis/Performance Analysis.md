# Performance Analysis — Imagus Reborn

**Branch analyzed:** `Sticky_Res` (vs `master`)
**Scope:** (1) the changes on the current feature branch ("sticky resolution" / hi-res state memory), (2) backend state management (`background/service.js`, `common/app.js`, messaging), (3) frontend user-interaction hot paths in `content/content.js` (hover, gallery browsing, wheel/zoom, keys). Options pages are out of scope.

Severity legend: 🔴 hot-path / user-visible, 🟡 significant cost, 🟢 minor.

- **Part 1** is static analysis of the code.
- **Part 2** is an evidence-based analysis of the Firefox profiler recording in this folder (`Firefox 2026-11-23 13.19 profile.json.gz`), covering three deliberate, spaced-out gallery hovers on **deviantart.com**. Part 2 maps each measurement to code paths and recalibrates the Part 1 priorities.

---

## 1. Feature branch changes (Sticky_Res)

### What the branch does
Adds "sticky" hi-res state with three scopes (per-image / per-gallery / per-page):

- `PVI.hiResImages` map (content.js:563) — per-image on/off remembered by URL key.
- `PVI.hiResPageVal` (content.js:562) — page-scope value, relayed across frames via `postMessage`.
- `PVI.TRG.IMGS_hdKey` — node expando holding the lookup key, set in `set()` (content.js:2017), deleted in `resetNode()` (content.js:1159).
- Resolution chain: `hdEffective()` (content.js:2805) → `hdPreloadEff()` (content.js:2818) → applied in `set()` (content.js:2016–2023), `_preload()` (content.js:3579), `preload()` (content.js:3644), and `switchToHiResInFZ`/`hiResToggle`/`hiResWrite`.
- Frame relay: `hiResRelay`/`hiResPageSet` and extended `winOnMessage` (content.js:2858–2877, 3681–3709).

### Findings

**1.1 🔴 `hiResImages` is an unbounded, never-evicted cache (content.js:563)**
Every "image"-scope toggle writes a full URL string key into `PVI.hiResImages`. Nothing ever removes entries — not `resetNode` (which deletes the *node's* `IMGS_hdKey` but not the map entry, content.js:1159), and not `reinit` (which clears `PVI.stack` but not `hiResImages`, content.js:3906). On endless-scroll pages (Reddit, image boards) the map grows with every resolved image for the lifetime of the tab. Each entry is small (one URL string + boolean), so growth is slow, but it is strictly monotonic and pairs with the already-unbounded `PVI.stack`. Recommend: cap the map (LRU or "clear when > N entries"), or clear it in `reinit` alongside `PVI.stack`.

**1.2 🟡 `hdEffective()` and `hdPreloadEff()` are duplicated logic (content.js:2805–2829)**
Two nearly identical resolution chains with subtly *different* key normalization: `hdPreloadEff` builds the key by stripping `#` and prepending the page protocol for protocol-relative URLs (content.js:2820–2821), while `hdEffective` reads the key stored by `set()` as `src_left[0]` — a URL that already went through the full `httpPrepend()` (content.js:2012–2013, 2017). For most URLs the results coincide, but for URLs that `httpPrepend` normalizes differently (e.g. scheme-less hosts) the write key and the lookup key can diverge, so sticky state silently misses. Beyond correctness, this is a maintenance/perf bad pattern: the same lookup logic is now executed in three places (`set`, `_preload`, `preload`) and must be kept in sync. Recommend: one canonical `hdKeyFor(url)` + one `hdEffective(key)`.

**1.3 🟢 `hiResWrite()` calls `hdEffective()` twice (content.js:2844, 2855)**
Once for `val`, once again in the swap check. A single cached call suffices. Trivial cost, but it sits on a keypress handler that also triggers `hiResSwap` → `PVI.set()` (full image reload) — worth tidying.

**1.4 🟢 Frame relay fan-out is bounded and fine (content.js:2858–2877, 3688–3694)**
`hiResRelay` posts to direct children; each child relays to its own children via `winOnMessage`'s `hiResPageSet` branch, giving an O(total frames) tree broadcast per page-scope toggle. That's acceptable — it fires only on an explicit keypress. Note all messages use `postMessage(..., "*")` (wildcard target origin) — pre-existing pattern, now used by one more message type; a security/robustness concern more than perf.

**1.5 🟢 `winOnMessage` extension is cheap (content.js:3684–3697)**
The `toggle`/`preload`/`isFrame` relay now carries an extra `hiResPage` field and every relayed command passes through the same fan-out loop. Negligible per-event cost.

**1.6 🟢 Preload-path changes are fine (content.js:3576–3586, 3641–3651)**
`hdPreloadEff` is called once per URL (or once per source array in `preload()`); it's a couple of map lookups. No regression here.

**1.7 🟢 Good call: sticky state is memory-only**
Nothing on this branch touches `chrome.storage` — sticky state lives and dies with the page. Contrast with other hotkey toggles that persist prefs on every use (see 3.10 below). This is the right trade-off for a per-page feature.

**Verdict:** the branch adds no meaningful CPU cost on the interaction hot path. Its only real issues are (1.1) unbounded growth and (1.2) duplicated/possibly-mismatched key logic.

---

## 2. Backend state management

### Architecture
- All state lives in `chrome.storage.local` as **JSON-stringified values**; `cfg.get`/`cfg.set` parse/stringify on every access (service.js:35–58).
- On startup, `updatePrefs(null)` merges defaults + stored prefs into the in-memory `cachedPrefs` and pre-compiles the sieve into `cachedSieveRes` / `cachedPrefs.sieve` (service.js:124–158, 180–258).
- Content scripts get config via the `hello` handshake (`initTab`, service.js:680–701); resolves run in the background via the `resolve` command (service.js:347–440).
- A `keepAlive()` interval (service.js:610–613) plus an `autoUpdateSieve` timer (service.js:653–654) keep the worker warm.

### Findings

**2.1 🔴 `updatePrefs()` is a full-state rebuild triggered by every trivial pref change (service.js:180–258)**
Every `savePrefs` message — including hotkey-driven ones from the content script (`resizeMode` memory mode content.js:2669, `scaleUp` content.js:2680, `fullspace` content.js:2685, `galleryGridSize` content.js:3108, `lockedZoom` content.js:3245) — causes the background to:
1. `fetch("/data/defaults.json")` (service.js:183),
2. re-read **every** pref key from storage and JSON.parse each (service.js:184),
3. rebuild + rewrite all changed keys,
4. **always** rebuild the context menu (service.js:246),
5. re-fetch and re-`cacheSieve` the whole sieve (service.js:247–253) — a deep clone via `JSON.parse(JSON.stringify(...))` plus recompilation of every rule regex (service.js:126, 140–146).

**2.2 🔴 Every object-typed pref is unconditionally written on every `updatePrefs` (service.js:190)**
`if (typeof defaults[key] === "object") { isChanged = true; ... }` — for `hz`, `keys`, `tls`, etc. `isChanged` is hard-coded `true`, so the complete object (including the multi-hundred-KB sieve when routed through here) is re-serialized and rewritten even when nothing changed. Combined with 2.1, one small hotkey toggle rewrites the entire pref object set.

**2.3 🔴 Hot-path coupling: wheel-zoom writes prefs per tick**
`PVI.resize` saves `lockedZoom` on **every zoom step** when `resizeMode === zoomLock` (content.js:3240–3247), and gallery ctrl+wheel saves `galleryGridSize` per tick (content.js:3105–3110). Each tick therefore triggers the whole 2.1/2.2 pipeline: defaults fetch → full storage read → full object rewrite → context menu rebuild → sieve re-cache. On a fast trackpad this is dozens of full-pipeline runs per second, all in the background process. Recommend: debounce pref saves (e.g. 500 ms trailing), write only the changed sub-key, and split the "persist" path from the "cache rebuild" path.

**2.4 🟡 `initTab` ships the full compiled sieve to every frame (service.js:680–701, content.js:4055)**
User scripts are registered `allFrames: true` (service.js:625, 634); each frame that receives its first mousemove sends `hello` and receives `hz`, `sieve`, `tls`, `keys`, `grantUrls`, `messages`. The serialized sieve can be hundreds of KB, and each frame then `JSON`-parses it and **recompiles every rule regex** (`convertSieveRegexes`, content.js:599–607). On an iframe-heavy page this multiplies both message serialization cost and per-frame memory by the frame count. Recommend: parent frames already relay content to the top frame (`winOnMessage`); consider having frames fetch the sieve lazily on first rule match, or share the compiled rule list from the top frame.

**2.5 🟡 `keepAlive()` keeps the service worker permanently resident (service.js:610–613)**
`setInterval(getPlatformInfo, 25_000)` defeats worker suspension. The state it protects (`cachedPrefs`, `cachedSieveRes`) is rebuilt on every startup via `updatePrefs` (service.js:865–866), so suspension would cost a re-init (~the startup path that already runs), not correctness. Keeping a worker alive 24/7 trades continuous memory + battery for skipping one re-init per suspension. At minimum make it configurable; better, rely on `chrome.storage.session` or rebuild-on-wake.

**2.6 🟡 `"resolve_cache"` message is sent but never handled (content.js:3802; service.js:270–441)**
The content script caches resolve results and sends `{cmd: "resolve_cache", ...}` — the background `onMessage` switch has no such case, so the sieve-response caching feature silently dead-ends. Every re-hover of a rule-resolved link re-fetches the remote page in the background (service.js:375–390). This is both a perf feature that doesn't work and a recurring network cost.

**2.7 🟡 Storage-as-JSON-strings doubles parse cost (service.js:35–58)**
Every read JSON.parses every requested key; the sieve is the dominant key and is parsed in full on each request (`cfg.get(["sieveRepository","sieve"])` in `updateSieve`, service.js:72; `cfg.get("sieve")` paths at service.js:114, 248). Consider storing the sieve once as an object (storage.local supports structured clone) or caching parsed results keyed by a version number.

**2.8 🟢 `downloadItems` map can retain entries + `sendResponse` callbacks (service.js:482, 526, 590–608)**
Entries are cleaned on `complete`/`interrupted`, but if the SW restarts mid-download the map is empty anyway (worker died) — the leak window is small. Entries do capture `sendResponse`, holding a message channel open; delete eagerly on `error` events regardless of prefix (currently USER_* errors keep the entry, service.js:594).

**2.9 🟢 `deinitTabs()` broadcasts "reinit" to every tab on any grant change (service.js:445–450, 802)**
Each receiving tab runs `resetAllNodes` + full re-handshake (content.js:3902–3908). Only tabs on the affected origin need it. Rare event, but the blast radius is all tabs.

**2.10 🟢 `onMessage` always returns `true` (service.js:442)**
Keeps the response channel open for every message even when `sendResponse` is never called. Minor per-message overhead; return `true` only for async cases (`resolve`, `get_file`, `download`).

**2.11 🟢 `history` command writes browser history per viewed image (service.js:324–333, content.js:2139–2162)**
By design (`cfg.hz.history`), but it is a `chrome.history` write per image view during browsing — a steady background-write source.

---

## 3. Frontend user interactions

### The hover pipeline
`mouseover` (capture, all frames) → `m_over` (content.js:3259) → `find()` (content.js:1368) → `load()` → `set()` → `show()` → per-mousemove `m_move`.

**3.1 🔴 Sieve matching is a linear regex scan on every hover (content.js:1421–1481, 1494–1534)**
For each candidate URL, `find()` runs `rule.link.test()` against **every** rule until a match, then possibly a second pass for image rules. With hundreds of rules this is the single largest CPU cost of a hover. Mitigations already present: negative-result caching via `trg.IMGS_c = true` (content.js:3383) and resolved-result caching via `IMGS_c_resolved`. Recommend: pre-filter rules by host bucket (a `Map<host, rules[]>` built once after `convertSieveRegexes`) so a hover on `x.com` only tests rules whose domains can match. This is the highest-leverage optimization in the file.
*(Profile check, Part 2 §3: on deviantart.com the custom rule matched early, so this scan cost ≈ 3 ms per recording — it stays a theoretical hot path for rule-heavy sites without custom rules.)*

**3.2 🔴 Layout/style reads interleaved with writes on the hover path (thrash)**
Typical sequence: `m_over` → `find()` reads `getBoundingClientRect`/`clientWidth`/`offsetWidth` (content.js:1394–1403, 1180–1199) and `getComputedStyle` in the overflow-parent loop (content.js:1610–1639) → `showHVR` writes 8+ style properties and reads `getComputedStyle(PVI.TRG)` (content.js:3390–3416) → `load()` reads `getBoundingClientRect` again for `TBOX` (content.js:3427) → `markOnHovered` writes `trg.style.cursor`. Each read after a write forces layout. On slow machines this is measurable per hover. Recommend: batch all reads before writes inside `m_over`; cache the computed style read in `showHVR` (one `getComputedStyle` call already returns all radii — it does reuse one call, good).
*(Profile check, Part 2 §3/§5: 80 of 106 reflow markers on the DA tab have cause stacks containing Imagus frames — this pattern is real and does drive style/layout work, though each reflow is small.)*

**3.3 🟡 `elementsFromPoint` (with shadow-root traversal) on hot paths**
`getElementsFromPoint` (content.js:441–452) is called in `find()` on every hover with coordinates (content.js:1390), in `onWheel` on every wheel event (content.js:3067–3069), and in `m_move` during full-zoom on every mousemove (content.js:3477), each potentially walking nested shadow roots (up to 20 levels). Hit-testing is a style/layout operation; in full-zom drag this runs per frame. The recent rAF batching for smooth-scroll zoom (content.js:3148–3161, `wheelRAF`/`applyAccumulatedZoom`) is the right pattern — consider extending the same batching to the elementsFromPoint calls in `m_move`.

**3.4 🟡 Style writes on every mousemove (content.js:3466–3468, 74–90; 3478–3484, 3170–3173)**
`m_move` calls `rotate(0)` on **every** mousemove, which writes `PVI.DIV.style.transform` and `dataset.rotate` even when the rotation is unchanged (content.js:82–83). In full-zoom it also calls `PVI.setCursor("zoom-in")` repeatedly, which does `documentElement.style.setProperty("cursor", ..., "important")` per move (content.js:3171). Writes of identical values still dirty the style system. Guard both with a "value unchanged" check.
*(Profile check, Part 2 §3: individual cost in the recorded window ≈ 0 ms per mousemove — a polish item, not a hotspot.)*

**3.5 🟡 `MutationObserver` targets are observed but never unobserved (content.js:1138–1140, 4007–4028)**
`listen_attr_changes` calls `PVI.mutObserver.observe(node, conf)` for every candidate node as the user browses. `MutationObserver` holds strong references to its targets, so nodes removed from the DOM (SPA navigation, lazy-loaded galleries) stay alive as long as they're observed. Over a long session this is a genuine DOM memory leak — likely the largest one in the content script. Also `iframes` Map (content.js:522–548) is never pruned, retaining removed `<iframe>` content windows. Recommend: on the observer callback, if `trg.isConnected === false`, call `unobserve`; prune `iframes` when `!iframe.isConnected`.

**3.6 🟡 Unbounded caches over page lifetime**
- `PVI.stack` (content.js:557): resolved albums, SVG dimensions, and `stack[src] = true` markers accumulate for every image loaded (content.js:2062, 2135, 2279, 3827). Albums embed full caption strings.
- `PVI.hiResImages` (branch, see 1.1).
- `PVI.resolving` is an array whose indices are only `delete`d, never compacted (content.js:559, 1363, 3768–3770) — length grows monotonically with total resolves (sparse, so cheap, but a counter-leak; use a `Map`).
All are cleared only on `reinit`. Consider trimming `stack` entries whose keys no longer appear in the document.

**3.7 🟡 Legacy `DOMNodeInserted` listener for preload mode 3 (content.js:3595–3610)**
`doc.body.addEventListener("DOMNodeInserted", PVI.preload, true)` fires synchronously for **every** inserted node — the deprecated mutation event that browsers specifically optimized against (it historically forces global invalidation). On dynamic pages this is a major jank source whenever `hz.preload === 3`. The `preload()` body query `doc.body.querySelectorAll('img[src], :not(img)[style*="background-image"], a[href]')` (content.js:3616) over huge pages adds to it. Replace with the existing `MutationObserver` (childList) — the infrastructure is already there.

**3.8 🟢 Polling where events would do**
- Content readiness: `setInterval(PVI.content_onready, 100)` (content.js:2082) although `PVI.IMG` already has a `load` listener (content.js:657).
- SVG dimension sniffing: `setInterval(..., 100)` up to 300 iterations (content.js:2055–2068).
Both are cheap while active and self-clearing, but event-driven paths exist; the polling mainly adds wake-ups during the loader phase.

**3.9 🟢 Gallery browsing**
- Grid build uses `loading="lazy"` + `preload="metadata"` on thumbnails (content.js:2766–2771) — good.
- Re-open skips DOM rebuild when children exist (content.js:2750, 2778) — good.
- Album navigation preloads up to 3 neighbors (`_preload`, content.js:1966–1972) — good.
- Per-click costs are modest; the exception is ctrl+wheel grid resize, which rebuilds sizing state and saves prefs per tick (see 2.3). The dimension math itself (content.js:2783–2791) is trivial.
- One small thing: `gallery(2)` calls `PVI.set(data:image/svg...)` as a sizing hack — it routes through the full `set()`/`checkContentRediness` machinery (with a 100 ms polling interval, content.js:2082) for what is a locally-known-size SVG. A dedicated size-setter would skip the loader/poll path.

**3.10 🟢 Key handling**
`catchEvent.onkeydown` → `key_action` runs on every keydown in every frame (content.js:70–76 app.js, 2470 content.js) with early-outs (`!cfg`, modifier check) — negligible. `shortcut.key()` does a couple of object lookups per event. The expensive branches are the pref-persisting ones (2.3) and `PVI.album()` navigation, which is appropriately throttled by preloading.

**3.11 🟢 Cross-frame coordination**
Each frame waits for the first mousemove before handshaking (`onInitMouseMove`, content.js:4046–4056) — good lazy init. Frame→top hover relay (`from_frame`, content.js:3681–3753) serializes src/album per hover-in-frame; `findIframe` caches by `contentWindow` (good) but falls back to a full-document `querySelectorAll("iframe")` plus `findRoots` — which does `el.querySelectorAll('*')` over the whole document (content.js:544–548) — when the iframe isn't found at top level. That's O(all elements) per miss; consider caching shadow-root hosts.

**3.12 🟢 First-hover latency includes runtime asset injection**
`PVI.create()` awaits `chrome.runtime.sendMessage({cmd:"get_file", ...})` for `styles.css` and injects custom CSS on the very first hover (content.js:37–53, 627–628), and Video.js is injected/evaluated via `Function(code)()` on first video (content.js:55–58, 826). The CSS round-trip through the background could be eliminated by shipping the stylesheet in the user-script bundle; `create()` is also re-entered from `showHVR` on every hover (cheap early-return, content.js:3391).

---

## 4. Good patterns worth keeping

- Negative-result caching on hover (`IMGS_c = true`) and resolved-result caching (`IMGS_c_resolved`) — content.js:3383, 3337.
- rAF batching of smooth-scroll wheel zoom with accumulation (`wheelRAF`, `applyAccumulatedZoom`) — content.js:23–35, 3154–3158.
- Resolve request coalescing with a min-delay timer (`PVI.timers.resolver`, content.js:1359–1364).
- Precompiled sieve in the background (`cacheSieve`), so per-hover matching in frames is regex-only.
- Lazy per-frame init on first mousemove; state machine (`PVI.state`) preventing redundant DOM work.
- Single reusable anchor element for URL normalization (`PVI.HLP`).
- `viewportDimensions()` caching win dimensions (content.js:265–276).

## 5. Prioritized recommendations (static analysis)

| # | Fix | Where | Impact |
|---|-----|-------|--------|
| 1 | Debounce `savePrefs`; write only changed sub-keys; never rebuild the context menu / re-cache sieve unless the sieve actually changed | service.js:180–258 + content.js:2669/2680/2685/3108/3245 | 🔴 removes whole-pref rewrite + menu rebuild per wheel tick |
| 2 | Bucket sieve rules by host for O(few) rule matching per hover | content.js:1421 | 🔴 largest CPU cost per hover |
| 3 | Unobserve disconnected nodes in the MutationObserver callback; prune `iframes` Map | content.js:1138, 522 | 🟡 fixes the main DOM memory leak |
| 4 | Cap/evict `PVI.hiResImages` (and consider `PVI.stack`) | content.js:563 (branch) | 🟡 bounds growth on endless-scroll pages |
| 5 | Implement the missing `resolve_cache` handler or stop sending it | content.js:3802 / service.js:270 | 🟡 enables working response cache; saves repeat fetches |
| 6 | Replace `DOMNodeInserted` with the existing MutationObserver for preload mode 3 | content.js:3595 | 🟡 removes deprecated per-node sync events |
| 7 | Unify `hdEffective`/`hdPreloadEff` behind one key-normalization helper | content.js:2805–2829 (branch) | 🟡 removes divergence risk; simplifies hot path |
| 8 | Guard per-mousemove style writes (`rotate(0)`, `setCursor`) with value checks | content.js:82, 3171 | 🟡 less style invalidation in full-zoom |
| 9 | Make `keepAlive` optional; rebuild `cachedPrefs` on worker wake instead | service.js:610 | 🟡 resident-memory/battery |
| 10 | Don't ship the full sieve to every frame; lazy-load rules on first match | service.js:680 | 🟡 big memory win on iframe-heavy pages |

Minor cleanups: compact `PVI.resolving` (use a `Map`), early-return in `rotate(0)` when `curdeg === 0`, return `true` from `onMessage` only for async replies, batch hover-path reads before writes, and scope `deinitTabs` to affected origins.

---

# Part 2 — Profiler recording analysis (deviantart.com, 2026-11-23)

**Source:** `Firefox 2026-11-23 13.19 profile.json.gz` (Firefox preprocessed profile v78, ~15.3 s of samples at 1 ms interval, fully symbolicated for JS). The recording contains three deliberate, spaced-out gallery hovers on deviantart.com. Analysis below was done programmatically over the profile's sample stacks and marker tables.

## 0. Recording map

| What | Where |
|---|---|
| deviantart.com tab (content process) | pid 17288, `GeckoMain` tid 8248 — **the thread that matters** |
| Extension background process (incl. Imagus background) | pid 3044 — essentially idle during the window |
| Imagus Reborn identity | extension `{07296774-75b1-41dd-9f41-7183178cb436}`, scripts under `moz-extension://ebd496ce-…/` (funcs identified via `resourceTable[15]`) |
| DeviantArt windows in profile | `/some2else/gallery/all`, `/iceiller9999/favourites/all`, two `/art/…` pages, `morelikethis/…` |
| Other tabs (idle) | reddit, patreon, youtube, github, janitorai — negligible CPU |

Timeline (relative ms into the recording, content process):

- **Hover 1:** `mouseover` on gallery `img` at **1946** → sync-XHR spin **2680–2942 (262 ms)** → popup
- **Hover 2:** `mouseover` at **6634** → spin **6934–7630 (696 ms)** → popup stays open ~4 s (cursor over the `div.imagus` popup, mousemove stream)
- **Hover 3:** `mouseover` at **11054** → spin **11353–11986 (633 ms)** → popup
- Trailing activity at 14201–14353: mouse leaves the popup, `reset()` — ~4 ms total

## 1. 🔴 Headline finding: three synchronous XHRs in the custom DeviantArt sieve rule block the main thread for 1.59 s

Stack (sampled, exact):

```
… <- SpinEventLoopUntil XMLHttpRequestMainThread::SendInternal
  <- XMLHttpRequest.send
  <- anonymous                       (content/content.js line 3775 > Function — compiled sieve rule)
  <- onMessage                       (content/content.js:3765 — PVI.onMessage)
  <- listen/this.listener            (common/app.js:87 — Port.listen → chrome.runtime.onMessage)
  <- … promise callback (extension messaging reply dispatch)
```

Measured spin runs: **262 ms, 696 ms, 633 ms — one per hover, 1.59 s total ≈ 10.4 % of the entire recording.** This is not CPU work: the thread sits in `TaskController::GetRunnableForMTTask::Wait`, the nested event loop that `XMLHttpRequest.send` runs while waiting for the network. Firefox's sync-XHR spin keeps a nested loop alive, so rendering and refresh-driver ticks continue (109 `WebRender blob images` during hover 2's window), but **all queued JS for the tab stalls**: Imagus's own timers, the site's handlers, anything else in that process waits behind the network.

Code association: the custom DeviantArt rule's `res` script (compiled at content.js:3775, i.e. the `rule.res = Function("$", …)` path in the `resolved` message branch) contains a custom rule with helpers visible in the profile: `routeSingleImage`, `routeText`, `routeCarousel`, `addEntry`, `memberKey`, `mediaUrl`, `webOptimizedUrl`, `makeTextMeasurer`, `renderTextToPng`. The rule builds gallery responses (and renders text posts to PNG on-canvas) and performs its own `XMLHttpRequest` **synchronously** during `rule.res.call(PVI, d.params)` (content.js:3782). Sieve `res` scripts have no way to `await` — the extension calls them synchronously — so a rule that needs extra network data is forced into sync XHR.

**Impact on the user:** per hover, the main thread is blocked 0.26–0.7 s. Together with the pre-roll (see §2), popup appearance lands roughly 1 s after mouseover on every hover. During the block, the tab feels frozen to JS (animations continue only because the nested loop feeds the compositor).

**Fixes, in order of preference:**

1. **Extension: allow `res` scripts to return a Promise.** In the `resolved` branch (content.js:3782), if `rule.res.call(...)` returns a thenable, stash state (trg, params) and continue (`PVI.set`/`show`) when it resolves; show the loader meanwhile. This unblocks every rule author and immediately lets the DA rule switch `XMLHttpRequest` → `fetch`. Sync XHR from content scripts is also deprecated-by-design in the platform; this fix future-proofs rules.
2. **Rule-side workaround without extension changes:** move the extra fetches out of the `res` script — the rule already receives the page body via `params._` when using the `:\n` + `res: 1` form (background fetch, content.js:3774–3782; background `resolve` case service.js:369–404). Any *additional* requests the rule makes (per-item API/token calls) should either be derived from that body or hoisted into a background `req_res`-style fetch. Cache per-URL results in `PVI.stack`/rule-local storage so repeat hovers skip the network (hover 3 cost the same 633 ms as hover 2 — nothing was cached).
3. If a sync fetch truly must remain, at minimum route it through the **background** (`Port.send` → `fetch` → reply): same wall-clock latency, but the content main thread never blocks.

## 2. 🟡 Hover-to-popup pipeline latency: 300–730 ms before the rule even starts

From each `mouseover` to the start of its XHR spin: **+734 ms** (hover 1), **+300 ms** (hovers 2 and 3). That pre-roll is: `cfg.hz.delay` + resolve coalescing timer (content.js:1359–1364) + one message round-trip to the background + the background's own `fetch()` of the page (service.js:375–390) + reply dispatch. The background `fetch` is async and correct (the background process, pid 3044, shows **zero** Imagus samples — it costs no CPU), but it adds a full network round-trip into the latency chain.

Fixes: cache fetched page bodies per URL (background-side, keyed by URL + TTL — this dovetails with finding 2.6, the dead `resolve_cache` handler); keep the rule's own per-request results cached as well. Hover 1's longer pre-roll (734 ms) vs hovers 2–3 (300 ms) suggests first-use costs (rule compile, CSS injection, cold HTTP cache) that warm up afterwards — consistent with static finding 3.12.

## 3. 🟢 The hover pipeline itself is cheap — Part 1's CPU concerns were second-order

Measured on this site, for all three hovers combined (~15.3 s recording):

- Imagus content-script JS excluding the XHR spins: **~70–90 ms total** (~0.5 % of the recording). Largest items: `showHVR` 23 ms, `m_move_show` 23 ms, `renderTextToPng` (rule canvas text rendering) 19 ms, `m_move` 10 ms, `find` 3 ms, `set`/`album`/`reset` a few ms each.
- The site's own JS is *also* cheap: **every DOMEvent handler ≤ 2 ms** (777 paired DOMEvent intervals; 141 mousemoves = 17 ms total). The three triggering `mouseover` handlers were 1–2 ms each.
- Main thread occupancy: 14.88 s idle + **1.59 s sync-XHR spins** + ~0.45 s real work. In other words: **~78 % of all non-idle main-thread time in this recording is the sync-XHR blocking**, not rendering, not rule regex matching, not GC.

Consequences for Part 1's priorities: the linear sieve scan (3.1) did not show up at all on this site (the DA rule matched long before the scan could get expensive — and with a custom rule, `find()` found a hit quickly). It remains a theoretical hot path for pages where many rules must be tested per hover, but measured evidence says: fix the rule-level blocking first. Likewise `getElementsFromPoint` per mousemove, `rotate(0)`/`setCursor` style writes: individually ~0 ms in this trace (mousemove handler total was 17 ms for 141 events).

One Part 1 finding **is** corroborated: **80 of 106 reflow markers** on this thread have cause stacks containing Imagus frames (style writes from `HD_cursor`, `showHVR`, hover outline marking, popup sizing). Each reflow is small, but it confirms that the hover path's write-then-read pattern (static finding 3.2) and unguarded per-move style writes (3.4) do drive style/layout work. Keep recommendations 8 and the read/write batching; the value-unchanged guards (`rotate(0)`, `setCursor`) remain worthwhile.

## 4. 🟢 Memory / GC during the window

- GC: **214 ms** total across 21 slices (`GCSlice`/`GCMajor`/`GCMinor`); CC: **4 ms** across 2 slices (`CCSlice`) — normal background churn, nothing Imagus-specific and nothing pathological.
- The unbounded caches flagged in Part 1 (`PVI.stack`, `hiResImages`, observed mutation targets, `iframes` Map) can't be measured in a 15 s recording; they remain the memory risks to watch on long sessions (endless-scroll galleries).
- Background process: idle (0 Imagus samples, no `savePrefs` traffic in this window — the hotkey pref-save hot path from 2.1–2.3 wasn't exercised; it stays a static finding).

## 5. Other observations from the recording

- DeviantArt synthesizes mouse events from pointer events (`DispatchSynthMouseOrPointerMove` × 194) and streams `mousemove` over the Imagus popup while it's open; Imagus's capture-phase `m_move` handles these at ~0 ms each. No action needed.
- `MozAfterPaint` × 155 / continuous `WebRender blob images` — the page animates constantly (DeviantArt's UI); Imagus popup sizing participates in a subset of the reflows (see §3).
- SponsorBlock, Dark Reader, uBlock, LastPass, Tampermonkey, BetterViewer, RES are present in the session; none showed material main-thread time in the DA content process during the hovers (RES's `setInterval` 30 s watcher exists but is idle).

## 6. Combined priority list (static + measured)

| # | Fix | Evidence | Impact |
|---|-----|----------|--------|
| 1 | Let sieve `res` scripts return Promises (async `res` support) and migrate the DA rule off sync `XMLHttpRequest` | 🔴 **measured**: 3 spins, 1.59 s blocked (10.4 % of recording), one per hover | removes the single largest user-visible cost |
| 2 | Cache resolved pages/results: implement `resolve_cache` in background (2.6) + rule-level result caching | 🔴 measured: hover 3 repeats hover 2's 633 ms cost with no cache hit; pre-roll 300–730 ms per hover | big latency win on repeat hovers |
| 3 | Debounce `savePrefs` and stop full-object pref rewrites (2.1–2.3) | static (not exercised in recording) | 🔴 on zoom/resize hot paths |
| 4 | Value-unchanged guards for `rotate(0)`/`setCursor` + batch hover reads before writes (3.2, 3.4) | 🟡 **measured**: 80/106 reflows caused by Imagus frames | reduces per-hover layout work |
| 5 | MutationObserver unobserve + `iframes` Map pruning (3.5) | static (long-session leak) | 🟡 memory |
| 6 | Cap/evict `hiResImages` & `PVI.stack` (1.1) | static (branch) | 🟡 memory on endless-scroll pages |
| 7 | Sieve rule bucketing by host (3.1) | static (not hot on DA due to custom rule) | 🟡 CPU on rule-heavy sites |
| 8 | `DOMNodeInserted` → MutationObserver in preload mode 3 (3.7) | static | 🟡 jank on dynamic pages |
| 9 | Background `keepAlive` optional (2.5); per-frame sieve shipping (2.4) | static; background idle in recording | 🟢 memory/battery |

**Bottom line:** for the site that matters, Imagus's own hover machinery is already fast (~90 ms of JS across three hovers). The cost is concentrated in one thing: the custom DeviantArt sieve rule performing synchronous network fetches on the content-process main thread, once per hover, plus the un-cached resolve pipeline that precedes it. Fixing async `res` support + result caching would cut the measured hover cost from ~1 s to roughly the image-load time alone.

---

# Part 3 — Appendix: methodology, raw data & session continuity

This appendix exists so a **fresh session can pick up exactly where this analysis left off** — it preserves the methodology, the raw measurements, the recording-format pitfalls that took time to work out, and the open follow-ups.

## A1. Artifacts

| Artifact | Location |
|---|---|
| Profiler recording | `Performance Analysis/Firefox 2026-11-23 13.19 profile.json.gz` (gzip'd Firefox preprocessed profile, format version 78, ~32 MB decompressed) |
| Re-runnable analysis script | `Performance Analysis/profiler-analysis/analyze_profile.cjs` — `node analyze_profile.cjs [path\to\profile.json.gz]` (Node ≥18, no deps). Reproduces every number in Part 2. `.cjs` because the repo's `package.json` sets `"type": "module"`. |
| Main write-up | `Performance Analysis/Performance Analysis.md` (Part 1 static, Part 2 profile evidence, this appendix) |

If a new recording is added, re-run the script against it; the identities in `A2` (pids, resource index) will differ per recording and must be re-derived (script prints the candidate deviantart processes and resolves the extension resource index — search `resourceTable.name` for `"Imagus Reborn"`).

## A2. Identities specific to this recording

- **Imagus Reborn - Custom** = extension `{07296774-75b1-41dd-9f41-7183178cb436}`, base `moz-extension://ebd496ce-5676-4a72-b2ff-569ed7ea489a/`, shared `resourceTable` index **15** (this is how Imagus functions were identified in sample stacks: `funcTable.resource[fi] === 15`).
- deviantart.com content process: **pid 17288**, main thread tid 8248. Other DA-hosting processes (21200/3108/2468/9524) held idle/aux windows. Extension background process: **pid 3044** (Imagus background: 0 samples — idle).
- The custom DeviantArt sieve rule compiles at **content.js:3775** (the `rule.res = Function("$", …)` path for `res: 1` rules). Its functions visible in stacks: `routeSingleImage`, `routeText`, `routeCarousel`, `addEntry`, `memberKey`, `mediaUrl`, `webOptimizedUrl`, `makeTextMeasurer`, `renderTextToPng`.
- Recording time base: `meta.profilingStartTime = 403361456.2326` (ms). Sample `timeDeltas[0]` is the absolute start; subsequent deltas are intervals. All "rel" times below are ms after that base.

## A3. Raw measurements (authoritative numbers)

**Sync-XHR spin runs** (content process, all inside `SpinEventLoopUntil XMLHttpRequestMainThread::SendInternal ← XMLHttpRequest.send ← anonymous (rule Function) ← onMessage (content.js:3765) ← listen/this.listener (app.js:87)`):

| run | rel start–end | duration | preceding `mouseover` |
|---|---|---|---|
| 0 | 2680–2942 | 262 ms | rel 1946 (`img@214035de780`, handler 2 ms) |
| 1 | 6934–7630 | 696 ms | rel 6634 (`img@214035de940`, handler 2 ms) |
| 2 | 11353–11986 | 633 ms | rel 11054 (`img@214035deb00`, handler 1 ms) |
| **total** | | **1591 ms = 10.4 % of recording** | 3 hovers, one spin each |

**Imagus activity bursts** (gap > 2 s): 1943–3052 (1110 ms), 6335–11992 (5658 ms, popup open — cursor over `div.imagus`), 14201–14353 (152 ms, leave/reset).

**Imagus JS cost:** 1661 ms of samples are Imagus-attributed; ~1591 ms of that is the XHR spin wait → **~70–90 ms of real Imagus JS across the whole recording**. Top inclusive (non-spin): `onMessage` 1612 ms (spin-dominated), then `show` 27, `showHVR` 24, `m_move_show` 23, `routeText` 20, `renderTextToPng` 19, `m_move` 10, `album` 6, `find` 4, `set` 4.

**Site JS:** 777 paired DOMEvent intervals; every handler ≤ 2 ms; 141 mousemoves total 17 ms. The DA tab's main thread: 14.88 s idle-leaf + 1.59 s spin (shares the idle leaf address `0x7ff95f7fa054` = `TaskController::GetRunnableForMTTask::Wait`) + ~0.45 s real work.

**Markers:** GC 214 ms / 21 slices; CC 4 ms / 2 slices. Reflow markers with Imagus frames in their cause stacks: **80 / 106**. `Image Paint` ×3547, `Awake` ×6956, `DispatchSynthMouseOrPointerMove` ×194 (DA synthesizes mouse events from pointer events), `mousemove` over `div.imagus` (Imagus popup) ~×50+ at ~0 ms each.

## A4. Firefox profile format pitfalls (learned the hard way)

A fresh session parsing a *new* recording should know:

1. **`pids` are strings** — `t.pid === '17288'`, not `17288` (strict-equality bug waits for you).
2. **Shared tables** moved to `p.shared` (`stringArray`, `stackTable`, `frameTable`, `funcTable`, `resourceTable`, `sources`, `sourceLocationTable`, `nativeSymbols`).
3. **Stack ancestry** is `stackTable = { frame[], prefixOffset[] }`: parent index = `i - prefixOffset[i]` (0 ⇒ root). There is no `prefix` column.
4. **funcTable names do NOT contain URLs.** Identify extension code via `funcTable.resource[fi]` → `resourceTable.name` (host = extension ID). URL-annotated strings in `stringArray` (e.g. `m_over (moz-extension://…content.js:3259:26)`) belong to *marker payloads*, not function frames.
5. **Markers are columnar**: `markers.name/startTime/endTime/phase/data` arrays (data column may contain `null` holes; name values are indices into `stringArray`).
6. **Marker column semantics are inconsistent by phase** (verified empirically):
   - phase 0 (instant): `start` = time (absolute base).
   - phase 1 (interval start): `start` = absolute start; **but GC/CC markers (`GCSlice`, `GCMajor`, `GCMinor`, `CCSlice`) are phase 1 with BOTH columns real** — `end − start` is their duration.
   - phase 2 (interval end): `start` column = the **end** time (absolute); `end` column = garbage.
   - phase 3 (complete): `end` column = absolute end; `start` column = garbage.
   - The garbage/sentinel value `36467.068115234375` shows up in whichever column is unused. **Pair phase-2/phase-3 markers** (match on `data.eventType`/`target`/`latency` for DOMEvent) to recover durations.
7. DOMEvent payload fields: `eventType` (may be `''`), `target` (e.g. `img@214035de780`, `div@… class="imagus"` — the Imagus popup), `latency`, `innerWindowID`.
8. Reflow causes: phase-2 markers carry `data.cause.stack` (a stackTable index) — that's how "80/106 reflows caused by Imagus frames" was computed.

## A5. Conclusions in one paragraph (the state of the analysis)

The code-level analysis (Part 1) stands. The profiler evidence (Part 2) proved that on deviantart.com — the site the user cares about — Imagus's hover machinery is fast (~90 ms JS over three hovers) and the **entire user-visible cost is the custom DeviantArt sieve rule doing synchronous `XMLHttpRequest` from the content-process main thread, once per hover (262/696/633 ms), on top of a 300–730 ms un-cached resolve pre-roll**. The static findings that were *measured* (reflow causes) or *deprioritized* (sieve scan, per-move style writes) are cross-referenced inline in Part 1.

## A6. Open follow-ups (pick up here)

1. **Async `res` support** (top fix): in content.js `PVI.onMessage` `resolved` branch (~:3782), detect a thenable return from `rule.res.call(PVI, d.params)`, keep loader state (`PVI.show("res")`), and resume the `d.m` handling when it resolves. Then migrate the custom DA rule off `XMLHttpRequest` → `fetch`.
2. **Result caching**: implement the missing `resolve_cache` case in service.js `onMessage` (content sends it at content.js:3802 — handler never existed), plus rule-level per-URL caching so hover 3 doesn't repeat hover 2's fetch.
3. Then work down the combined priority table (Part 2 §6): savePrefs debounce (2.1–2.3), style-write guards (3.2/3.4), MutationObserver unobserve (3.5), `hiResImages` cap (1.1), sieve host-bucketing (3.1), `DOMNodeInserted` → MutationObserver (3.7).
4. If a new recording is made to validate the fixes, re-run `analyze_profile.cjs` on it and compare: spin runs should disappear (fix 1) and repeat-hover spins should be absent (fix 2).
