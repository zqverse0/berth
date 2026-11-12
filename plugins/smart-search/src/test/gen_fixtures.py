"""对着上游 smartsearch（提交 41886ed）生成行为对照样本：原始 HTTP 响应 + Python 输出。

只在开发时跑（不随插件发布）：
    ~/smartsearch/.venv/bin/python plugins/smart-search/src/test/gen_fixtures.py ~/smartsearch

写到同目录 fixtures/*.json；JS 测试（*.test.mjs）用假 http 回放同样的响应并比对输出。
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures"

# 不读用户真实配置：配置目录指向临时目录，key 全走环境变量
os.environ["SMART_SEARCH_CONFIG_DIR"] = tempfile.mkdtemp()
os.environ["SMART_SEARCH_RETRY_MAX_ATTEMPTS"] = "1"
sys.path.insert(0, str(Path(sys.argv[1]).expanduser() / "src"))

import httpx  # noqa: E402

from smart_search import service  # noqa: E402
from smart_search.providers.openai_compatible import OpenAICompatibleSearchProvider  # noqa: E402
from smart_search.providers.xai_responses import XAIResponsesSearchProvider  # noqa: E402
from smart_search.sources import split_answer_and_sources  # noqa: E402

KEYS = [
    "XAI_API_KEY", "XAI_API_URL", "OPENAI_COMPATIBLE_API_URL", "OPENAI_COMPATIBLE_API_KEY",
    "EXA_API_KEY", "ZHIPU_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "CONTEXT7_API_KEY",
]


def configure(env: dict[str, str]) -> None:
    for key in KEYS:
        os.environ.pop(key, None)
    os.environ.update(env)


# 所有 httpx.AsyncClient 都换成按 "METHOD url"（不含查询串）回放的假传输
RESPONSES: dict[str, dict] = {}
_original_init = httpx.AsyncClient.__init__


def _handler(request: httpx.Request) -> httpx.Response:
    key = f"{request.method} {request.url.copy_with(query=None)}"
    reply = RESPONSES.get(key)
    if reply is None:
        raise httpx.ConnectError(f"no fixture for {key}")
    if reply.get("timeout"):
        raise httpx.ReadTimeout("timed out")
    return httpx.Response(reply["status"], text=reply["body"], headers=reply.get("headers", {}))


def _patched_init(self, *args, **kwargs):
    kwargs["transport"] = httpx.MockTransport(_handler)
    _original_init(self, *args, **kwargs)


httpx.AsyncClient.__init__ = _patched_init


def body(value) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def run(coro):
    return asyncio.run(coro)


def http_case(name: str, env: dict, responses: dict, call, input_: dict) -> dict:
    configure(env)
    RESPONSES.clear()
    RESPONSES.update({key: {**reply, "body": body(reply.get("body", ""))} for key, reply in responses.items()})
    return {"name": name, "env": env, "input": input_, "responses": RESPONSES.copy(), "output": run(call())}


XAI = {"XAI_API_KEY": "xk", "XAI_API_URL": "https://x.test/v1"}
OPENAI = {"OPENAI_COMPATIBLE_API_URL": "https://o.test/v1", "OPENAI_COMPATIBLE_API_KEY": "ok"}
TAVILY = {"TAVILY_API_KEY": "tk"}
ZHIPU = {"ZHIPU_API_KEY": "zk"}
FIRECRAWL = {"FIRECRAWL_API_KEY": "fk"}
EXA = {"EXA_API_KEY": "ek"}

XAI_REPLY = {
    "output": [
        {"type": "web_search_call"},
        {
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": "Tauri 2.0 stable was released on 2024-10-02.",
                    "annotations": [
                        {"type": "url_citation", "url": "https://v2.tauri.app/blog/tauri-20/", "title": "Tauri 2.0 Stable Release"},
                        {"type": "url_citation", "url": "https://github.com/tauri-apps/tauri/releases"},
                        {"type": "url_citation", "url": "https://v2.tauri.app/blog/tauri-20/"},
                    ],
                }
            ],
        },
    ]
}
OPENAI_REPLY = {
    "choices": [{"message": {"content": "答案正文。\n\n## 参考资料\n- [官方公告](https://example.cn/a)\n- https://example.cn/b"}}],
    "citations": ["https://example.cn/c", {"url": "https://example.cn/d", "title": "D"}],
}
ZHIPU_REPLY = {
    "search_result": [
        {"title": "新闻一", "link": "https://news.cn/1", "content": "摘要一", "media": "新华网", "publish_date": "2026-11-10"},
        {"title": "新闻二", "link": "https://news.cn/2", "content": "摘要二"},
    ],
    "search_intent": [{"query": "今天 新闻"}],
    "request_id": "r1",
}
TAVILY_SEARCH = {"results": [{"title": "T1", "url": "https://t.test/1", "content": "tc1", "score": 0.9}, {"title": "T2", "url": "https://v2.tauri.app/blog/tauri-20/", "content": "dup"}]}
FIRECRAWL_SEARCH = {"data": {"web": [{"title": "F1", "url": "https://f.test/1", "description": "fd1"}]}}


def search_cases() -> list[dict]:
    cases = []
    cases.append(http_case(
        "xai-with-extra-sources",
        {**XAI, **TAVILY, **FIRECRAWL},
        {
            "POST https://x.test/v1/responses": {"status": 200, "body": XAI_REPLY},
            "POST https://api.tavily.com/search": {"status": 200, "body": TAVILY_SEARCH},
            "POST https://api.firecrawl.dev/v2/search": {"status": 200, "body": FIRECRAWL_SEARCH},
        },
        lambda: service.search("Tauri 2.0 发布时间", extra_sources=3),
        {"query": "Tauri 2.0 发布时间", "extraSources": 3},
    ))
    cases.append(http_case(
        "xai-fails-openai-fallback-zh-current",
        {**XAI, **OPENAI, **ZHIPU, **TAVILY},
        {
            "POST https://x.test/v1/responses": {"status": 500, "body": "upstream down"},
            "POST https://o.test/v1/chat/completions": {"status": 200, "body": OPENAI_REPLY},
            "POST https://open.bigmodel.cn/api/paas/v4/web_search": {"status": 200, "body": ZHIPU_REPLY},
        },
        lambda: service.search("今天的国内新闻"),
        {"query": "今天的国内新闻"},
    ))
    cases.append(http_case(
        "openai-sse-docs-intent",
        {**OPENAI, **TAVILY, **EXA},
        {
            "POST https://o.test/v1/chat/completions": {
                "status": 200,
                "body": 'data: {"choices":[{"delta":{"content":"Use "}}]}\n\ndata: {"choices":[{"delta":{"content":"hooks."}}]}\n\ndata: [DONE]\n',
            },
            "GET https://context7.com/api/v2/search": {"status": 200, "body": {"results": [{"id": "/facebook/react", "title": "React", "description": "UI", "trustScore": 9}]}},
        },
        lambda: service.search("react hooks docs"),
        {"query": "react hooks docs"},
    ))
    cases.append(http_case(
        "all-main-providers-fail",
        {**XAI, **OPENAI, **TAVILY},
        {
            "POST https://x.test/v1/responses": {"status": 401, "body": "bad key"},
            "POST https://o.test/v1/chat/completions": {"status": 200, "body": {"choices": [{"message": {"content": ""}}]}},
        },
        lambda: service.search("anything"),
        {"query": "anything"},
    ))
    cases.append(http_case(
        "minimum-profile-missing",
        {**XAI},
        {},
        lambda: service.search("anything"),
        {"query": "anything"},
    ))
    return cases


def provider_cases() -> list[dict]:
    cases = []
    cases.append(http_case(
        "zhipu-ok", ZHIPU,
        {"POST https://open.bigmodel.cn/api/paas/v4/web_search": {"status": 200, "body": ZHIPU_REPLY}},
        lambda: service.zhipu_search("今天 新闻", count=5),
        {"fn": "zhipu", "query": "今天 新闻", "count": 5},
    ))
    cases.append(http_case(
        "zhipu-rate-limited", ZHIPU,
        {"POST https://open.bigmodel.cn/api/paas/v4/web_search": {"status": 429, "body": "slow down"}},
        lambda: service.zhipu_search("x"),
        {"fn": "zhipu", "query": "x"},
    ))
    cases.append(http_case(
        "zhipu-not-configured", {}, {},
        lambda: service.zhipu_search("x"),
        {"fn": "zhipu", "query": "x"},
    ))
    exa_reply = {"results": [{"id": "https://p.test/1", "title": "Paper", "url": "https://p.test/1", "publishedDate": "2025-01-01", "author": "A", "score": 0.5, "highlights": ["h"], "favicon": "f.ico"}]}
    cases.append(http_case(
        "exa-ok", EXA,
        {"POST https://api.exa.ai/search": {"status": 200, "body": exa_reply}},
        lambda: service.exa_search("paper", num_results=3, include_highlights=True, include_domains="a.com, b.com"),
        {"fn": "exa", "query": "paper", "numResults": 3, "highlights": True, "includeDomains": "a.com, b.com"},
    ))
    cases.append(http_case(
        "exa-parameter-error", EXA,
        {"POST https://api.exa.ai/search": {"status": 422, "body": "bad category"}},
        lambda: service.exa_search("paper"),
        {"fn": "exa", "query": "paper"},
    ))
    cases.append(http_case(
        "context7-library", {},
        {"GET https://context7.com/api/v2/search": {"status": 200, "body": [{"id": "/vercel/next.js", "title": "Next.js", "stars": 1}]}},
        lambda: service.context7_library("next.js", "routing"),
        {"fn": "c7-library", "name": "next.js", "query": "routing"},
    ))
    cases.append(http_case(
        "context7-docs-text", {},
        {"GET https://context7.com/api/v2/context": {"status": 200, "body": "plain docs", "headers": {"content-type": "text/plain"}}},
        lambda: service.context7_docs("/vercel/next.js", "routing"),
        {"fn": "c7-docs", "libraryId": "/vercel/next.js", "query": "routing"},
    ))
    cases.append(http_case(
        "context7-docs-json", {},
        {"GET https://context7.com/api/v2/context": {"status": 200, "body": {"codeSnippets": [{"c": 1}], "infoSnippets": [{"i": 1}]}, "headers": {"content-type": "application/json"}}},
        lambda: service.context7_docs("/vercel/next.js", "routing"),
        {"fn": "c7-docs", "libraryId": "/vercel/next.js", "query": "routing"},
    ))
    cases.append(http_case(
        "fetch-tavily-empty-firecrawl-ok", {**TAVILY, **FIRECRAWL},
        {
            "POST https://api.tavily.com/extract": {"status": 200, "body": {"results": [{"raw_content": "  "}]}},
            "POST https://api.firecrawl.dev/v2/scrape": {"status": 200, "body": {"data": {"markdown": "# Page\n\nbody"}}},
        },
        lambda: service.fetch("https://page.test/a"),
        {"fn": "fetch", "url": "https://page.test/a"},
    ))
    cases.append(http_case(
        "fetch-not-configured", {}, {},
        lambda: service.fetch("https://page.test/a"),
        {"fn": "fetch", "url": "https://page.test/a"},
    ))
    return cases


def parse_cases() -> list[dict]:
    """服务商响应解析（不经路由）。"""
    cases = []
    openai = OpenAICompatibleSearchProvider("https://o.test/v1", "k")
    xai = XAIResponsesSearchProvider("https://x.test/v1", "k")
    for name, provider, method, reply in [
        ("openai-json-citations", openai, "_parse_completion_response", OPENAI_REPLY),
        ("openai-sse-fallback", openai, "_parse_completion_response", 'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: [DONE]'),
        ("openai-message-citations", openai, "_parse_completion_response", {"choices": [{"message": {"content": "x", "citations": [{"href": "https://h.test", "name": "H"}, "not-a-url"]}}]}),
        ("xai-annotations", xai, "_parse_response", XAI_REPLY),
    ]:
        text = body(reply)
        output = run(getattr(provider, method)(httpx.Response(200, text=text)))
        cases.append({"name": name, "provider": "openai" if provider is openai else "xai", "body": text, "output": output})
    return cases


SPLIT_TEXTS = {
    "plain": "Just an answer with no links.",
    "function-call-json": 'Answer body.\n\nsources([{"url": "https://a.test", "title": "A"}, {"url": "https://b.test"}])',
    "function-call-python": "Answer.\nsources([('Title A', 'https://a.test'), {'url': 'https://b.test', 'snippet': 's', 'ok': True}])",
    "heading-zh": "正文第一段。\n\n### 参考资料\n1. [官网](https://a.test/x)\n2. https://b.test/y。",
    "heading-bold": "Body.\n\n**Sources:**\n- [A](https://a.test)\n- [B](https://b.test)",
    "details": "Body.\n<details><summary>Sources</summary>\n[A](https://a.test)\n[B](https://b.test)\n</details>",
    "tail-links": "Body text.\n\n- https://a.test\n- [B](https://b.test)",
    "single-tail-link": "Body.\nhttps://only.test",
    "inline-citations": "Fact one [[1]](https://a.test). Fact two [[2]](https://b.test).",
    "think-and-policy": "<think>hidden</think>I cannot comply with that policy request.\n\nReal answer here.\n\nsources([\"https://a.test\"])",
    "policy-only": "抱歉，我无法提供该信息。",
    "url-punctuation": "See https://a.test/path, and https://b.test/x）。\n\nReferences\nhttps://a.test/path\nhttps://c.test",
}


def split_cases() -> list[dict]:
    out = []
    for name, text in SPLIT_TEXTS.items():
        answer, sources = split_answer_and_sources(text)
        out.append({"name": name, "text": text, "answer": answer, "sources": sources})
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, cases in [
        ("split", split_cases()),
        ("parse", parse_cases()),
        ("providers", provider_cases()),
        ("search", search_cases()),
    ]:
        (OUT / f"{name}.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{name}: {len(cases)} cases")


if __name__ == "__main__":
    main()
