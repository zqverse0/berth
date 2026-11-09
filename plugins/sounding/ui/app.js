// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 「会话分析」页面：填问题、选模型、选会话分析、看结果。后端在 api.js（scripts.run）。

const API = "ui/api.js"

const TYPES = [
  ["boolean", "是 / 否"],
  ["numeric", "数字"],
  ["string", "文本"],
  ["labels", "单选"],
  ["multilabels", "多选"],
  ["findings", "多条结果"],
  ["grep", "关键词"],
  ["judge", "逐条判断"],
]
const UNITS = [
  ["user", "每条用户消息"],
  ["action", "每个工具调用"],
]

/** 页面的全部状态。 */
const model = {
  /** @type {any} */ state: null,
  /** @type {string | null} */ error: null,
  /** @type {string | null} */ selected: null,
  /** @type {Record<string, string>} 正在分析的会话 → "running" 或错误信息 */ scans:
    {},
}

const app = /** @type {HTMLElement} */ (document.getElementById("app"))
/** @param {any} input */
const call = (input) => berth.scripts.run(API, input)

await berth.ready
render()
await load()
// 宿主切走侧栏视图时 iframe 只隐藏不卸载：重新可见时重读。
new IntersectionObserver(([entry]) => {
  if (entry.isIntersecting) void load()
}).observe(document.documentElement)

async function load() {
  try {
    model.state = await call({ action: "state" })
    model.error = null
  } catch (error) {
    model.error = String(error)
  }
  render()
}

let saveTimer = 0
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    call({ action: "saveConfig", config: model.state.config }).catch((error) =>
      berth.ui.notify(`保存失败：${error}`, "error")
    )
  }, 400)
}

/** @param {{ id: string, agent: string }} session */
async function scan(session) {
  model.scans[session.id] = "running"
  model.selected = session.id
  render()
  try {
    model.state.results[session.id] = await call({
      action: "scan",
      sessionId: session.id,
      agent: session.agent,
    })
    delete model.scans[session.id]
  } catch (error) {
    model.scans[session.id] = String(error)
  }
  render()
}

// ---- 渲染 ----

function render() {
  const { state } = model
  if (model.error) {
    app.innerHTML = `<p class="error">${esc(model.error)}</p><button data-act="reload">重试</button>`
  } else if (!state) {
    app.innerHTML = `<p class="muted">加载中…</p>`
  } else if (!state.project) {
    app.innerHTML = `<p class="muted">打开一个项目后，可以分析它的 Agent 会话。</p>`
  } else {
    app.innerHTML = [
      state.installed
        ? ""
        : `<p class="banner">没有安装 sounding：在 设置 → 工具 → Sounding 里安装后再分析。</p>`,
      modelSection(state),
      questionsSection(state.config.questions),
      sessionsSection(state),
    ].join("")
  }
}

/** @param {any} state */
function modelSection(state) {
  const provider = state.providers.find(
    (/** @type {any} */ p) => p.id === state.config.provider
  )
  const providerOptions = state.providers
    .map(
      (/** @type {any} */ p) =>
        `<option value="${p.id}" ${p.id === state.config.provider ? "selected" : ""}>${esc(p.name)}${p.hasKey ? "" : "（无 Key）"}</option>`
    )
    .join("")
  const modelOptions = (provider?.models ?? [])
    .map(
      (/** @type {string} */ m) =>
        `<option ${m === state.config.model ? "selected" : ""}>${esc(m)}</option>`
    )
    .join("")
  const jevOptions = state.jevProviders
    .map(
      (/** @type {any} */ p) =>
        `<option value="${p.id}" ${p.id === state.config.jevProvider ? "selected" : ""}>${esc(p.name)}${p.hasKey ? "" : "（无 Key）"}</option>`
    )
    .join("")
  return `<h2>模型</h2>
    <div class="row">
      <select class="grow" data-field="provider"><option value="">选服务商</option>${providerOptions}</select>
      <select class="grow" data-field="model">${modelOptions}</select>
    </div>
    <div class="row" title="「逐条判断」用的决策模型">
      <span class="muted">逐条判断</span>
      <select class="grow" data-field="jevProvider"><option value="">${state.jevProviders.length ? "选 Jev 服务商" : "没有 Jev 服务商"}</option>${jevOptions}</select>
    </div>`
}

/** @param {any[]} questions */
function questionsSection(questions) {
  const cards = questions
    .map((q, index) => questionCard(q, index, questions))
    .join("")
  return `<h2>问题 <span class="muted">${questions.length}</span><span class="spacer"></span>
      <button data-act="add">添加</button></h2>
    ${cards || `<p class="muted">还没有问题。添加一个，比如「用户是否纠正了 Agent 的做法？」</p>`}`
}

/**
 * @param {any} q
 * @param {number} index
 * @param {any[]} questions
 */
function questionCard(q, index, questions) {
  const types = TYPES.map(
    ([v, l]) =>
      `<option value="${v}" ${q.type === v ? "selected" : ""}>${l}</option>`
  ).join("")
  const area = (/** @type {string} */ key, /** @type {string} */ placeholder) =>
    `<textarea data-q="${index}" data-key="${key}" placeholder="${placeholder}">${esc(q[key] ?? "")}</textarea>`
  const check = (/** @type {string} */ key, /** @type {string} */ text) =>
    `<label class="check"><input type="checkbox" data-q="${index}" data-key="${key}" ${q[key] ? "checked" : ""}>${text}</label>`
  const select = (
    /** @type {string} */ key,
    /** @type {string[][]} */ options,
    /** @type {string} */ value
  ) =>
    `<select data-q="${index}" data-key="${key}">${options
      .map(
        ([v, l]) =>
          `<option value="${esc(v)}" ${value === v ? "selected" : ""}>${esc(l)}</option>`
      )
      .join("")}</select>`
  // 整体问题可以把一个逐条判断的命中当作重点交给模型核对
  const judges = questions.filter(
    (other) => other.type === "judge" && other !== q
  )
  const focus = judges.length
    ? `<label class="check">重点参考 ${select("focus", [["", "不用"], ...judges.map((j) => [j.id, j.question || "（未填写的逐条判断）"])], q.focus ?? "")}</label>`
    : ""
  const body =
    q.type === "grep"
      ? area("patterns", "每行一个关键词") + check("regex", "按正则表达式匹配")
      : q.type === "judge"
        ? `<div class="row">判断对象 ${select("unit", UNITS, q.unit ?? "user")}</div>` +
          area("question", "对每一条要问的，如「是否在纠正 Agent？」") +
          area("trueWhen", "什么情况算「是」") +
          area("falseWhen", "什么情况算「否」")
        : area("question", "要问的问题") +
          (q.type === "labels" || q.type === "multilabels"
            ? area("labels", "每行一个选项")
            : "") +
          (q.type === "multilabels" ? check("allowNone", "允许都不选") : "") +
          (q.type === "findings"
            ? area("fields", "每行一个字段：名称: 说明，如 title: 一句话概括")
            : "") +
          check("excludeTools", "不看工具调用和输出（省 token）") +
          focus
  return `<div class="card">
      <div class="row"><select data-q="${index}" data-key="type">${types}</select><span class="grow"></span>
        <button data-act="remove" data-q="${index}" title="删除">删除</button></div>
      ${body}
    </div>`
}

/** @param {any} state */
function sessionsSection(state) {
  const rows = state.sessions
    .map((/** @type {any} */ s) => {
      const status = model.scans[s.id]
      const done = state.results[s.id]
      const action =
        status === "running"
          ? `<span class="muted">分析中…</span>`
          : `<button data-act="scan" data-id="${esc(s.id)}" ${state.installed ? "" : "disabled"}>${done ? "重新分析" : "分析"}</button>`
      return `<div class="session ${model.selected === s.id ? "selected" : ""}">
          <div class="row"><div class="grow title" data-act="select" data-id="${esc(s.id)}" title="${esc(s.title ?? "")}">${esc(s.title || s.id)}</div>${action}</div>
          <div class="muted">${esc(s.agent)} · ${time(s.updatedAt)}${s.live ? " · 在跑" : ""}${done ? " · 已分析" : ""}</div>
          ${status && status !== "running" ? `<div class="error">${esc(status)}</div>` : ""}
        </div>${model.selected === s.id ? resultSection() : ""}`
    })
    .join("")
  return `<h2>会话<span class="spacer"></span><button data-act="reload">刷新</button></h2>${rows || `<p class="muted">这个项目还没有 Agent 会话。</p>`}`
}

function resultSection() {
  const record = model.selected ? model.state.results[model.selected] : null
  if (!record) return ""
  const questions = new Map(
    record.questions.map((/** @type {any} */ q) => [q.id, q])
  )
  const items = record.output.results
    .map((/** @type {any} */ r) => {
      const q = questions.get(r.id) ?? {}
      const heading = esc(
        q.type === "grep"
          ? `关键词：${(q.patterns ?? "").split("\n").join("、")}`
          : (q.question ?? r.id)
      )
      return `<div class="card"><div class="muted">${heading}</div>${r.error ? `<div class="error">${esc(r.error)}</div>` : answer(q, r.result)}</div>`
    })
    .join("")
  // 展开在所选会话下方，不用滚到列表末尾找。
  return `<div class="result"><div class="muted">分析于 ${time(Date.parse(record.at))} · ${esc(record.output.model ?? "")}</div>${items}</div>`
}

/**
 * @param {any} q
 * @param {any} result
 */
function answer(q, result) {
  if (q.type === "judge") return judged(result)
  const cites = (/** @type {any} */ r) =>
    (r.references ?? [])
      .map(
        (/** @type {any} */ ref) => `<span class="cite">${esc(ref.cite)}</span>`
      )
      .join("")
  const explanation = (/** @type {any} */ r) =>
    r.explanation
      ? `<div class="explanation muted">${esc(r.explanation)}</div>`
      : ""
  if (result.type === "resultset") {
    const list = result.value
      .map(
        (/** @type {any} */ item) =>
          `<li>${esc(Object.values(item.value ?? {}).join(" · "))}${explanation(item)}<div>${cites(item)}</div></li>`
      )
      .join("")
    return list
      ? `<ul class="findings">${list}</ul>`
      : `<div class="answer">没有</div>`
  }
  let value = result.value
  if (q.type === "boolean")
    value = value === true ? "是" : value === false ? "否" : "未能判断"
  else if (q.type === "labels") value = result.answer ?? "未能判断"
  else if (Array.isArray(value))
    value = value.length ? value.join("、") : "都不是"
  else if (q.type === "grep") value = `${value} 处`
  else if (value == null) value = "未能判断"
  return `<div class="answer">${esc(String(value))}</div>${explanation(result)}<div>${cites(result)}</div>`
}

/** 逐条判断：会话结论 + 命中的位置（概率从高到低）。 */
function judged(/** @type {any} */ result) {
  const list = result.hits
    .map(
      (/** @type {any} */ hit) =>
        `<li><span class="cite">${hit.p.toFixed(2)}</span>${esc(hit.text.split(/\s+/).join(" ").slice(0, 120))}</li>`
    )
    .join("")
  const summary = `${result.value ? "是" : "否"}<span class="muted"> · 判断了 ${result.checked} 条，${result.hits.length} 条 ≥ ${result.threshold}</span>`
  return `<div class="answer">${summary}</div>${list ? `<ul class="findings">${list}</ul>` : ""}`
}

// ---- 事件 ----

app.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target).closest("[data-act]")
  if (!(target instanceof HTMLElement)) return
  const { act, q, id } = target.dataset
  const questions = model.state?.config.questions
  if (act === "reload") load()
  else if (act === "add") {
    questions.push({
      id: `q${Date.now().toString(36)}`,
      type: "boolean",
      question: "",
    })
    save()
    render()
  } else if (act === "remove") {
    questions.splice(Number(q), 1)
    save()
    render()
  } else if (act === "scan") {
    const session = model.state.sessions.find(
      (/** @type {any} */ s) => s.id === id
    )
    if (session) scan(session)
  } else if (act === "select") {
    model.selected = model.selected === id ? null : (id ?? null)
    render()
  }
})

app.addEventListener("input", (event) => {
  const target = /** @type {HTMLInputElement} */ (event.target)
  const { q, key, field } = target.dataset
  const config = model.state?.config
  if (!config) return
  if (field === "provider") {
    config.provider = target.value === "" ? null : Number(target.value)
    const provider = model.state.providers.find(
      (/** @type {any} */ p) => p.id === config.provider
    )
    config.model = provider?.models[0] ?? null
    save()
    render()
  } else if (field === "jevProvider") {
    config.jevProvider = target.value === "" ? null : Number(target.value)
    save()
  } else if (field === "model") {
    config.model = target.value
    save()
  } else if (q !== undefined && key) {
    const question = config.questions[Number(q)]
    question[key] = target.type === "checkbox" ? target.checked : target.value
    save()
    // 改类型会换掉表单项，要重画；文字输入不重画，免得丢焦点（「重点参考」里逐条判断的问题文字下次重画时更新）。
    if (key === "type") render()
  }
})

// ---- 工具 ----

/** @param {string} text */
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** @param {number} ms */
function time(ms) {
  if (!Number.isFinite(ms)) return ""
  const date = new Date(ms)
  const pad = (/** @type {number} */ v) => String(v).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
