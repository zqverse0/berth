# 联网搜索（smart-search）

查实时信息、核实事实、查库文档、读网页时用它，不用其他联网搜索方式。命令都是
`berth tools run smart-search private/<下表脚本> …`，输出 JSON，`-h` 看选项：

| 要做什么 | 命令 |
|---|---|
| 综合搜索（AI 回答 + 来源） | `search.js "<问题>"`；只要来源列表加 `--mode sources`；要更多候选加 `--extra-sources 2` |
| 中文 / 国内 / 政策 / 今日新闻 | `zhipu.js "<问题>"` |
| 官方站点、论文、限定域名 | `exa.js "<问题>" [--include-domains a.com,b.com]` |
| 库 / 框架 / API 文档 | `c7.js library <库名> [问题]` → `c7.js docs <库 id> "<问题>"` |
| 读网页正文（Markdown） | `fetch.js <网址>` |
| 看搜过什么 | `history.js find "<问题>"`、`history.js [--all]`、`history.js show <记录 id>` |
| 存到知识库「来源」 | `save.js <网址> [--title <标题>] [--query <问题>]` |

规矩：

- **先查记录再搜**：结果里的 `existing_records` 是本项目 30 天内问过的相同问题，先 `history.js show <id>`
  看旧结果；够用就复用并说明来自哪条记录，不够新或不够全再搜。每次搜索、抓取都会自动留记录。
- **只有用户要求时才 `save.js`**（「存到来源」「收进知识库」）；自己搜的内容只进记录，不存来源。
- 论断要有证据：`content` 是 AI 生成的，`extra_sources` 只是候选；关键结论先 `fetch.js` 原文，引用抓到的页面或 `primary_sources`。
- 回答里保留来源网址。失败看 `error_type` / `provider_attempts`；`config_error` 让用户去侧栏 smart-search「配置」填 key，不要索要或打印 key。
- 选服务商、深度调研、超时处理的细则见本插件 skill：`skills/smart-search/SKILL.md`（`berth tools show smart-search` 列出路径）。
