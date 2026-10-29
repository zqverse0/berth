# Frontend Code Specifications

## Pre-Development Checklist

- For automation execution status, run history, or reminders, read [Automation results contract](./automation-results.md).
- For resizable layouts, read [Split layout contract](./split-layout.md).
- For local file formats, readers, or reader controls, read [File viewer contract](./file-viewers.md).
- For Agent Tool Asset projection, launch capabilities, configuration UI, resources, or diagnostics, read [Agent Tool Asset frontend contract](./agent-contract-core.md) and the cross-layer [Tool Runtime Surface contract](../guides/tool-runtime-surfaces.md).
- For Pi expert tables or launch inputs, read [Pi expert table contract](../guides/expert-package-persona.md).
- For startup, initial bundles, lazy entries, hot interactions, persistent surfaces, idle work, or frontend assets, read [Frontend performance and footprint contract](./performance-and-footprint.md) and the cross-layer [performance guide](../guides/performance-and-footprint.md).
- For the left sidebar (views, header tabs/actions), read `src/components/layout/sidebar/sidebar-header.tsx`: a view body declares its header content with `SidebarHeaderTabs` / `SidebarHeaderActions` (portal into the shell header) and keeps its own state; never add a second in-body tab strip or a per-view header store.
- Reuse the existing SplitView engine; do not add a second panel-resize implementation.
- Identify whether the content is a persistent surface or a transient overlay before changing placement.

## Specifications

- [Split layout contract](./split-layout.md) — layout solver, preview/commit boundary, accessibility, expensive consumers, and required tests.
- [File viewer contract](./file-viewers.md) — seven-kind classification, local runtime controller seam, shared Header controls, lifecycle, and extension tests.
- [Agent Tool Asset frontend contract](./agent-contract-core.md) — `tool.json` identity, `launchbar.json` + `launch.py` start, configuration/resource surfaces, renderer fallback, and diagnostics.
- [Frontend performance and footprint contract](./performance-and-footprint.md) — production module graph, cold-entry completeness, precise updates, stable surfaces, idle lifecycle, assets, and evidence gates.

## Quality Check

- No `react-resizable-panels` or alternative split engine is introduced.
- Pointer preview stays out of React/store/persistence.
- Cancellation and keyboard behavior have focused tests.
- Persistent Terminal/editor/PDF/native surfaces do not remount on resize.
- Agent behavior comes only from contracts; no Agent-specific paths, flags, or renderer branches are added.
- Agent filesystem/runtime operations remain contract-scoped and failures are never silently swallowed.
- Production route HTML, not source-level `lazy()`, proves the initial-load boundary.
- Hot-path changes have commit/long-task or lifecycle evidence and do not create duplicate owners.
- Idle probes do not permanently create threads, timers, watchers, or sidecars without work.
