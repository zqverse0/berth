---
name: smart-search
description: 用 Berth 的 smart-search 插件联网搜索与取证：按问题意图选服务商、证据规则、深度调研怎么编排、超时后怎么退到来源优先。需要实时信息、核实事实、查文档或做多来源调研时读。
---

# smart-search 路由与取证

命令写法见插件 usage.md（`berth tools show smart-search`）；下文 `search` 即 `berth tools run smart-search private/search.js`，其余同理。

## 先查记录

每条结果都带 `existing_records`（本项目 30 天内相同或相互包含的问题）。先 `history show <id>` 看旧结果与抓过的正文，
够用就复用并注明记录 id；时效敏感（新闻、价格、版本号）或旧结果不全再重搜。

## 按意图选服务商

| 意图 | 首选 | 说明 |
|---|---|---|
| 宽泛探索、社区讨论、多来源概括 | `search` | AI 回答 + `primary_sources`；`--extra-sources 1~3` 补 Tavily / Firecrawl 候选 |
| 中文、国内、政策监管、公告、今日新闻 | `zhipu` | 来源列表，不出 AI 回答 |
| 库、SDK、API、框架文档 | `c7 library` → `c7 docs` | 先找库 id 再取片段 |
| 官方域名、论文、产品页、可信来源 | `exa` | 知道域名时加 `--include-domains`；Exa 不是所有核实的万能第二跳 |
| 给了网址、结论依赖页面原文 | `fetch` | Tavily extract → Firecrawl scrape |

`search` 内部已按意图补充：文档类问题加 Context7 / Exa 来源，中文实时类问题加智谱来源，问题里带网址会抓取该页。

## 证据规则

- 新闻、政策、金融、健康等高风险事实，不能只凭 `search` 的 `content` 回答：按意图选第二来源（中文实时→zhipu，
  文档→c7，官方→exa），再 `fetch` 关键页面，只写抓到的正文支持的内容。
- `extra_sources` 是并行取回的候选，不验证 `content` 里的论断；引用前先 `fetch`。
- 回答里保留来源网址，优先引用抓取过的页面与 `primary_sources`。
- 不暴露 key；`config_error` 时请用户去侧栏 smart-search「配置」填写或「导入旧配置」。
- 命令失败就报告失败与恢复办法，不悄悄换别的联网方式。

## 超时与退路

`search` 的 `error_type` 为 `network_error` 且消息含「超时」时（宿主已按配置自动重试过）：

1. 再试一次 `search "<问题>" --extra-sources 1`；
2. 仍失败就退到来源优先：`search "<问题>" --mode sources`，或 `exa "<问题>"`（知道官方域名加 `--include-domains`）；
3. `fetch` 最相关的 1~2 个网址，再下结论；回答里说明是由抓取来源拼出的，而非 AI 搜索直接生成。

## 深度调研（手工编排）

用户要「深度搜索 / 深度调研 / 交叉核实 / 选型对比」时：

1. 先拆 2~5 个子问题，每个写清为什么需要、要哪种能力（宽泛发现、中文实时、文档、官方来源、原文核实）。
2. 每个子问题先查记录，再按上表选服务商；宽泛发现用 `search`，权威来源用 `exa` / `zhipu` / `c7`。
3. 关键论断都 `fetch` 原文；同一结论至少两个独立来源，冲突时列出分歧与各自来源。
4. 汇总：结论、证据（网址 + 对应记录 id）、未核实项与不确定性。
