# Split Layout Contract

## 1. Scope / Trigger

Use this contract whenever adding or changing a horizontal/vertical resizable pane, workspace geometry, or an expensive consumer of pane size. Berth has one split engine: `src/components/ui/split-view.tsx` backed by `src/lib/split-view.ts`.

## 2. Signatures

Public React components:

```ts
SplitView
SplitViewPane
SplitViewHandle
```

Core layout input/output is pixel-based at runtime and supports pane weights, min/max constraints, visibility/collapse, adjacent-pane redistribution, and 2–N panes. Layout transactions expose preview and commit phases through the scoped split-layout transaction context.

## 3. Contracts

### Preview

`pointermove` may only calculate a constrained delta and schedule one local CSS Grid geometry write per animation frame. It must not update React/store, persist state, resize PTYs, send native bounds, or remount surfaces.

A mounted Terminal may additionally adapt its **local xterm emulator grid** from the nearest scoped transaction's `isPreviewing()` state. This is not a PTY resize: it must be rAF-coalesced, preserve the viewport, use cell-boundary hysteresis, and stay mutually exclusive with snapshot paint, authoritative resize, and in-flight xterm writes. Commit uses the exact final grid and sends at most one deduplicated PTY resize; cancel restores the committed local grid and normally sends none.

### Commit

`pointerup` flushes the final preview and publishes committed geometry once. Expensive consumers such as Terminal, Native Surface, PDF, and Image process the final size through the scoped transaction.

### Cancel

`pointercancel`, `lostpointercapture`, window blur, and unmount cancel pending frames, restore committed geometry, remove listeners, and do not persist.

### Accessibility

A handle is a focusable `role="separator"` with correct `aria-orientation`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-controls`. Recognized keyboard commands prevent default even at a boundary. Arrow keys resize; Home/End select bounds; Enter collapses/restores when supported.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Container has no measurable size | Do not begin a corrupt drag; keep committed layout |
| Constraints cannot fit | Solver clamps deterministically; no negative tracks |
| Pointer is cancelled/lost | Roll back preview; no commit |
| Same final geometry | Consumer may skip duplicate work |
| Pane is hidden/collapsed | Track and ARIA values remain consistent |
| Consumer is inside nested SplitView | Subscribe to the nearest scoped transaction only |
| Pane constraints change and a parent effect calls `setLayout` | Imperative registration refs must already contain the new pane/handle specs |

Never swallow layout errors globally. Do not install `ResizeObserver` error suppression.

> **Warning**: pane/handle registration refs are part of the imperative layout contract. Update them synchronously inside registration callbacks before scheduling React state. A parent effect may call `setLayout` in the same commit as `collapsed`, `visible`, `min/max`, or handle `disabled` changes; refs that lag until a later render solve against stale constraints and can resize the opposite pane.

## 5. Good / Base / Bad Cases

- Good: three-pane shell uses one SplitView with pixel min/max and one commit callback.
- Base: a simple dialog uses the same SplitView without expensive-consumer subscriptions.
- Bad: wrap another panel library in an adapter, write geometry through React on every pointermove, or add a component-specific freeze bus.

## 6. Tests Required

- Pure solver: 2/3+ panes, horizontal/vertical, min/max, collapse, hidden panes, redistribution.
- Gesture: rAF coalescing, pointer capture, pointercancel, lost capture, blur, unmount.
- Accessibility: orientation, ARIA values, Arrow/Home/End/Enter, boundary `preventDefault`.
- Integration: conditional and nested panes; existing default ratios and limits.
- Performance: 100 pointer moves produce no store/persistence/PTY/native commit and no more CSS/local-terminal-grid writes than frames.
- Terminal local fit: viewport remains pinned; ±1 cell reversal is debounced but exact commit is not; painter/write fences defer local fit; authoritative geometry supersedes queued preview geometry.
- Lifecycle: Terminal, editor, PDF, and native hosts keep identity during drag/maximize/restore.

## 7. Wrong vs Correct

### Wrong

```ts
new ResizeObserver(() => {
  setLayout(readPaneRects())
  resizeBackend() // preview SIGWINCH storm
})
```

This creates a write/read/write feedback chain and pushes preview work through React and the backend.

### Correct

```ts
onPointerMove((delta) => splitView.schedulePreview(delta))
if (transaction.isPreviewing()) terminal.requestLocalGridFit()
onPointerUp(() => splitView.commit()) // one authoritative PTY resize
```

The engine writes local CSS Grid geometry during preview; scoped consumers receive one committed change.

## Design Decision

Berth uses a headless in-repo SplitView instead of `react-resizable-panels`, native CSS `resize`, or component-specific drag patches. The previous library updated React state during live drag and required compensating freeze/observer paths for desktop-workbench surfaces. New split layouts must extend the existing solver and component API rather than introduce a parallel engine.
