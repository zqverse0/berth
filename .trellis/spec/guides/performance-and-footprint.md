# Performance and Footprint Optimization Guide

## 1. When to read this guide

Read this guide before work that claims to improve startup, interaction latency, idle resource use, bundle/module loading, Rust binary size, static assets, sidecars, or installer size.

The long-term roadmap was archived to `REMOVE/.trellis/tasks/08-31-runtime-performance-footprint-roadmap/`. This guide remains applicable after that task is archived.

## 2. Fixed decision order

Evaluate tradeoffs in this order:

1. the user path remains short, responsive, and completable;
2. the implementation has one main path, clear owners, and no redundant work;
3. startup, interaction, and idle resource use improve;
4. initial load, binary, and package size improve.

Never remove a required language, file format, diagnostic, security behavior, or recovery path merely to meet a size target. In particular, do not start with `panic=abort`, blind CJK cmap removal, PDF worker removal, or deletion of compatibility routes with active callers.

## 3. Before changing code

Write down:

- **User result:** one sentence describing what becomes faster or lighter for the user.
- **Scenario:** startup, initial workspace, hot interaction, idle, cold-path first open, build/install, or release package.
- **Primary metric:** exactly one metric that decides whether the change worked.
- **Guardrails:** correctness, first-open cost, resource use, and any compatible/recovery path that must not regress.
- **Baseline identity:** commit, dirty state, artifact, toolchain, machine, dataset, steps, and sample count.
- **Rollback:** the smallest change that can be reverted independently.

If these cannot be stated, keep researching instead of opening a broad optimization PR.

## 4. Evidence rules

- Compare before/after on the same environment and procedure.
- Cold-start timing uses at least 10 samples and reports p50/p95.
- Differences below 5% are treated as possible noise until repeated.
- A production bundle claim must use an artifact traceable to the measured source.
- Do not use the dev server or `.next` cache as release bundle evidence.
- A source-level `lazy()` or `dynamic()` call is not proof of code splitting; inspect production route HTML and actual requested chunks.
- A smaller dependency tree is not proof of a smaller binary; report the artifact delta.
- Fewer Providers, files, or lines are structural signals, not performance results by themselves.

Every retained optimization records expected effect, observed effect, guardrail result, and verdict. Revert or redesign changes that miss the primary metric or break a higher-priority guardrail.

## 5. Preferred optimization order

Within a scenario, prefer:

1. remove dead or duplicate user paths and owners;
2. stop work that has no current user intent;
3. replace fixed polling with event/deadline/focus wakeups and a safe low-frequency fallback;
4. isolate cold implementations from the initial module graph;
5. constrain updates to precise selectors or stable controllers;
6. align duplicate runtime/dependency stacks;
7. trim proven-unused features and assets;
8. tune compiler/profile flags only after the above.

This order is not a license for unrelated cleanup. Each task still uses the smallest cut that satisfies its one-sentence result.

## 6. Lifecycle checklist

For every thread, timer, watcher, listener, sidecar, WebView, editor, or terminal runtime, answer:

- What explicit user or recovery intent starts it?
- Does a read-only probe accidentally make it permanent?
- What happens with zero projects, zero terminals, or zero schedules?
- Can it sleep until an event or nearest deadline?
- Who owns cleanup on project change, window close, error, and retry?
- Can repeated mount/retry create a duplicate owner?
- Is a low-frequency fallback required for missed events?

Zero-work idle is a first-class product scenario, not an edge case.

## 7. Initial-load checklist

- Measure scripts linked by production `workspace.html`, their raw/gzip size, and chunk markers.
- Keep shell and currently visible default behavior in the initial graph.
- Load Settings、project workbench panels、Canvas、Git-heavy panels、file viewers、
  editor、Office、PDF、syntax highlighting 等条件功能 on real intent，除非证据表明它们
  对首个交互必不可少。
- Check the whole import path: a light loader must not import a barrel that imports the implementation.
- Every cold entry has loading, error, retry, and a measured first-open path.
- Use hover/focus/idle prefetch only when it improves intent-to-interactive without unacceptable idle CPU/network work.

For frontend implementation details, also read `../frontend/performance-and-footprint.md`.

## 8. Rust and asset checklist

- Inspect duplicate versions, TLS backends, default features, build scripts, and platform features before changing release profiles.
- Remove direct dependencies only after checking source, generated code, build scripts, feature-gated modules, and platform targets.
- Compression/archive feature trimming requires a read/import compatibility matrix, not only current write methods.
- Keep Tauri custom-protocol and dynamic-style CSP behavior intact in formal builds.
- Count only files that enter the final package; local caches and unconfigured binaries are not release savings.
- Keep PDF.js/CJK support and compatibility URLs unless a product decision provides a tested replacement.

## 9. Verification gate

During implementation run only directly related tests, target lint/type checks, structural inspection, and `git diff --check`, as required by `AGENTS.md` and `docs/verification.md`.

A formal Tauri bundle is reserved for an explicit release gate. That gate must verify:

- bundle and unpacked size by major component;
- initial route scripts and raw/gzip size;
- startup, target interaction, and idle guardrails;
- real user paths through history、Agent configuration、terminal start/resume、file
  viewers、Settings 和 project workbench；
- `tauri/custom-protocol` and dynamic `<style>` CSP behavior.

## 10. Review questions

- Is the claimed win visible in a user or runtime metric, or only in source structure?
- Did the change move work from startup to an unmeasured first-open cliff?
- Did it replace a poll with an event while preserving recovery from missed events?
- Does it introduce a second owner, cache, entry, scheduler, or diagnostic path?
- Does it keep an executor/thread/sidecar alive after a no-op probe?
- Is the measured artifact traceable to this exact source state?
- Can the change be independently rolled back if a platform regression appears?
- Does any lower-priority size goal damage a higher-priority user path?
