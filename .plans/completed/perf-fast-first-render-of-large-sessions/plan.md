# Fast first render of large session histories

## Context

Opening a large session (hundreds of conversation entries) is laggy on first render. `selectLiveSession` fetches the full snapshot, then `renderSessionHistory` (`src/public/app-main.ts:1732`) synchronously renders every entry — regex-heavy markdown parsing, synchronous KaTeX, per-message `appendChild` on the live scroll container — before the page can paint.

Two verified aggravators:

1. **Forced reflow per tool card**: `app-main.ts:1804` logs `card?.offsetHeight` (forces a full synchronous layout for every tool card) and serializes `card?.innerHTML`. On a session with hundreds of tool calls this alone is likely a huge share of the lag.
2. **Latent bug**: `applyLiveSessionSnapshot` (`app-main.ts:1653`) calls `messageRenderer.clear()` but never `toolCardRenderer.clear()`, so the `toolCards` map holds stale entries pointing at detached nodes across session switches.

Goal: newest messages paint instantly (pinned to bottom), older history fills in without jank, streaming/live behavior unchanged.

**Dependencies**: user is open to deps, but none clearly help — the fixes are small vanilla changes that fit the no-framework architecture; a virtualization library would fight the streaming append + toolCard-map design. (Optional future dep: a real diff lib for `renderDiff`, orthogonal to this work.)

## Approach

Progressive bottom-up render: pure pre-pass pairs tool results to tool calls before any DOM work; render the newest ~30 items synchronously via one DocumentFragment; prepend older items in idle-scheduled chunks with manual scroll compensation; `content-visibility: auto` to skip off-screen layout/paint; generation-token cancellation on session switch.

### Step 0 — Remove forced-reflow debug logging (`src/public/app-main.ts`)

Delete the `console.log(... card?.offsetHeight, card?.innerHTML?.substring(...))` at line 1804 and the `document.querySelectorAll('.tool-card'/'.thinking-block')` debug counts at 1817–1818. Measure before/after in DevTools Performance — this calibrates how much the rest matters.

### Step 1 — New pure module `src/public/history-render.ts`

Extract the entry-parsing half of `renderSessionHistory` (app-main.ts:1736–1814) into DOM-free, testable functions:

```ts
export type HistoryItem =
  | { kind: 'user'; content: string; images?: {...}[] }
  | { kind: 'assistant'; content: MessageContentBlock[] | string; usage?: ... }
  | { kind: 'toolCall'; toolCallId: string; toolName: string; args: ...;
      result?: ...; isError?: boolean };

export function buildHistoryItems(entries): {
  items: HistoryItem[]; totalCost: number;
  lastInputTokens: number; lastUsage: UsageRecord | null;
}
```

- Walk entries once, same filtering rules as today (`content || images.length` guard for user; `text || thinkingBlocks.length` guard for assistant; one `toolCall` item per toolCall block).
- Keep `Map<toolCallId, toolCall item>`; a `toolResult` entry attaches `{result, isError}` onto its matching item and emits **no** item of its own. This makes every chunk self-contained — rendering newest-first can never orphan a result whose card lives in an older, not-yet-rendered chunk. Unmatched results are dropped (same as today's silent no-op).
- Accumulate `totalCost` / `lastInputTokens` / `lastUsage` exactly as app-main.ts:1787–1793 does, so the context pill is correct immediately despite out-of-order DOM rendering.

### Step 2 — Renderers accept a target (`message-renderer.ts`, `tool-card.ts`)

- `MessageRenderer.renderUserMessage(msg, isHistory = false, target: ParentNode = this.container)` and `renderAssistantMessage(msg, isStreaming = false, isHistory = false, target = this.container)` — replace the final `this.container.appendChild(div)` with `target.appendChild(div)` (message-renderer.ts:85, 130). Keep `.welcome` removal querying `this.container`.
- `ToolCardRenderer.createHistoryCard(exec, target: ParentNode = this.container)` — same swap (~tool-card.ts:240). History cards receive a distinct `.history` class, still register into `this.toolCards`, and inherit the current Expand All / Collapse All state so cards created by later chunks remain consistent. `addHistoryResult` works unchanged on detached cards.

Default targets preserve existing caller behavior; the `.history` marker and deferred Expand All state apply only to historical cards.

### Step 3 — Rewrite `renderSessionHistory` (`app-main.ts:1732`)

```ts
const INITIAL_SYNC_ITEMS = 30;
const CHUNK_ITEMS = 50;
let historyRenderToken = 0;                    // module-level
function cancelHistoryRender() { historyRenderToken++; }
```

Flow:
1. `buildHistoryItems(entries)` → set `sessionTotalCost`/`lastInputTokens`/`lastUsage`, call `updateContextPill()` + `fetchContextWindow()`.
2. **Synchronous tail**: render the last `INITIAL_SYNC_ITEMS` items in order into a `DocumentFragment`; capture `topAnchor = frag.firstChild` *before* insertion; one `messagesContainer.appendChild(frag)`; keep the existing instant scroll-to-bottom block (1824–1831) unchanged.
3. **Progressive prepend**: `requestIdleCallback(fn, {timeout: 500})` (fallback `setTimeout(fn, 16)`). Each chunk:
   - Guard: `token !== historyRenderToken` or `!topAnchor?.isConnected` → abort (session switched / container cleared).
   - Build previous `CHUNK_ITEMS` items into a fragment; record `prevHeight = scrollHeight`, `prevTop = scrollTop`; `insertBefore(chunk, topAnchor)`; `scrollTop = prevTop + (scrollHeight − prevHeight)`; advance `topAnchor` to the chunk's first child; schedule next chunk while items remain.
   - Insert + measure + adjust happen in one task, so nothing paints between them — no visible jump whether the user is at the bottom or reading mid-history. Also preserves `isNearBottom` invariance.

**Implementation deviations (found by the e2e tests):**
- Scroll preservation is done by **native scroll anchoring** where supported (`CSS.supports('overflow-anchor', 'auto')` — Chrome/Firefox): just `insertBefore`, no scrollTop math. Native anchoring also tracks the *deferred* size refinements `content-visibility: auto` applies after insertion, which a one-shot manual compensation cannot (observed ~400px drift). The manual scrollTop compensation is kept only as the Safari fallback.
- `content-visibility` is enabled only when that same support check succeeds. Safari's manual branch lays out each chunk at its real height so the one-shot `scrollHeight` compensation cannot be invalidated by later intrinsic-size refinements.
- In the fallback path, the compensation assignment must temporarily force `style.scrollBehavior = 'auto'`: the container's CSS `scroll-behavior: smooth` turns a plain `scrollTop =` assignment into an animated scroll that lags behind the chunk inserts and strands the viewport (observed 60k+ px drift).
- Consequently `overflow-anchor: none` is **not** added to `.messages` (Step 5) — native anchoring is the mechanism, not a hazard.
4. `renderHistoryItem(item, frag)` dispatches: user → `renderUserMessage(..., true, frag)`; assistant → `renderAssistantMessage(..., false, true, frag)`; toolCall → `createHistoryCard(..., frag)` then, if the item carries a result, `addHistoryResult(toolCallId, result, isError)`.
- Live WS messages keep appending to `this.container` (below the tail); prepends only touch the top — streaming and auto-scroll unaffected.
- Sessions with ≤ 30 items behave identically to today.

### Step 4 — Cancellation + fix stale toolCards map

Add a small `clearConversation()` helper: `cancelHistoryRender(); messageRenderer.clear(); toolCardRenderer.clear();` and use it at every conversation-teardown site (`app-main.ts` ~439, 578, 1562, 1586, 1602, 1653). This also fixes the missing `toolCardRenderer.clear()` at 1653.

### Step 5 — CSS (`public/style.css`)

```css
.messages.native-scroll-anchoring > .message.history,
.messages.native-scroll-anchoring > .tool-card.history {
  content-visibility: auto;
  contain-intrinsic-size: auto 60px;
}
```

- `app-main.ts` adds `.native-scroll-anchoring` only when `CSS.supports('overflow-anchor', 'auto')` succeeds, so deferred sizing is never combined with the one-shot manual fallback.
- Only historical messages and historical tool cards are eligible. Live messages and live tool cards remain fully laid out, preserving streaming and scroll-to-bottom behavior.
- Native scroll anchoring remains enabled; no `overflow-anchor: none` rule is added.

### Step 6 — Optional, only if profiling still shows cost

Cap `renderDiff` (tool-card.ts:297) at ~200 removed + 200 added lines with an "… N more lines" row. Skip unless measurement says it matters (collapsed card bodies are `display:none`).

### Step 7 — Automated browser (Playwright) test replacing manual verification

Feasibility verified in the codebase:
- `test/http-routes.test.ts` already `require`s `../bin/tau.js` in-process, listens on port 0, points `PI_CODING_AGENT_SESSION_DIR` at a temp dir, and mocks the Pi process via `_setSpawnPiForTest()` + a `makeFakeChild()` (EventEmitter + PassThrough streams).
- `test/http-routes.test.ts:534` proves `POST /api/live-sessions/resume` + `GET /api/live-sessions/{id}/snapshot` serve the historical JSONL entries with a **mocked** pi — no real agent needed for the browser to render a session.
- Nixpkgs has `playwright-driver` **1.61.1** with a prebuilt `playwright-driver.browsers` bundle (verified via `nix eval`).

Changes:
- **devDependency**: `playwright` pinned to `1.61.1` (must match the nixpkgs `playwright-driver` version so the Nix-provided browser bundle is compatible).
- **New `test/e2e/history-render.e2e.ts`** (node --test, like the rest; kept out of the default `node --test` glob — see script below):
  - Setup (mirrors http-routes.test.ts): temp `PI_CODING_AGENT_SESSION_DIR`, write fixture JSONLs, `require('../bin/tau.js')`, `server.listen(0, '127.0.0.1')`, `_setSpawnPiForTest(makeFakeChild)`. Teardown closes browser contexts, calls `liveManager.shutdown()` to reject pending fake-child RPCs, then closes the server.
  - Fixture A (large, ~3000 entries): numbered user/assistant messages (markdown + a little `$math$`), assistant messages containing `toolCall` blocks followed by `toolResult` entries — including pairs that will straddle chunk boundaries. Numbered content (`msg-0001` … `msg-NNNN`) makes order assertions trivial. Fixture B: small (~5 entries) for the switch test.
  - Launch chromium via the `playwright` library API (`chromium.launch()`); use a CDP session with `Emulation.setCPUThrottlingRate` (~4×) so the progressive fill reliably spans multiple frames instead of finishing instantly on a fast machine.
  - If browser launch fails (no browsers installed), `t.skip()` with a hint to use `scripts/e2e.sh` — plain `npm test` stays green everywhere.
  - Collect `page.on('console')` errors + `pageerror` and assert none at the end of each test.
  - Assertions (each replaces a manual check):
    1. **Tail-first paint**: click session A in the sidebar; wait for the *last* fixture message's text to be visible; assert the DOM message count at that moment is **less than** the total (proves the tail rendered before the full history), and that the container is scrolled to the bottom (`scrollTop + clientHeight ≈ scrollHeight`).
    2. **Progressive completion + ordering**: poll until DOM count equals the expected total; assert the first DOM message is `msg-0001` and the last is the final fixture message (prepend order correct).
    3. **Native scroll anchoring**: while chunks are still filling, scroll a mid-history element into view, record its `getBoundingClientRect().top`, wait for fill completion, assert it moved ≤ 3px.
    4. **Manual scroll anchoring**: force the support check false and disable Chromium's native anchoring, then repeat the same viewport-position assertion to exercise the Safari path.
    5. **Expand All across chunks**: invoke the command while most history is pending, wait for completion, and assert every deferred tool card inherited the expanded state.
    6. **Cancellation on switch**: click session A, then immediately session B; after B settles, assert no A-marker text exists in the DOM and B's messages are all present.
    7. **Live tool cards**: create a large live tool card while scrolled up, assert it remains fully laid out rather than receiving history-only `content-visibility`, and verify scroll-to-bottom reaches it.
    8. **Tool card pairing across chunks**: inspect a card from an early (prepended) chunk and one from the synchronous tail; assert each contains its paired result text.
    9. **Context pill**: assert the pill shows the value computed from fixture usage numbers (pins the stats pre-pass).
- **New `scripts/e2e.sh`** (Nix-aware wrapper):
  ```sh
  #!/usr/bin/env bash
  set -euo pipefail
  if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && command -v nix >/dev/null; then
    export PLAYWRIGHT_BROWSERS_PATH="$(nix build --print-out-paths nixpkgs#playwright-driver.browsers)"
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
  fi
  npm run build
  node --test test/e2e/
  ```
  On non-Nix machines `npx playwright install chromium` works instead; the script only injects the Nix bundle when nix is present and the path isn't already set.
- **package.json**: add `"test:e2e": "bash scripts/e2e.sh"`. Keep `npm test` as-is (`node --test` doesn't recurse into `test/e2e/` since the default glob is top-level `test/*.test.*`; verify and adjust the glob/naming if needed).

## Files

- `src/public/app-main.ts` — renderSessionHistory rewrite, cancellation token, clearConversation helper (lines 561–596, 1622–1832)
- `src/public/history-render.ts` — **new** pure pre-pass module
- `src/public/message-renderer.ts` — target param on the two render methods
- `src/public/tool-card.ts` — target param, history marker, and deferred Expand All state on `createHistoryCard`
- `public/style.css` — history-only content-visibility gated on native scroll anchoring
- `test/history-render.test.ts` — **new** pure unit suite
- `test/e2e/history-render.e2e.ts` — **new** Playwright browser suite
- `scripts/e2e.sh` — **new** Nix-aware e2e runner
- `package.json` — `playwright@1.61.1` devDependency + `test:e2e` script

## Verification

1. **Unit** (`test/history-render.test.ts`, follows `test/markdown.test.ts` pattern — `require('../public/history-render.js')` after build, no DOM):
   - toolResult pairing: attached to the right item; multiple toolCalls in one assistant message each get own item/result; `isError` set; unmatched result → no item, no throw.
   - Stats regression pins: `totalCost` sums `usage.cost.total`; `lastInputTokens`/`lastUsage` come from the *last* assistant message with usage.
   - Content shaping: string vs block user content, image extraction, thinking-only assistant produces an item, tool-call-only assistant produces no assistant item but does produce toolCall items.
   - Run: `npm test`; `npm run typecheck`.
2. **Browser e2e**: `npm run test:e2e` (Step 7) — covers tail-first paint, progressive completion/ordering, native and manual scroll anchoring, Expand All across deferred chunks, mid-fill session switch, live/history tool-card isolation, tool-result pairing, context pill, and zero console errors.
3. **One-off profiling** (not a gate): DevTools Performance baseline vs. after Step 0 alone vs. after full change, to confirm the forced-reflow removal's share of the win.
