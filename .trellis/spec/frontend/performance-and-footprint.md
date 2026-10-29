# Frontend Performance and Footprint Contract

## 1. Scope

This contract applies to the static-exported Next.js frontend when changing the workspace shell, route entry points, feature loaders, Context/store ownership, high-frequency interactions, persistent surfaces, heavy renderers, or static assets.

Read the cross-layer guide at `../guides/performance-and-footprint.md` first.

## 2. Production initial-load contract

The initial workspace graph contains only:

- the app/workspace shell;
- state and transport needed to render the default visible path;
- lightweight contracts, IDs, registries, and loading/error UI;
- features proven necessary before first interaction.

Conditional implementations must not be statically reachable from the initial route through a barrel, registry value, eager JSX element, or top-level import.

### Good

```tsx
const loadSettings = () => import("./settings-entry")

export function SettingsSlot({ open }: { open: boolean }) {
  return open ? <LazySettings /> : null
}
```

The loader module imports only a lightweight contract; `settings-entry` owns the implementation imports.

### Bad

```tsx
import { SettingsWorkspaceView } from "./all-workbench-views"

const views = { settings: <SettingsWorkspaceView /> }
```

Wrapping the second form in `lazy()` elsewhere does not restore a cold boundary if the barrel remains in the initial graph.

### Verification

- Inspect production `workspace.html` script links.
- Sum raw and one fixed compression level consistently.
- Search initial chunks for the cold entry's stable module/component markers.
- Exercise loading, error, retry, first open, and second open.

Source syntax alone is never sufficient evidence.

## 3. Cold-entry contract

Settings、project workbench panels、Canvas、Git-heavy panels、editor/viewer
implementations、Office、PDF、syntax highlighting 等条件功能使用显式冷入口，除非基线证据
证明它们属于默认可见路径。

Each cold entry must provide:

- lightweight loading UI with bilingual visible text when text is present;
- an error boundary and retry that can complete the user path;
- one owner for initialization and cleanup;
- measured first-open and repeat-open behavior;
- optional intent prefetch only when profiling justifies it.

Standalone and in-workspace entry points reuse the same implementation. Do not create a second feature implementation merely to obtain another chunk.

## 4. React update contract

- High-frequency local state stays local or in a narrowly scoped store/controller.
- Components subscribe through the smallest stable selector needed for rendering.
- Selectors must not allocate a new object/array on every unrelated update unless an equality strategy proves stability.
- Transport events enter a runtime/action boundary before updating view state.
- Streaming increments are batched by frame or another measured cadence; completed content remains stable.
- Composer keystrokes must not propagate to Sidebar, file tree, completed history, or unrelated surfaces.
- A Context is allowed for genuine React scope, but not as a broadcast bus for rapidly changing business state.

When migrating ownership, old and new owners may coexist only inside a bounded task with an explicit deletion step. Permanent double write or effect synchronization is forbidden.

## 5. Persistent surface contract

CodeMirror, Terminal, Office, WebView, PDF, and other expensive/persistent surfaces have a stable identity independent of pane placement.

- `surfaceId` remains stable across activate/background, pane move, tiled placement, and normal resize.
- Placement changes do not unconditionally mount/unmount the underlying instance.
- React provides a stable host; imperative controllers own non-serializable instances.
- Ordinary CSS surfaces do not push every geometry frame through React state.
- Native child WebView geometry preserves the existing generation and close-fence contract and coalesces unchanged rectangles.
- Project/session switches clean up the prior scope without leaking instances or listeners into the new scope.
- PDF worker teardown must be fenced behind outstanding `getPage` requests. An
  `AbortSignal` may cancel document opening, but must not directly destroy an
  already-open worker while a viewer or text extractor can still hold page work.

Required tests or diagnostics count mount/unmount and, where applicable, attach/detach across the target interaction.

## 6. Startup and idle frontend contract

- Provider mount is not implicit permission to start a long-lived runtime, poll, or sidecar.
- Read-only inventory/probe paths must not permanently allocate an executor when zero work exists.
- Polling must state its active/idle/focus intervals and why events/deadlines cannot replace it.
- Event-driven refresh includes a recovery path for missed events, normally focus, explicit refresh, or a low-frequency fallback.
- Listener and timer ownership includes cleanup on unmount, project change, retry, and window close.
- 跨挂载同步同一后端当前态的异步 setter/clear 必须保持跨实例顺序；旧实例的延迟清空不得覆盖新实例写入，用延迟 IPC 回归覆盖该竞态。
- 工作区正文投影以真正挂载且可见的文件宿主为准，不以 focus、tab 数组或未被布局消费的 pane/tiled 引用推断可见性。文件与终端并排时终端获焦不清文件；无实际 Viewer 时不得回退首个后台 tab。测试先核对实际布局路径，再造投影状态。
- 文件展示成功必须由加载就绪后的实际 Viewer 回传路径与位置；pending 槽清空不是成功信号。复用同一请求身份隔离取消/替换/超时/卸载/旧 lazy 回调，加载中旧缓冲不能提前确认新请求，回调不进入持久化。
- Multiple Providers must not independently read and synchronize the same persistent setting; choose one owner and one propagation path.

## 7. Asset contract

- Global fonts are limited to families/weights/scripts used by the shell; verify en, zh-CN, code, math, and terminal fallbacks.
- Prefer WOFF2 and subsets only when browser/platform coverage and glyph coverage are tested.
- PDF.js workers/cmaps and KaTeX fonts are feature assets, not generic dead weight. Optimize loading or duplicate formats before removing capability.
- A static route with bookmarks, exported-build, Tauri-window, or compatibility callers cannot be deleted based only on directory size.
- Only assets included in the formal package count toward release savings.

## 8. Measurement contract

Every frontend performance task records:

- exact scenario and scripted steps;
- commit/dirty state and artifact identity;
- primary metric and guardrails;
- at least p50/p95 for timing scenarios with sufficient samples;
- React commit/long-task data for hot paths;
- mount/attach counts for persistent surfaces;
- production route raw/gzip/script data for module graph claims;
- result and rollback decision.

Use the existing `src/lib/perf/` collector/bridge where practical. Do not create a second permanent performance subsystem for one task.

## 9. Required focused verification

Choose only checks directly related to the change:

```bash
pnpm exec vitest run <related-tests>
pnpm exec eslint <modified-files>
git diff --check
```

Runtime verification is performed by the user with the target Tauri scenario. Formal static-export/Tauri bundle inspection belongs to an explicit release gate, not routine development.

## 10. Review rejection signals

Reject or redesign a change when:

- it claims splitting based only on a `lazy()` diff;
- it reduces initial bytes by moving an unmeasured multi-second cliff to first open;
- it introduces a no-op Provider, duplicate store owner, permanent bridge, or second route implementation;
- it starts a thread, timer, watcher, or sidecar without current work or recovery intent;
- it trades away CJK/PDF/diagnostics/correctness for a package target;
- it reports `.next`, local cache, or untracked binary deletion as release savings;
- it lacks a traceable before/after artifact or a rollback boundary.
