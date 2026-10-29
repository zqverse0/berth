# 自动化执行结果契约

## 1. 范围与触发

修改自动化调度结算、运行历史或提醒时阅读。进程正常结束只证明执行事实，不能证明用户任务通过验收。

## 2. 接口

沿现有 `automations` command 的 `list_runs` 返回 `AutomationRunInfo`。
共享结算使用 `settle_run(conn, run, terminal_id, RunOutcome) -> Result<bool, DbError>`；
`false` 表示未改变已结算记录，不能再次覆盖任务摘要。

## 3. 数据契约

运行 DTO 增加可空 `stopReason`，复用数据库 `stop_reason`，不新增状态枚举或迁移。
`process_exited` 表示取得退出码；`execution_failed` 表示明确执行失败；
`execution_unverified` 表示观察失败，数据库兼容存为 `failed`，UI 显示“执行结果无法核实”。
旧 `succeeded` 若没有 `process_exited`，显示历史结果未核实，不改写原记录。

## 4. 验证与错误矩阵

| 观察 | 结果 |
| --- | --- |
| Running | 保持 running |
| Exited + code 0 | succeeded / 进程正常结束 |
| 非零退出码或明确 Failed | failed / 执行失败 |
| Exited 无退出码、成功 inventory 中不存在 | execution_unverified |
| inventory / 退出快照查询失败 | 重试；从首次连续失败起 120 秒后标 execution_unverified |

重试状态由唯一 scheduler 循环持有，沿既有节拍重试；恢复清除，非活跃 run 移除。
重启应用会重新开始观察窗口。不得以 run 的启动时间计算失联超时。

## 5. 正常与边界样例

运行一小时后短暂断连仍处于重试；恢复运行后清除计时。
同一 run 先结算退出 7，再收到退出 0，保留原失败与结束时间；新一轮可正常认领。

## 6. 定向验证

Rust 过滤 `automation_result_review`：退出码、无证据、独立计时、恢复、结算幂等及摘要一致性。
前端 `automations-console.test.tsx`：en / zh-CN 区分正常退出、明确失败、无法核实及旧记录。
真实 CLI 生命周期与 daemon 重启另做运行时验证；模拟观察不证明 pane 身份稳定。

## 7. 易错点

错误：`describe()` 返回错误或 `error == null` 就记成功。
正确：`try_list()` 保留运行时错误；确认 Exited 后读取 `snapshot.exit_code`，仅 code 0 可成功。
`describe()` 会将 RuntimeUnavailable 转成 NotFound；`list()` 会吞错为空，均不能证明进程已退出。
结算只条件更新 running 行，运行结果与任务摘要必须在同一数据库事务提交。

## 8. 任务定时（`task` 非空）

结果以 Agent 交的结果文件为准（`.berth/runs/<任务>/<stamp>.md`，stamp 由 run 的 `created_at` 算出，
终端环境 `BERTH_TASK_RUN` 经 `create_terminal_core` 的 `extra_env` 传给 Agent——Agent 启动会丢掉请求里的 `env`），不看退出码；交互式 Agent 不退出也能结算，终端保留可接管。

| 观察 | 结果（stop_reason） |
| --- | --- |
| 结果文件已存在 | succeeded / `result_submitted`，`result_path` 指向它 |
| 终端退出或不在 inventory，且没有结果 | failed / `needs_attention` |
| hook 报空闲 ≥20 秒（还没报过状态则按启动时长）、启动 ≥60 秒、没有结果 | 发续跑指令（带完整任务说明，首条消息可能丢），间隔 ≥90 秒，最多 3 次；用尽为 `needs_attention` |
| 运行满 2 小时没有结果 | failed / `timeout` |
| inventory 查询失败 | 只认结果文件，其余等恢复 |

任务归档或不存在：到点时停用定时、不建运行（`stop_if_task_closed`）。没挂任务的旧自动化不再触发。
Rust 过滤 `task_run_continues`；前端 `task-schedule.test.tsx`。
