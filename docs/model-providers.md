# 在 Berth 之外使用已存的模型服务商

Berth 的服务商档案（设置 → 模型服务商）可以给三类调用方用：自己写的脚本、
不在 Berth 里的工具、外部终端里打开的 Agent。三者走同一条路：

```text
调用方 ──代理地址 + 令牌──▶ 127.0.0.1 代理 ──真 Key──▶ 服务商
```

令牌（`berth-tk-…`）是本机占位凭据，只能访问 127.0.0.1 上的代理；真 Key 只存在
keyring 和代理内存里，任何调用方都拿不到。

## 端点类型

| 类型 | Berth 用它做什么 | 这个地址下通常还有 |
|---|---|---|
| OpenAI 兼容（`chat`） | 注入 Codex / Grok / Pi；获取模型列表 | 对话、画图、embedding、rerank |
| Anthropic（`claude`） | 注入 Claude Code | 对话 |
| Gemini（`gemini`） | 注入 Gemini CLI | 对话、embedding |
| 决策（`systemone`） | 决策面板 | Jev 等决策模型 |
| 其他（自己起名） | 不看懂格式，只转发 | 搜索、工具类 API 等 |

画图、embedding 不另加端点：它们和对话在同一个 OpenAI 兼容地址下。

## 拼接规则

代理地址 = `http://127.0.0.1:<端口>/p/<档案 id>/<端点名>`，它**等价于你填的那个 URL**：
文档在原 URL 后接什么路径，就在代理地址后接同样的路径；Key 放在文档要求的位置（任意
请求头或网址参数），值换成令牌。端口：正式版 15722，dev 实例 15723。

```text
填写：  https://api.siliconflow.cn/v1
文档：  POST https://api.siliconflow.cn/v1/images/generations
调用：  POST http://127.0.0.1:15722/p/12/chat/images/generations
        Authorization: Bearer <令牌>
```

设置页每个已保存的端点下都有调用地址、复制令牌按钮和各类调用示例。

`<服务商>` 可以写编号，也可以写名字（不分大小写；完整匹配优先，否则名字的一部分能唯一
匹配即可，如 `deepseek`、`jev`）。

## 1. 自己的脚本

```sh
berth provider run deepseek -- python draw.py
```

子进程环境（值全是代理地址或令牌）：

| 端点 | 变量 |
|---|---|
| OpenAI 兼容 | `OPENAI_BASE_URL`（含 `/v1`）、`OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` |
| OpenAI 兼容（旧名） | `OPENAI_API_BASE`（旧版 openai SDK、LangChain） |
| Gemini | `GOOGLE_GEMINI_BASE_URL`、`GEMINI_API_KEY` |
| 每个端点 | `BERTH_PROVIDER_<端点名大写>_URL`（如 `BERTH_PROVIDER_SEARCH_URL`） |
| 总是 | `BERTH_PROVIDER_ID`、`BERTH_PROVIDER_TOKEN`、`BERTH_PROVIDER_MODELS`（JSON 数组）；`--model` 时另有 `BERTH_PROVIDER_MODEL` |

所以脚本里照常写，SDK 自己读环境变量：

```python
from openai import OpenAI
client = OpenAI()  # OPENAI_BASE_URL / OPENAI_API_KEY 已由 berth provider run 设好
client.images.generate(model="<模型>", prompt="a cat")
```

「其他」端点用 `BERTH_PROVIDER_<名字>_URL` + `BERTH_PROVIDER_TOKEN`。例：名为 `search`
的端点填 `https://api.search.brave.com`，Brave 要求 Key 放在 `X-Subscription-Token` 头：

```python
import os, requests
r = requests.get(os.environ["BERTH_PROVIDER_SEARCH_URL"] + "/res/v1/web/search",
                 params={"q": "berth"},
                 headers={"X-Subscription-Token": os.environ["BERTH_PROVIDER_TOKEN"]})
```

Python 的 Gemini SDK（`google-genai`）不保证读 `GOOGLE_GEMINI_BASE_URL`，显式传：
`genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options={"base_url": os.environ["GOOGLE_GEMINI_BASE_URL"]})`。

工具读的是别的变量名时，用 `--env 变量名=<端点名>|token` 补（可重复）：

```sh
berth provider run 68 --env DEEPSEEK_API_KEY=token --env DEEPSEEK_BASE_URL=chat -- python app.py
```

`<端点名>` 得到该端点的代理地址（等价于填写的 URL，不自动补 `/v1`），`token` 得到令牌。

### 写进 shell 或 `.env`

不经 `run` 启动的工具（终端里直接敲的命令、读 `.env` 的项目），用 `berth provider env`
打印同一组变量，同样支持 `--env` 与 `--model`：

```sh
eval "$(berth provider env 12)"                         # 当前 shell
berth provider env 12 --env DEEPSEEK_API_KEY=token >> ~/.bashrc.d/berth-providers.sh
berth provider env 12 --dotenv > .env                    # NAME=value 格式
```

文件里只有代理地址和令牌，没有真 Key；令牌只能访问本机代理。`berth provider token --rotate`
后需要重新生成。`env` 不启动代理，使用这些变量时代理必须在运行（见下一节）。

不想经 `run` / `env` 时，自己取地址和令牌：`berth provider list --json`（每个端点一行，含
`proxyBaseUrl`、`models`）与 `berth provider token`。

## 2. 不在 Berth 里的工具

Cherry Studio、IDE 插件、Chatbox 这类有「Base URL + API Key」设置的工具：在设置页
复制端点的调用地址和令牌，填进去即可。它们需要代理常驻：打开 Berth GUI 时代理自动运行；
不开 GUI 时用 `systemd --user` 常驻 `berth provider proxy`：

```ini
# ~/.config/systemd/user/berth-provider-proxy.service
[Unit]
Description=Berth provider credential proxy

[Service]
ExecStart=/usr/bin/berth-cli provider proxy
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now berth-provider-proxy
```

GUI 启动时若端口已被占用（上面的服务在跑），会直接复用它。

## 3. 外部终端里的 Agent

```sh
berth provider run deepseek --agent claude                          # 与启动栏同一个 launch.js
berth provider run deepseek --agent claude --input expert=dev-expert  # 启动栏的选项用 --input
berth provider run deepseek --agent codex -- codex exec "…"          # 跳过 launch.js，直接跑命令
```

`--agent <工具 id>`（`berth tools list` 可查）套用该 Agent `tool.json` 的 `providerInjection`，
与在 Berth 里启动同一份声明，但一律经代理。不写 `-- 命令` 时在当前终端运行该 Agent 的
`launch.js`，专家、MCP、插件与启动栏一致；写了命令则只设环境变量与启动参数。

## 不带 Key 的服务

本地 Ollama、LM Studio、vLLM 或内网自建服务可以不填 Key。代理照常转发，但不带任何凭据：
放令牌的请求头整条去掉、令牌参数删除。`run` 会在 stderr 提示「没有 Key」。

## 不支持的场景

| 场景 | 原因 | 怎么办 |
|---|---|---|
| 签名类鉴权：AWS Bedrock（SigV4）、腾讯云 TC3、百度千帆旧版 AK/SK、Vertex AI 服务账号 | Key 参与整个请求的签名，代理没法原位换 | 用这些平台的 OpenAI 兼容接口 + API Key |
| 浏览器里直接发请求的网页工具 | 代理拒绝带 `Origin` 的请求，防止网页冒用令牌 | 用工具的后端或桌面版 |
| 订阅登录（ChatGPT、Claude Pro 等） | 不是 Key，走设置页的登录卡片 | 在 Berth 里启动对应 Agent |
| Key 写在 JSON 请求体里 | 改请求体超出「只换令牌」的底线 | 这类接口基本都同时支持请求头 |
| WebSocket（OpenAI Realtime、Gemini Live 等） | 代理暂不支持 | 暂时直连 |
| 超过 64MB 的上传（Files / Batch、大视频） | 代理先整体读入请求体 | 暂时直连 |
| Docker 容器、WSL、局域网其他设备 | 代理只监听并只接受 127.0.0.1 | 暂不支持 |
| 不能填 Base URL 的工具 | 地址写死在工具里 | 无 |

## 代理与令牌

- 代理没在运行时，`berth provider run` 在自己进程里临时起一个，子进程退出即结束。
- `berth provider token --rotate` 更换令牌，旧令牌立即失效。
- Key 只能经设置页或 `printf %s "$KEY" | berth provider set-key <id>` 写入。
- 备份：`berth provider export > providers.json`（不含 Key），设置页「从文件导入」恢复。
