# 项目持久化（`berth-project-core`）

- 实体与迁移只在本 crate 的 `src/{entities,migration}/`（迁移 owner 唯一，宿主侧已无
  `db/entities`、`db/migration`）；领域 service 放本 crate `src/service/` 或宿主
  `src-tauri/src/db/service/`，两处注册。
- **已执行的迁移不得修改**；迁移命名 `m{YYYYMMDD}_{NNN}_{description}.rs`。
- 实体 / 迁移 / 开库策略 / CLI `project` 的契约：`.trellis/spec/backend/project-persistence.md`。
