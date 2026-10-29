# Backend Code Specifications

## Pre-Development Checklist

- 改项目事实（实体 / 迁移 / 数据实例解析 / 项目领域 service / CLI `project`）前读
  [Project persistence contract](./project-persistence.md)。
- 新增表或迁移：实体与迁移落 `src-tauri/project/berth-project-core/src/{entities,migration}/`；
  迁移 owner 唯一，历史迁移文件只允许搬家、不得改内容。
- 只读路径（CLI）不得写用户库：落后 schema 报状态并指向 GUI，不就地迁移。
- 跨层边界先看 [Tool Runtime Surface contract](../guides/tool-runtime-surfaces.md)，
  不要新增第二套 SQL / DTO / 迁移清单。

## Specifications

- [Project persistence contract](./project-persistence.md) — 迁移 owner、开库策略、实例状态与
  退出码、目录投影、搬家红线、测试与 Design Decision。

## Quality Check

- `src-tauri/src/db/` 不再出现 `entities/`、`migration/`；全仓只有一套迁移清单。
- GUI 与 CLI 的项目目录投影都来自 `service::catalog`，两侧只做线上 DTO 映射。
- 非 `Ready` 实例不产生空列表：CLI 单一 JSON 错误对象 + 2/5/6 退出码。
- 迁移搬家的 `git diff` 只出现 rename 与注册更新。
- 只读查询有「库文件字节不变」的测试证据。
