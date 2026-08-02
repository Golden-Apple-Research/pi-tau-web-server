---
status: COMPLETED
---

# Review — fast first render of large session histories

Branch: `feat/faster-first-render-on-large-session` (`31f6c6a`)

Base: `main` at `9131d4a` (`master` does not exist in this repository)

Scope: the feature plan, progressive history-rendering implementation, unit tests,
Playwright tests, and E2E runner introduced by the branch.

## Findings

Priority scale: **P1** blocks merge because a core guarantee or existing workflow is broken; **P2** is a scoped functional or test-infrastructure defect that should be fixed; **P3** is a lower-risk correctness or documentation issue.

### 1. [P1] Preserve the Safari viewport after deferred sizes resolve

The fallback in `renderOlderChunk()` compensates only once using the provisional
`scrollHeight`. Safari lacks native scroll anchoring but supports the
`content-visibility: auto` rule, so inserted elements initially use the 60px
intrinsic estimate and later change height without further compensation. With
the E2E fixture and native anchoring disabled, the marker moved from 86px to
-296.5px; disabling `content-visibility` made it stable. Gate deferred sizing on
native anchoring support or compensate using a persistent visual anchor.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/src/public/app-main.ts:1828-1839`

### 2. [P2] Restrict content visibility to history tool cards

`.messages > .tool-card` also matches live cards created by `createToolCard()`.
If a user scrolls up while a live tool produces substantial output, the skipped
card retains its estimated height, so the scroll-to-bottom button targets an
underestimated `scrollHeight`. When the card becomes visible and expands,
scrolling stops far above the actual bottom. Give historical cards a
distinguishing class and narrow this selector.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/style.css:1484-1489`

### 3. [P2] Carry Expand All state into deferred chunks

“Expand All Tools” only expands cards currently registered in `toolCards`.
Older chunks continue creating pre-collapsed cards after the command runs,
leaving most cards collapsed if the action is invoked before a large history
finishes. Track the requested expansion state and apply it to subsequently
created history cards.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/src/public/app-main.ts:1842-1844`

### 4. [P2] Terminate fake sessions before closing the E2E server

The fake Pi child never answers RPC requests triggered by
`sessionStatsCard.refresh()`, but teardown closes the server without shutting
down `liveManager`. Outstanding 60-second requests therefore keep the suite
alive: the current E2E run took about 70.5 seconds, versus 19 seconds when
`liveManager.shutdown()` was added before `server.close()`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/test/e2e/history-render.e2e.ts:167-172`

### 5. [P3] Remove the obsolete overflow-anchor step

The plan correctly states at lines 69–72 that native anchoring is required and
`overflow-anchor: none` must not be added, but Step 5 still instructs adding it.
Following Step 5 would disable the only compensation used by Chrome and Firefox
while the code still chooses the native-anchoring branch. Remove the stale rule
and rationale from Step 5.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/.plans/active/perf-fast-first-render-of-large-sessions/plan.md:81-93`

## Verification

- `npm test`: 200 tests passed.
- `npm run typecheck`: passed after installing the branch dependencies with
  `npm ci`.
- `npm run test:e2e`: 5 Chromium tests passed, but teardown extended total
  runtime to roughly 70.5 seconds.
- Forced the no-native-anchoring path with browser anchoring disabled: the
  scroll-preservation test failed with a 382.5px displacement.
- Repeated that fallback test with `content-visibility` disabled: it passed.
- Repeated the full E2E suite with `liveManager.shutdown()` in teardown: all
  five tests passed in roughly 19 seconds.

## Overall assessment

**Verdict:** Needs revision.

The pure pre-pass, tail-first rendering, tool-result pairing, and cancellation
token form a coherent approach, and the existing unit and Chromium tests pass.
The change is not correct as-is because the core no-jump guarantee fails in the
non-native-anchoring path and the CSS introduces a live tool-scrolling
regression; the deferred-card command behavior, E2E cleanup, and contradictory
plan text should also be corrected.

---

## Fix summaries (resolved after review)

All five findings were addressed. The original review above is preserved as the
historical assessment of `31f6c6a`; this appendix records the post-review fixes
and verification.

### Fix 1 — [P1] Preserve the Safari viewport after deferred sizes resolve

`app-main.ts` now adds `.native-scroll-anchoring` to the messages container only
when `CSS.supports('overflow-anchor', 'auto')` succeeds. The
`content-visibility` rules require that class, so Safari's manual compensation
path lays out each inserted chunk at its real height instead of measuring a
60px intrinsic estimate that changes later.

A new browser test forces the support check to return false and disables
Chromium's own anchoring so it exercises the manual/Safari path. Before the fix,
the anchored message moved from 86px to -296.5px; after the fix, the same test
keeps it within the 3px tolerance.

### Fix 2 — [P2] Restrict content visibility to history tool cards

`createHistoryCard()` now marks historical cards with `.history`, while live
cards created by `createToolCard()` retain only `.tool-card`. The CSS selector
is narrowed to `.tool-card.history`, so live tool execution remains fully laid
out even when it is off-screen and scroll-to-bottom uses its real size.

The browser regression test creates a large live tool card through the actual
WebSocket event path while the page is scrolled up. It initially failed because
the live card's computed `content-visibility` was `auto`; it now observes
`visible` and verifies that the scroll-to-bottom control reaches the card.

### Fix 3 — [P2] Carry Expand All state into deferred chunks

`ToolCardRenderer` now records whether historical cards should be expanded.
`expandAll()` and `collapseAll()` update that state, and every later
`createHistoryCard()` call applies it to both the body and chevron. `clear()`
resets the state so an Expand All action cannot leak into another session.

The new E2E test invokes Expand All while most history is still pending. Before
the fix only 2 of 140 cards were expanded after progressive rendering
completed; afterward all 140 cards inherit the requested state.

### Fix 4 — [P2] Terminate fake sessions before closing the E2E server

E2E teardown now calls `liveManager.shutdown()` after closing browser contexts
and before `server.close()`. This rejects the fake child's pending RPCs instead
of leaving server requests alive until their 60-second timeout. Re-running the
original five-test suite immediately after this change reduced total runtime
from roughly 70.5 seconds to roughly 15.8 seconds, with all tests still passing.

### Fix 5 — [P3] Remove the obsolete overflow-anchor step

Step 5 of `plan.md` no longer instructs adding `overflow-anchor: none`. It now
documents the capability-gated `.native-scroll-anchoring` selector, the
history-only tool-card marker, the Safari fallback behavior, deferred Expand All
state, E2E teardown, and the new browser coverage. The plan and implementation
now describe the same anchoring strategy.

## Post-fix verification

- `npm run typecheck`: passed.
- `npm test`: 200 tests passed.
- `npm run test:e2e`: all 8 Chromium tests passed, including the forced manual
  anchoring, mid-fill Expand All, and live/history tool-card isolation cases.
- `git diff --check`: passed.
- A final read-only review of the fixes found no remaining issue or incomplete
  finding.

**Post-fix verdict:** All P1–P3 findings are resolved; the branch is ready for
re-review.
