# Documentation Truth Contract

## Scope

Read this guide when changing `AGENTS.md`, `docs/README.md`, architecture docs, Trellis specs,
or project skills.

## Authority

- `AGENTS.md` owns product rules and red lines.
- `docs/architecture.md` owns current module boundaries and data flows.
- `.trellis/spec/` owns implementation contracts for future changes.
- `.trellis/tasks/` owns temporary plans and evidence.
- `docs/REMOVED.md` owns history only.
- `docs/README.md` owns the project overview and documentation map.

## Evidence requirements

Every active capability or path named in agent-facing docs must be backed by an active registration,
caller, implementation, or focused test. Migrations, compatibility DTOs, redirects, orphan files and
REMOVED entries are not sufficient proof of current behavior.

When source and docs disagree, inspect source and update the canonical document. Do not preserve both
claims with vague wording.

## Anti-patterns

- Copying a task PRD into permanent docs after implementation changed.
- Listing project panels from screenshots instead of `src/lib/workbench/catalog.ts`.
- Treating a retained migration as an active product module.
- Repeating the same volatile file inventory in AGENTS, docs overview, specs and skills.
- Using generated `out/`, `target/` or local assets as source evidence.

## Verification

Run only cheap checks:

```bash
rg -n 'WORKBENCH_(PAGES|PANELS)' src/lib/workbench/catalog.ts
rg -n 'PROJECT_PAGE_IDS' src/components/project-management/pages/types.ts
rg -n 'PROJECT_PAGE_LOADERS' src/components/project-management/pages/index.tsx
rg -n 'src-tauri/src/parsers|project_agent_sessions|Chat Channels|Project Boot' \
  AGENTS.md docs .trellis/spec .agents/skills
git diff --check
```

Matches inside `docs/REMOVED.md` are historical and should be reviewed, not blindly removed.
