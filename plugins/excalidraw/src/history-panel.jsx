// 侧栏的「改图」面板：用户保存想法并复制给 Agent（可先选中要改的元素），下面是每一版的缩略图时间线，
// 可以和当前对比、回到任意一版。记录与存档在 private/history.js，这里只显示和发请求。
import { useEffect, useRef, useState } from "react"
import { copyText } from "./clipboard.js"
import { hash } from "../private/history.js"

const API = "private/history.js"

const TEXT = {
  "zh-CN": {
    title: "改图",
    close: "收起",
    placeholder: "说说想怎么改……可先选中要改的元素",
    selected: (n) => `已选中 ${n} 个元素，只改它们`,
    copy: "保存要求并复制给 Agent",
    copied: "已复制修改说明，请粘贴给任意 Agent 执行",
    copyFailed: "自动复制失败，请在下方选中完整说明，手动复制给 Agent。",
    preview: "给 Agent 的修改说明",
    draftLabel: "修改要求",
    copyHint: "这里不会自动投递或执行；复制后粘贴给 Agent。",
    pending: "最近保存的要求：",
    empty:
      "还没有记录。保存要求时会存档当前画板，Agent 修改后可在这里对比版本。",
    noProject: "画板不在已打开的项目里，没法记录版本。",
    current: "当前",
    restore: "回到这一版",
    compare: "对比",
    restored: (id) => `已回到 #${id}，之前的版本也存着`,
    by: {
      agent: "Agent 修改",
      before: "改动前",
      restore: (from) => `回到 #${from}`,
      external: "外部改写",
    },
    request: "要求",
    note: "改动",
    now: "当前画板",
    more: (n) => `显示更早的 ${n} 版`,
    ask: (path, text, selection) =>
      `改 Excalidraw 画板 \`${path}\`：先运行 \`berth tools show excalidraw\`，按 skill \`excalidraw-diagram\` 的「按用户意见改图」一节做（新版经 private/history.js apply 写入，旧版会自动存档）。\n用户的要求：${text}` +
      (selection.length
        ? `\n用户选中了这些元素，只改它们（要求里另有说明除外）：\n${selection.map((line) => `- ${line}`).join("\n")}`
        : ""),
  },
  en: {
    title: "Revise",
    close: "Close",
    placeholder:
      "Describe the change… optionally select the elements to revise",
    selected: (n) => `${n} selected elements; only these change`,
    copy: "Save request and copy for agent",
    copied: "Revision instructions copied. Paste them into any agent to run.",
    copyFailed:
      "Automatic copy failed. Select the full instructions below and copy them manually.",
    preview: "Revision instructions for agent",
    draftLabel: "Revision request",
    copyHint:
      "Nothing is delivered or executed automatically. Copy and paste into your agent.",
    pending: "Latest saved request: ",
    empty:
      "No versions yet. Saving a request archives the drawing so agent revisions can be compared here.",
    noProject:
      "This drawing is not in an open project, so versions can't be kept.",
    current: "Current",
    restore: "Restore",
    compare: "Compare",
    restored: (id) => `Restored #${id}; the previous version is kept too`,
    by: {
      agent: "Agent edit",
      before: "Before change",
      restore: (from) => `Back to #${from}`,
      external: "Changed outside",
    },
    request: "Asked",
    note: "Changed",
    now: "Current drawing",
    more: (n) => `Show ${n} older versions`,
    ask: (path, text, selection) =>
      `Revise the Excalidraw drawing \`${path}\`: run \`berth tools show excalidraw\` first and follow the "Revise on request" section of the \`excalidraw-diagram\` skill (write the new version through private/history.js apply so the old one is kept).\nThe user asks: ${text}` +
      (selection.length
        ? `\nThe user selected these elements; change only them unless the request says otherwise:\n${selection.map((line) => `- ${line}`).join("\n")}`
        : ""),
  },
}

const SHOWN = 20

/** 选中元素的简述：id、类型、上面的文字（框内文字取绑定的 text 元素）。 */
export function describeSelection(api) {
  if (!api) return []
  const ids = api.getAppState().selectedElementIds
  const elements = api.getSceneElements()
  const byId = new Map(elements.map((element) => [element.id, element]))
  return elements
    .filter((element) => ids[element.id])
    .map((element) => {
      const text =
        element.type === "text"
          ? element.text
          : element.boundElements
              ?.map((bound) => byId.get(bound.id))
              .find((bound) => bound?.type === "text")?.text
      const label = text ? ` "${text.replace(/\s+/g, " ").trim()}"` : ""
      return `${element.id} (${element.type}${label})`
    })
}

const when = (time) =>
  new Date(time).toLocaleString(berth.ui.locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

function byLabel(version, t) {
  const label = t.by[version.by] ?? version.by
  return typeof label === "function" ? label(version.from) : label
}

/** 进入视口才取内容渲染缩略图，长时间线不一次全取；只在挂载时取一次。 */
export function Thumb({ load, render }) {
  const [src, setSrc] = useState(null)
  const [node, setNode] = useState(null)
  useEffect(() => {
    if (!node) return
    let cancelled = false
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      observer.disconnect()
      void load()
        .then(render)
        .then((url) => !cancelled && setSrc(url))
        .catch(() => {})
    })
    observer.observe(node)
    return () => {
      cancelled = true
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node])
  return (
    <div ref={setNode} className="berth-thumb">
      {src ? <img src={src} alt="" /> : null}
    </div>
  )
}

export function HistoryPanel({
  path,
  editorPath,
  revision,
  selected,
  isCurrent,
}) {
  const t = TEXT[berth.ui.locale?.startsWith("zh") ? "zh-CN" : "en"]
  const editorCall = (method, input) =>
    berth.editor.request(editorPath, method, input)
  const render = (content) => editorCall("render", { content })
  const [list, setList] = useState(null)
  const draftKey = `excalidraw:revise-draft:${path ?? editorPath}`
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) ?? "")
  const draft = useRef(text)
  const [error, setError] = useState(null)
  const updateDraft = (value) => {
    draft.current = value
    setText(value)
    setCopyPreview(null)
    try {
      sessionStorage.setItem(draftKey, value)
    } catch {
      setError(
        berth.ui.locale.startsWith("zh")
          ? "草稿暂存失败，请先复制保存。"
          : "Draft could not be saved. Copy it before switching drawings."
      )
    }
  }
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [showAll, setShowAll] = useState(false)
  const [currentHash, setCurrentHash] = useState(null)
  /** 对比：{ id, left: 旧版图, right: 当前图 } */
  const [compare, setCompare] = useState(null)
  const [copyPreview, setCopyPreview] = useState(null)

  const call = (input) => berth.scripts.run(API, { path, ...input })
  const versionContent = (id) =>
    call({ action: "get", id }).then((r) => r.content)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    void call({ action: "list" })
      .then(async (next) => {
        const { content } = await editorCall("snapshot")
        if (cancelled) return
        setList(next)
        setCurrentHash(hash(content))
      })
      .catch((e) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
    // 只在换画板、记录变了时重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, revision])

  const run = async (action) => {
    if (running.current || !mounted.current || !isCurrent()) return
    running.current = true
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    running.current = false
    if (mounted.current) setBusy(false)
  }

  const copyRequest = () =>
    run(async () => {
      const request = draft.current.trim()
      if (!request) return
      const { content, selection } = await editorCall("snapshot")
      setList(await call({ action: "request", text: request, content }))
      await editorCall("state")
      if (!mounted.current || !isCurrent()) return
      const instructions = t.ask(path, request, selection)
      setCopyPreview(instructions)
      await copyText(instructions, t.copyFailed)
      await berth.ui.notify(t.copied)
    })

  const restore = (id) =>
    run(async () => {
      const { content: expected } = await editorCall("snapshot")
      if (!mounted.current || !isCurrent()) return
      const { content } = await call({
        action: "restore",
        id,
        content: expected,
      })
      await editorCall("restore", { content, expected })
      setList(await call({ action: "list" }))
      setCurrentHash(hash(content))
      await berth.ui.notify(t.restored(id))
    })

  const openCompare = (id) =>
    run(async () => {
      const [left, right] = await Promise.all([
        versionContent(id).then(render),
        editorCall("snapshot").then(({ content }) => render(content)),
      ])
      setCompare({ id, left, right })
    })

  const versions = list?.versions ?? []
  const shown = showAll ? versions : versions.slice(0, SHOWN)

  return (
    <aside className="berth-panel">
      <header title={path} className="berth-drawing-name">
        {berth.ui.locale.startsWith("zh") ? "当前画板：" : "Current drawing: "}
        {editorPath}
      </header>
      <p className="berth-muted">
        {berth.ui.locale.startsWith("zh")
          ? "只修改当前画板；切换画板标签页可换图，草稿按文件暂存。"
          : "Only this drawing is targeted. Switch drawing tabs to change target; drafts are kept per file."}
      </p>
      {!path ? (
        <p className="berth-muted">{t.noProject}</p>
      ) : (
        <>
          <textarea
            rows={4}
            value={text}
            aria-label={t.draftLabel}
            placeholder={t.placeholder}
            onChange={(e) => updateDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                copyRequest()
              }
            }}
          />
          {selected ? (
            <p className="berth-muted">{t.selected(selected)}</p>
          ) : null}
          <button
            className="berth-primary"
            disabled={busy || !text.trim()}
            onClick={copyRequest}
          >
            {t.copy}
          </button>
          <p className="berth-muted">{t.copyHint}</p>
          {copyPreview ? (
            <details open className="berth-copy-preview">
              <summary>{t.preview}</summary>
              <textarea
                readOnly
                rows={8}
                aria-label={t.preview}
                value={copyPreview}
                onFocus={(event) => event.currentTarget.select()}
              />
            </details>
          ) : null}
          {error ? (
            <p className="berth-error-text" role="alert">
              {error}
            </p>
          ) : null}
          {list?.pending?.text ? (
            <p className="berth-pending">
              {t.pending}
              {list.pending.text}
            </p>
          ) : null}
          {versions.length === 0 && list ? (
            <p className="berth-muted">{t.empty}</p>
          ) : null}
          <ol className="berth-versions">
            {shown.map((version) => {
              const isCurrent = version.hash === currentHash
              return (
                <li key={version.id} className={isCurrent ? "current" : ""}>
                  <Thumb
                    load={() => versionContent(version.id)}
                    render={render}
                  />
                  <div className="berth-meta">
                    #{version.id} · {byLabel(version, t)} · {when(version.time)}
                    {isCurrent ? ` · ${t.current}` : ""}
                  </div>
                  {version.request ? (
                    <div>
                      {t.request}：{version.request}
                    </div>
                  ) : null}
                  {version.note ? (
                    <div>
                      {t.note}：{version.note}
                    </div>
                  ) : null}
                  {/* 「当前」按列表载入时的内容算，之后可能手动改过，所以按钮一直在 */}
                  <div className="berth-actions">
                    <button disabled={busy} onClick={() => restore(version.id)}>
                      {t.restore}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => openCompare(version.id)}
                    >
                      {t.compare}
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
          {!showAll && versions.length > SHOWN ? (
            <button className="berth-quiet" onClick={() => setShowAll(true)}>
              {t.more(versions.length - SHOWN)}
            </button>
          ) : null}
        </>
      )}
      {compare ? (
        <div className="berth-compare" onClick={() => setCompare(null)}>
          <figure>
            <figcaption>#{compare.id}</figcaption>
            <img src={compare.left} alt="" />
          </figure>
          <figure>
            <figcaption>{t.now}</figcaption>
            <img src={compare.right} alt="" />
          </figure>
          <div className="berth-compare-actions">
            <button
              className="berth-primary"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                setCompare(null)
                restore(compare.id)
              }}
            >
              {t.restore}
            </button>
            <button className="berth-quiet">{t.close}</button>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
