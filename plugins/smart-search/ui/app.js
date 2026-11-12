// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// smart-search 侧栏：搜索 / 记录 / 配置三个标签。逻辑都在包内脚本（private/*.js，scripts.run），
// 页面只负责展示与转交：结果交给 Agent、打开网页、抓全文、存到知识库「来源」。

const TEXT = {
  "zh-CN": {
    tabs: { search: "搜索", records: "记录", config: "配置" },
    placeholder: "问题，或粘贴网址直接抓取正文",
    modes: { all: "综合", zhipu: "中文（智谱）", exa: "可信源（Exa）", c7: "文档（Context7）" },
    search: "搜索",
    cancel: "取消",
    waiting: (/** @type {number} */ s) => `已等待 ${s} 秒`,
    answer: "AI 回答",
    answerPending: "AI 回答生成中…",
    answerFailed: "AI 回答不可用：",
    sources: "来源",
    noResults: "没有结果。",
    existing: "之前搜过：",
    toAgent: "交给 Agent",
    open: "打开网页",
    fetch: "抓全文",
    save: "存到来源",
    saved: "已存",
    fetching: "抓取中…",
    goConfig: "去配置",
    thisProject: "当前项目",
    allProjects: "全部",
    user: "我",
    back: "← 返回",
    remove: "删除",
    pages: "抓取的正文",
    noRecords: "还没有记录。",
    import: "导入旧配置",
    test: "测连通",
    imported: (/** @type {number} */ n) => `已导入 ${n} 项`,
    keyHint: "只写不读：留空不改",
    clear: "清除",
    setValue: "保存",
    groups: {
      ai: "AI 搜索",
      sources: "来源搜索",
      fetch: "网页抓取",
      general: "通用",
    },
    noProject: "不在项目里，无法存到来源。",
  },
  en: {
    tabs: { search: "Search", records: "Records", config: "Settings" },
    placeholder: "Question, or paste a URL to fetch the page",
    modes: { all: "All", zhipu: "Chinese (Zhipu)", exa: "Trusted (Exa)", c7: "Docs (Context7)" },
    search: "Search",
    cancel: "Cancel",
    waiting: (/** @type {number} */ s) => `Waiting ${s}s`,
    answer: "AI answer",
    answerPending: "AI answer on its way…",
    answerFailed: "AI answer unavailable: ",
    sources: "Sources",
    noResults: "No results.",
    existing: "Asked before:",
    toAgent: "Send to Agent",
    open: "Open",
    fetch: "Full text",
    save: "Save to sources",
    saved: "Saved",
    fetching: "Fetching…",
    goConfig: "Settings",
    thisProject: "This project",
    allProjects: "All",
    user: "me",
    back: "← Back",
    remove: "Delete",
    pages: "Fetched pages",
    noRecords: "No records yet.",
    import: "Import old config",
    test: "Test connections",
    imported: (/** @type {number} */ n) => `Imported ${n} keys`,
    keyHint: "Write-only: leave empty to keep",
    clear: "Clear",
    setValue: "Save",
    groups: {
      ai: "AI search",
      sources: "Source search",
      fetch: "Page fetching",
      general: "General",
    },
    noProject: "Not inside a project; cannot save sources.",
  },
}

/** 配置页分组：键 → 显示名。 */
const GROUPS = {
  ai: ["XAI_API_KEY", "XAI_API_URL", "XAI_MODEL", "XAI_TOOLS", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_API_URL", "OPENAI_COMPATIBLE_MODEL", "OPENAI_COMPATIBLE_STREAM", "AI_TIMEOUT_SECONDS"],
  sources: ["ZHIPU_API_KEY", "ZHIPU_API_URL", "ZHIPU_SEARCH_ENGINE", "ZHIPU_TIMEOUT_SECONDS", "EXA_API_KEY", "EXA_BASE_URL", "EXA_TIMEOUT_SECONDS", "CONTEXT7_API_KEY", "CONTEXT7_BASE_URL", "CONTEXT7_TIMEOUT_SECONDS"],
  fetch: ["TAVILY_API_KEY", "TAVILY_API_URL", "TAVILY_ENABLED", "TAVILY_TIMEOUT_SECONDS", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"],
  general: ["SMART_SEARCH_VALIDATION_LEVEL", "SMART_SEARCH_FALLBACK_MODE", "SMART_SEARCH_MINIMUM_PROFILE", "SMART_SEARCH_RETRY_MAX_ATTEMPTS", "SMART_SEARCH_RETRY_MAX_WAIT", "RECORDS_RETENTION_DAYS"],
}

await berth.ready
const t = berth.ui.locale.startsWith("zh") ? TEXT["zh-CN"] : TEXT.en

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node | string | null | false | undefined)[]} [children]
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value)
    else if (key === "value") /** @type {any} */ (el).value = value
    else if (value === true) el.setAttribute(key, "")
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  for (const child of children) if (child) el.append(child)
  return el
}

/** @param {string} script @param {any} input @param {AbortSignal} [signal] */
const run = (script, input, signal) => berth.scripts.run(`private/${script}.js`, input, { signal })
const errorText = (/** @type {any} */ error) => String(error?.message ?? error)
const isUrl = (/** @type {string} */ text) => /^https?:\/\/\S+$/.test(text.trim())

/** 页面状态，按标签分块。 */
const model = {
  tab: /** @type {"search" | "records" | "config"} */ ("search"),
  search: {
    mode: "all",
    query: "",
    /** @type {AbortController | null} */ abort: null,
    startedAt: 0,
    /** @type {any} */ sources: null,
    /** @type {any} */ answer: null,
    /** @type {any} */ page: null,
    /** @type {string | null} */ error: null,
    /** @type {string | null} */ errorType: null,
    /** @type {any[]} */ existing: [],
    /** @type {string | null} */ record: null,
  },
  /** 每个网址的状态：已存路径、抓到的正文、进行中。 */
  urls: /** @type {Record<string, { path?: string, content?: string, busy?: boolean, error?: string }>} */ ({}),
  records: {
    all: false,
    /** @type {any[] | null} */ list: null,
    /** @type {any} */ open: null,
    /** @type {string | null} */ error: null,
  },
  config: {
    /** @type {any} */ values: null,
    /** @type {any} */ tests: null,
    /** @type {string | null} */ note: null,
    busy: false,
  },
}

const tabs = /** @type {HTMLElement} */ (document.getElementById("tabs"))
const app = /** @type {HTMLElement} */ (document.getElementById("app"))

function render() {
  tabs.replaceChildren(
    ...(/** @type {const} */ (["search", "records", "config"])).map((tab) =>
      h("button", { "aria-selected": String(model.tab === tab), onclick: () => switchTab(tab) }, [t.tabs[tab]])
    )
  )
  const body = model.tab === "search" ? renderSearch() : model.tab === "records" ? renderRecords() : renderConfig()
  app.replaceChildren(...body.filter(Boolean))
}

/** @param {"search" | "records" | "config"} tab */
function switchTab(tab) {
  model.tab = tab
  if (tab === "records") loadRecords()
  if (tab === "config" && !model.config.values) loadConfig()
  render()
}

// ───────────── 搜索 ─────────────

// 输入框只建一次：重画时保留光标与输入法状态
const queryBox = /** @type {HTMLTextAreaElement} */ (
  h("textarea", {
    rows: "2",
    placeholder: t.placeholder,
    onkeydown: (/** @type {KeyboardEvent} */ event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        startSearch()
      }
    },
  })
)

function renderSearch() {
  const s = model.search
  const running = !!s.abort
  const form = h("section", {}, [
    queryBox,
    h("div", { class: "row" }, [
      h(
        "select",
        { onchange: (/** @type {Event} */ e) => (s.mode = /** @type {HTMLSelectElement} */ (e.target).value) },
        Object.entries(t.modes).map(([id, label]) => h("option", { value: id, selected: s.mode === id }, [label]))
      ),
      h("span", { class: "grow" }),
      running && h("span", { class: "muted small", id: "waiting" }, [t.waiting(Math.round((Date.now() - s.startedAt) / 1000))]),
      running
        ? h("button", { onclick: cancelSearch }, [t.cancel])
        : h("button", { class: "primary", onclick: startSearch }, [t.search]),
    ]),
  ])
  const out = [form]
  if (s.existing.length)
    out.push(
      h("section", { class: "muted small" }, [
        t.existing,
        ...s.existing.slice(0, 3).flatMap((item) => [" ", h("a", { onclick: () => openRecord(item.id) }, [`${item.query}（${byLabel(item.by)} ${shortTime(item.at)}）`])]),
      ])
    )
  if (s.error)
    out.push(
      h("section", { class: "error" }, [
        s.error,
        s.errorType === "config_error" || s.errorType === "network_error" ? h("div", {}, [h("button", { onclick: () => switchTab("config") }, [t.goConfig])]) : null,
      ])
    )
  if (s.page) out.push(...renderPage(s.page))
  if (s.sources?.libraries?.length)
    out.push(
      h("section", { class: "row small" }, [
        ...s.sources.libraries.map((/** @type {any} */ lib) =>
          h("button", { "aria-pressed": String(lib.id === s.sources.library_id), disabled: running, onclick: () => switchLibrary(lib.id) }, [
            `${lib.id === s.sources.library_id ? "• " : ""}${lib.title} ${lib.id}`,
          ])
        ),
      ])
    )
  if (s.sources?.text)
    out.push(
      h("section", {}, [
        h("div", { class: "row" }, [
          h("strong", { class: "grow" }, [s.sources.library_id]),
          h("button", { class: "small", onclick: () => attach(`${s.sources.library_id} ${s.query}`, s.sources.text) }, [t.toAgent]),
        ]),
        h("div", { class: "answer" }, [s.sources.text]),
      ])
    )
  if (s.answer?.content || (running && s.mode === "all"))
    out.push(
      h("section", {}, [
        h("div", { class: "row" }, [
          h("strong", { class: "grow" }, [t.answer]),
          s.answer?.content && h("button", { class: "small", onclick: () => attach(s.query, s.answer.content) }, [t.toAgent]),
        ]),
        s.answer?.content ? h("div", { class: "answer" }, [s.answer.content]) : h("div", { class: "muted" }, [t.answerPending]),
      ])
    )
  // 来源已出、AI 回答失败：说明原因，不让回答区默默消失
  else if (s.answer?.ok === false && !s.error)
    out.push(
      h("section", { class: "muted small" }, [
        `${t.answerFailed}${s.answer.error}`,
        h("div", {}, [h("button", { onclick: () => switchTab("config") }, [t.goConfig])]),
      ])
    )
  const items = mergedSources()
  if (items.length) out.push(h("section", {}, [h("strong", {}, [t.sources]), renderItems(items, s.query)]))
  else if (!running && (s.sources || s.answer) && !s.error) out.push(h("p", { class: "muted" }, [t.noResults]))
  return out
}

/** AI 回答的来源在前，再接来源列表与补充来源，按网址去重。 */
function mergedSources() {
  const s = model.search
  const seen = new Set()
  const out = []
  for (const list of [s.answer?.primary_sources, s.sources?.primary_sources, s.sources?.results, s.answer?.extra_sources, s.answer?.results])
    for (const item of list ?? []) {
      const url = item.url
      if (!url || seen.has(url) || !/^https?:/.test(url)) continue
      seen.add(url)
      out.push(item)
    }
  return out
}

/** @param {any[]} items @param {string} query */
function renderItems(items, query) {
  return h(
    "ul",
    { class: "items" },
    items.map((item) => {
      const state = model.urls[item.url] ?? {}
      const snippet = item.description || item.snippet || item.content || (item.highlights ?? []).join(" … ")
      return h("li", {}, [
        h("div", { class: "title" }, [h("a", { onclick: () => berth.ui.openUrl(item.url) }, [item.title || item.url])]),
        h("div", { class: "muted small" }, [`${item.provider ?? ""} · ${item.url}`]),
        snippet && h("div", { class: "snippet" }, [snippet]),
        h("div", { class: "row actions" }, [
          h("button", { onclick: () => attach(item.title || item.url, [item.title, item.url, snippet].filter(Boolean).join("\n")) }, [t.toAgent]),
          h("button", { onclick: () => berth.ui.openUrl(item.url) }, [t.open]),
          h("button", { disabled: state.busy, onclick: () => fetchFull(item.url) }, [state.busy && !state.content ? t.fetching : t.fetch]),
          state.path
            ? h("button", { class: "saved", onclick: () => berth.files.open(/** @type {string} */ (state.path)) }, [`✓ ${t.saved}`])
            : h("button", { disabled: state.busy, onclick: () => saveSource(item.url, item.title, query) }, [t.save]),
        ]),
        state.error && h("div", { class: "error small" }, [state.error]),
        state.content && h("div", { class: "page" }, [state.content]),
      ])
    })
  )
}

/** 粘贴网址直接抓取的结果。 @param {any} page */
function renderPage(page) {
  const state = model.urls[page.url] ?? {}
  return [
    h("section", {}, [
      h("div", { class: "row actions" }, [
        h("a", { class: "grow", onclick: () => berth.ui.openUrl(page.url) }, [page.url]),
        h("button", { onclick: () => attach(page.url, `${page.url}\n\n${page.content}`) }, [t.toAgent]),
        state.path
          ? h("button", { class: "saved", onclick: () => berth.files.open(/** @type {string} */ (state.path)) }, [`✓ ${t.saved}`])
          : h("button", { disabled: state.busy, onclick: () => saveSource(page.url, "", "", page.content) }, [t.save]),
      ]),
      state.error && h("div", { class: "error small" }, [state.error]),
      h("div", { class: "page" }, [page.content]),
    ]),
  ]
}

let ticker = 0

async function startSearch() {
  const s = model.search
  const query = queryBox.value.trim()
  if (!query || s.abort) return
  Object.assign(s, { query, sources: null, answer: null, page: null, error: null, errorType: null, existing: [], record: null })
  const abort = new AbortController()
  s.abort = abort
  s.startedAt = Date.now()
  ticker = window.setInterval(() => {
    const el = document.getElementById("waiting")
    if (el) el.textContent = t.waiting(Math.round((Date.now() - s.startedAt) / 1000))
  }, 1000)
  render()
  const settle = (/** @type {(result: any) => void} */ apply) => (/** @type {any} */ result) => {
    if (s.abort !== abort) return
    apply(result)
    if (result?.ok === false && !s.error && !mergedSources().length && !s.page) {
      s.error = result.error
      s.errorType = result.error_type
    }
    if (result?.existing_records?.length) s.existing = result.existing_records
    checkSaved()
    render()
  }
  const failed = (/** @type {any} */ error) => {
    if (s.abort !== abort || error?.reason === "cancelled") return
    s.error = errorText(error)
    render()
  }
  const jobs = []
  if (isUrl(query)) jobs.push(run("fetch", { url: query }, abort.signal).then(settle((r) => r.ok && (s.page = r)), failed))
  else if (s.mode === "all") {
    // 来源列表先到先显示，AI 回答随后补上；记录只写 AI 搜索那一次（含补充来源）
    jobs.push(run("search", { query, mode: "sources", noRecord: true }, abort.signal).then(settle((r) => (s.sources = r)), failed))
    jobs.push(run("search", { query }, abort.signal).then(settle((r) => ((s.answer = r), (s.record = r.record))), failed))
  } else {
    const script = s.mode === "c7" ? "c7" : s.mode
    jobs.push(run(script, { query }, abort.signal).then(settle((r) => ((s.sources = r), (s.record = r.record))), failed))
  }
  await Promise.allSettled(jobs)
  if (s.abort === abort) finishSearch()
}

/** 文档模式换一个库重取。 @param {string} libraryId */
async function switchLibrary(libraryId) {
  const s = model.search
  const libraries = s.sources.libraries
  const abort = new AbortController()
  s.abort = abort
  s.startedAt = Date.now()
  render()
  try {
    const result = await run("c7", { libraryId, query: s.query }, abort.signal)
    if (s.abort === abort) s.sources = { ...result, libraries }
  } catch (error) {
    if (s.abort === abort && error?.reason !== "cancelled") s.error = errorText(error)
  }
  if (s.abort === abort) finishSearch()
}

function cancelSearch() {
  model.search.abort?.abort()
  finishSearch()
}

function finishSearch() {
  model.search.abort = null
  window.clearInterval(ticker)
  render()
}

/** 当前结果里哪些网址已存到来源。 */
async function checkSaved() {
  const urls = [...mergedSources().map((item) => item.url), model.search.page?.url].filter(
    (url) => url && !(url in model.urls)
  )
  if (!urls.length) return
  for (const url of urls) model.urls[url] = {}
  try {
    const saved = await run("save", { action: "check", urls })
    for (const [url, path] of Object.entries(saved)) model.urls[url].path = /** @type {string} */ (path)
    render()
  } catch {
    // 不在项目里等：不显示「已存」即可
  }
}

/** @param {string} url */
async function fetchFull(url) {
  const state = (model.urls[url] ??= {})
  if (state.content) {
    state.content = undefined
    return render()
  }
  state.busy = true
  state.error = undefined
  render()
  try {
    const result = await run("fetch", { url, record: model.search.record ?? undefined })
    if (result.ok) state.content = result.content
    else state.error = result.error
  } catch (error) {
    state.error = errorText(error)
  }
  state.busy = false
  render()
}

/** @param {string} url @param {string} title @param {string} query @param {string} [content] */
async function saveSource(url, title, query, content) {
  const state = (model.urls[url] ??= {})
  state.busy = true
  state.error = undefined
  render()
  try {
    const result = await run("save", { url, title: title || undefined, query: query || undefined, content: content ?? state.content })
    if (result.ok) state.path = result.path
    else state.error = result.error
  } catch (error) {
    state.error = error?.reason === "not-found" ? t.noProject : errorText(error)
  }
  state.busy = false
  render()
}

/** @param {string} label @param {string} text */
async function attach(label, text) {
  try {
    await berth.agent.attach({ label: label.slice(0, 60), text })
  } catch (error) {
    berth.ui.notify(errorText(error), "error")
  }
}

// ───────────── 记录 ─────────────

const modeLabel = (/** @type {string} */ mode) => /** @type {any} */ (t.modes)[{ full: "all", context7: "c7" }[mode] ?? mode] ?? mode
const byLabel = (/** @type {any} */ by) => (!by || by.id === "user" ? t.user : by.expert ? `${by.id}·${by.expert}` : by.id)
const shortTime = (/** @type {string} */ at) => {
  const date = new Date(at)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadRecords() {
  const r = model.records
  try {
    r.list = (await run("history", { action: "list", all: r.all, limit: 100 })).records
    r.error = null
  } catch (error) {
    r.error = errorText(error)
  }
  render()
}

/** @param {string} id */
async function openRecord(id) {
  model.tab = "records"
  try {
    model.records.open = (await run("history", { action: "show", id })).record
    model.records.error = null
  } catch (error) {
    model.records.error = errorText(error)
  }
  render()
}

function renderRecords() {
  const r = model.records
  if (r.open) return renderRecord(r.open)
  const out = [
    h("div", { class: "row" }, [
      h("button", { "aria-pressed": String(!r.all), onclick: () => ((r.all = false), loadRecords()) }, [r.all ? t.thisProject : `• ${t.thisProject}`]),
      h("button", { onclick: () => ((r.all = true), loadRecords()) }, [r.all ? `• ${t.allProjects}` : t.allProjects]),
    ]),
  ]
  if (r.error) out.push(h("p", { class: "error" }, [r.error]))
  if (r.list && !r.list.length) out.push(h("p", { class: "muted" }, [t.noRecords]))
  out.push(
    h(
      "ul",
      { class: "items" },
      (r.list ?? []).map((item) =>
        h("li", { class: "record", onclick: () => openRecord(item.id) }, [
          h("div", {}, [item.query]),
          h("div", { class: "muted small" }, [
            [item.kind === "fetch" ? t.fetch : modeLabel(item.mode), byLabel(item.by), shortTime(item.at), r.all ? item.project?.name : null].filter(Boolean).join(" · "),
          ]),
        ])
      )
    )
  )
  return out
}

/** @param {any} record */
function renderRecord(record) {
  const result = record.result ?? {}
  const sources = [...(result.primary_sources ?? []), ...(result.extra_sources ?? []), ...(result.results ?? [])].filter(
    (item, index, all) => item.url && /^https?:/.test(item.url) && all.findIndex((other) => other.url === item.url) === index
  )
  for (const page of record.pages) (model.urls[page.url] ??= {}).content ??= page.content
  return [
    h("div", { class: "row" }, [
      h("button", { onclick: () => ((model.records.open = null), loadRecords()) }, [t.back]),
      h("span", { class: "grow" }),
      h("button", {
        onclick: async () => {
          await run("history", { action: "remove", id: record.id })
          model.records.open = null
          loadRecords()
        },
      }, [t.remove]),
    ]),
    h("h4", {}, [record.query]),
    h("div", { class: "muted small" }, [[record.kind === "fetch" ? t.fetch : modeLabel(record.mode), byLabel(record.by), shortTime(record.at), record.project?.name].filter(Boolean).join(" · ")]),
    result.ok === false && h("p", { class: "error" }, [result.error]),
    result.content &&
      h("section", {}, [
        h("div", { class: "row" }, [h("strong", { class: "grow" }, [t.answer]), h("button", { class: "small", onclick: () => attach(record.query, result.content) }, [t.toAgent])]),
        h("div", { class: "answer" }, [result.content]),
      ]),
    sources.length && h("section", {}, [h("strong", {}, [t.sources]), renderItems(sources, record.query)]),
    record.pages.length &&
      h("section", {}, [
        h("strong", {}, [t.pages]),
        renderItems(record.pages.filter((/** @type {any} */ page) => !sources.some((item) => item.url === page.url)).map((/** @type {any} */ page) => ({ url: page.url, title: page.url })), record.query),
      ]),
  ]
}

// ───────────── 配置 ─────────────

async function loadConfig() {
  try {
    model.config.values = (await run("config", { action: "get" })).config
  } catch (error) {
    model.config.note = errorText(error)
  }
  render()
}

/** @param {any} input */
async function configAction(input) {
  const c = model.config
  c.busy = true
  render()
  try {
    const result = await run("config", input)
    if (!result.ok) c.note = result.error
    else {
      if (result.config) c.values = result.config
      if (result.providers) c.tests = result.providers
      c.note = result.imported ? t.imported(result.imported.length) : null
    }
  } catch (error) {
    c.note = errorText(error)
  }
  c.busy = false
  render()
}

function renderConfig() {
  const c = model.config
  const out = [
    h("div", { class: "row" }, [
      h("button", { disabled: c.busy, onclick: () => configAction({ action: "import" }) }, [t.import]),
      h("button", { disabled: c.busy, onclick: () => configAction({ action: "test" }) }, [t.test]),
    ]),
  ]
  if (c.note) out.push(h("p", { class: "muted" }, [c.note]))
  if (c.tests)
    out.push(
      h(
        "ul",
        { class: "items" },
        Object.entries(c.tests).map(([name, test]) =>
          h("li", {}, [
            h("span", { class: test.status === "ok" ? "status-ok" : test.status === "not_configured" ? "muted" : "status-bad" }, [`${name}: ${test.status}`]),
            h("div", { class: "muted small" }, [test.message]),
          ])
        )
      )
    )
  if (!c.values) return out
  for (const [group, keys] of Object.entries(GROUPS))
    out.push(h("fieldset", {}, [h("legend", {}, [t.groups[/** @type {keyof typeof t.groups} */ (group)]]), ...keys.map((key) => renderField(key, c.values[key]))]))
  return out
}

/** @param {string} key @param {any} entry */
function renderField(key, entry) {
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      type: entry.secret ? "password" : "text",
      autocomplete: "off",
      placeholder: entry.secret ? (entry.value ? `${entry.value}（${t.keyHint}）` : t.keyHint) : (entry.default ?? ""),
      value: entry.secret ? "" : (entry.value ?? ""),
    })
  )
  const save = () => {
    const value = input.value.trim()
    if (value) configAction({ action: "set", key, value })
  }
  input.addEventListener("keydown", (event) => event.key === "Enter" && save())
  return h("label", { class: "field" }, [
    h("span", { class: "small muted" }, [key]),
    h("div", { class: "row" }, [
      input,
      h("button", { class: "small", disabled: model.config.busy, onclick: save }, [t.setValue]),
      entry.saved && h("button", { class: "small", disabled: model.config.busy, onclick: () => configAction({ action: "unset", key }) }, [t.clear]),
    ]),
  ])
}

render()
