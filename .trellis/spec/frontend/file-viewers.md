# File Viewer Contract

## 1. Scope / Trigger

Use this contract when adding a local file format, changing file classification, adding reader controls, or changing Image/PDF/Office/Text viewer lifecycle. Non-file workspace documents (`web`, `transcript`, `diff`, `rich-diff`) stay outside this registry.

## 2. Signatures

Static classification lives in `src/lib/file-viewer-definition.ts`:

```ts
type FileViewerKind =
  | "text" | "markdown" | "html" | "excalidraw"
  | "image" | "office" | "pdf"

fileViewerKindFromPath(path: string): FileViewerKind
fileViewerDefinitionFromTab(tab: FileWorkspaceTab): FileViewerDefinition | null
```

Dynamic toolbar state is bridged locally:

```ts
useFileViewerController(snapshot: FileViewerToolbarState | null): void
```

React dispatch is exhaustive through `FileViewerHost` (`src/components/files/viewers/registry.tsx`, a `Record<FileViewerKind, …>`); do not add another top-level local-format chain to `FileWorkspacePanel`.

```ts
interface FileViewerProps { tab: FileWorkspaceTab; visible: boolean; active: boolean }
useFileReveal({ tab, visible, textBuffer, revealLine, waitForLine? }): () => void
```

Each Viewer owns its loading state (`viewers/viewer-states.tsx`), selection reporting, reveal completion (`useFileReveal`) and toolbar controller. `TextFileViewer` owns all CodeMirror state (IME, language packs, git markers). Saving (autosave, blur save, Ctrl+S) is `viewers/use-file-tab-save.ts`, shared by every text-buffer viewer (text and Excalidraw). `FileWorkspacePanel` only resolves the active tab, registers the document context, and dispatches non-file documents (transcript / task / diff).

## 3. Contracts

- Classification is pure: no React imports, runtime state, I/O, or component references.
- `fileOpenStrategyFromPath` remains the compatible loading entry and derives from the Viewer definition.
- `FileViewerRuntimeProvider` wraps `FileWorkspaceHeader` and `FileWorkspacePanel` inside each stable file Surface.
- Viewer-owned state remains in the Viewer. The runtime only publishes a stable controller snapshot to the Header.
- All persistent controls render in `FileWorkspaceHeader`. Viewer bodies render content, loading/error feedback, and direct content interaction only.
- Keep the visible PDF surfaces plus at most one recently hidden PDF surface mounted so switching between PDF tabs preserves the PDFViewer and its canvases. If a PDF leaves that bounded surface set, keep its non-serializable `PdfDocumentSession` in the bounded runtime cache keyed by file identity and source revision; eviction calls `session.close()`.
- Local PDF loading uses the existing range transport boundary instead of assembling a full in-process file buffer. Text extraction is deferred and is enabled only for the visible active PDF surface.
- Toolbar state updates must not change Surface keys, CodeMirror document ids, PDF keys, or native Office host identity.
- Non-file documents retain the fixed Header height even when they have no local-file controls.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unknown extension | Classify as `text` |
| `*.excalidraw` / Obsidian `*.excalidraw.md` | Classify as `excalidraw` before the markdown check |
| Viewer controller kind differs from active definition | Ignore the controller |
| Viewer unmounts or tab changes | Unregister stale controller |
| Capability exists but runtime action is unavailable | Hide the action; never render a dead button |
| Narrow pane | Keep controls reachable through Header overflow without widening the Surface |
| Non-desktop Office/PDF external action | Hide unavailable desktop-only action |

## 5. Good / Base / Bad Cases

- Good: add an EPUB definition, loader policy, registry renderer, and controller-backed Header controls.
- Base: a text format falls back to `text` and reuses CodeMirror controls.
- Bad: inspect `.pdf` inside `FileWorkspaceHeader`, keep a second PDF toolbar in `PdfPreview`, or copy PDF page state into Zustand.

## 6. Tests Required

- Classification: every supported extension, uppercase paths, unknown fallback, and the compound `.excalidraw.md` suffix.
- Registry: `FILE_VIEWER_KINDS` covers every `FileViewerKind` exactly once (the `Record` type enforces one renderer per kind).
- Runtime: registration, snapshot update, unregistration, tab/kind mismatch.
- Header: each capability invokes the Viewer action; unavailable actions are absent.
- Viewer integration: Image metadata/zoom, PDF navigation/zoom/fit-width, Office retry/external open.
- PDF lifecycle: remounting the same file identity and revision reuses one session; releasing an idle session does not close it immediately; exceeding the warm limit and explicit cache cleanup close it exactly once.
- Lifecycle: workspace placement tests prove file renderers stay mounted across pane movement, and range-backed PDFs do not read the entire source during `openPdfSource`.
- Layout: non-file documents preserve Header height and narrow panes do not overflow.

## 7. Wrong vs Correct

### Wrong

```tsx
if (path.endsWith(".pdf")) return <PdfToolbar />
if (path.endsWith(".docx")) return <OfficeToolbar />
```

This duplicates classification in the Header and couples chrome to extensions.

### Correct

```tsx
const definition = fileViewerDefinitionFromTab(tab)
useFileViewerController({ kind: "pdf", zoom, pdf, openExternal })
```

The pure definition owns static facts; the mounted Viewer owns dynamic actions; the shared Header only renders published capabilities.

## Design Decision

Viewer runtime is a local Context seam rather than a global store. PDF page/zoom, image dimensions, and Office watch state are high-churn, instance-owned values. A local stable controller keeps one source of truth and prevents toolbar updates from remounting expensive surfaces.
