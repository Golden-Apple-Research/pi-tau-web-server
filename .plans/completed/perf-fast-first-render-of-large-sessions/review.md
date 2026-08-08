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

---

# Second-round review — full branch at `eae4c63`

Branch: `feat/faster-first-render-on-large-session` (`eae4c63`), reviewed
against `main` at `9131d4a`. This round re-reviews the complete diff including
the fix commit, verifies that the five first-round findings stayed fixed, and
looks for issues the first round did not cover.

## Confirmation of the first-round fixes

All five fixes are present in the code and behave as described in the fix
summaries above:

1. `.native-scroll-anchoring` is applied to the messages container only when
   `CSS.supports('overflow-anchor', 'auto')` succeeds
   (`src/public/app-main.ts:1736-1740`), and both `content-visibility` rules in
   `public/style.css:1486-1490` require that class, so Safari's manual
   compensation path never combines with deferred intrinsic sizing.
2. `createHistoryCard()` marks cards with `tool-card history` while
   `createToolCard()` keeps plain `tool-card`, and the CSS selector targets
   `.tool-card.history` only, so live cards stay fully laid out.
3. `historyCardsExpanded` is set by `expandAll()`/`collapseAll()`, applied to
   both body and chevron of every later history card, and reset in `clear()`.
4. E2E teardown closes contexts, then calls `liveManager.shutdown()` before
   `server.close()` (`test/e2e/history-render.e2e.ts:228-235`); the suite
   completed in about 56 seconds with no hung teardown.
5. Step 5 of `plan.md` now documents the capability-gated selector; no
   `overflow-anchor: none` instruction remains.

Beyond the fixes, the second pass confirmed several structural properties:
every conversation-teardown site now routes through `clearConversation()` (no
remaining direct `messageRenderer.clear()`/`toolCardRenderer.clear()` pairs
outside the helper), `addHistoryResult()` operates purely on the `toolCards`
map so it works on cards still inside a detached fragment, and nothing after
the now-early-returning `renderSessionHistory()` call in
`applyLiveSessionSnapshot()` depends on the full history DOM existing
(`updateContextPill`, tree refresh, and the stats refresh are all
DOM-independent).

## New findings

### 6. [P3] Native scroll anchoring is suppressed at the very top, so chunks inserted while the user sits at `scrollTop = 0` still shift the content they were reading

The CSS scroll-anchoring spec deliberately skips adjustment when a scroll
container's offset is zero (so that content prepended to a page top is shown
rather than scrolled past). Verified in this Chromium build with a standalone
probe: inserting 250px above the viewport at `scrollTop = 500` left the
anchored element at exactly the same visual position (scrollTop became 750),
but the same insertion at `scrollTop = 0` left scrollTop at 0 and moved the
previously visible element 250px down.

In this branch that means a user who opens a large session and immediately
scrolls to the very top of the loaded history (Home key, or dragging the
scrollbar to the top) will have their reading position pushed down repeatedly
as each remaining chunk is prepended — the one case the native-anchoring path
cannot cover. The Safari fallback path does not have this problem, because the
manual `prevTop + (scrollHeight − prevHeight)` compensation works from any
offset including zero. The window is narrow (only during the progressive fill,
only at exactly offset zero) and self-corrects when the fill completes, hence
P3 rather than P2. A minimal fix: in the native-anchoring branch of
`renderOlderChunk()`, apply the manual compensation when
`messagesContainer.scrollTop === 0`, since that is precisely where native
anchoring abstains.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/src/public/app-main.ts:1822-1828`

### 7. [P3] The two reading-position E2E tests can pass vacuously on a fast machine

`assertProgressiveFillPreservesReadingPosition()` captures the anchor after the
jump-to-bottom settles but never asserts that the progressive fill was still
incomplete at that moment. If the fill finishes before the anchor is captured
(possible on a fast machine despite the 4× CPU throttle, or if the throttle
rate is ever lowered), the subsequent wait-for-completion returns immediately
and the ≤3px assertion passes without any chunk ever being prepended above the
anchor — silently losing the coverage both anchoring tests exist to provide.
The first-paint test already guards against this class of problem by asserting
`count < TOTAL_ITEMS / 2` at observation time; recording the rendered count
when the anchor is captured and asserting it is below `TOTAL_ITEMS` would give
these two tests the same protection.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/test/e2e/history-render.e2e.ts:174-185`

### 8. [P4] A `[History]` console.log remains in the rewritten render path

Plan Step 0 removed the debug logging because the per-card `offsetHeight` read
forced layout. The rewritten `renderSessionHistory()` still logs
`[History] Rendering N items from M entries` once per session open. It forces
no layout and costs nothing measurable, but it is developer-debug output in
production and the only survivor of the family of logs this branch otherwise
removed. Keep it deliberately or drop it; either way the choice should be
intentional.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/src/public/app-main.ts:1776`

## Verification

- `npm run typecheck`: passed.
- `npm test`: 200 tests passed.
- `npm run test:e2e`: all 8 Chromium tests passed (about 56 seconds total).
- Standalone Chromium probe of scroll-anchoring suppression at offset zero:
  anchored element stable at `scrollTop = 500` (moved 0px), displaced 250px at
  `scrollTop = 0` — confirming finding 6 is real browser behavior, not
  speculation.

## Overall assessment

**Verdict:** Approve; the two P3 findings and the P4 nit are follow-up
material, not blockers.

The progressive-render architecture is sound: the pure pre-pass keeps
tool-result pairing and stats correct regardless of render order, the
generation token makes cancellation airtight at every teardown site, and the
capability-gated CSS cleanly separates the native and manual anchoring worlds.
The first round's P1 regression and both P2 regressions remain fixed and are
now pinned by targeted browser tests. The one remaining hole in the
"never move the reading position" guarantee is the offset-zero anchoring
suppression described in finding 6 — real but narrow, transient, and absent
from the Safari path — and the E2E robustness and logging notes are minor
polish. The branch is safe to merge as-is.
