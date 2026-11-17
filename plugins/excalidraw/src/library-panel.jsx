// 图形素材与「图库」的参考图片分开：这里只管原生 .excalidrawlib 图形组合。
import { useEffect, useRef, useState } from "react"
import { Thumb } from "./history-panel.jsx"

export function LibraryPanel({
  editorPath,
  selected,
  libraryRevision,
  librarySaving,
  libraryError,
}) {
  const zh = berth.ui.locale.startsWith("zh")
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(null)
  const [picked, setPicked] = useState(new Set())
  const [publicOpen, setPublicOpen] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [query, setQuery] = useState("")
  const [publicLimit, setPublicLimit] = useState(32)
  const chosen =
    items?.filter((item) => picked.has(item.id)).map((item) => item.id) ?? []
  const publicMatches =
    catalog?.filter((item) =>
      `${item.name} ${item.description} ${item.authors}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    ) ?? []
  const input = useRef(null)
  const running = useRef(false)
  const call = (method, input) =>
    berth.editor.request(editorPath, `library.${method}`, input)
  const load = () => call("list").then(setItems)

  useEffect(() => {
    let cancelled = false
    void call("list")
      .then((items) => {
        if (!cancelled) {
          setItems(items)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
    // 只在当前画板或素材发生变化时重读，不随选区变化重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorPath, libraryRevision])

  const run = async (action) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(e.message)
    }
    running.current = false
    setBusy(false)
  }
  const importFile = (file) =>
    run(async () => {
      if (!file) return
      await call("import", { content: await file.text() })
      await load()
    })
  const exportFile = () =>
    run(async () => {
      const content = await call(
        "export",
        chosen.length ? { ids: chosen } : undefined
      )
      const { path } = await berth.scripts.run("private/library.js", {
        action: "exportShapes",
        content,
      })
      await berth.ui.notify(
        zh ? `素材库已导出到 ${path}` : `Library exported to ${path}`
      )
    })
  const browse = () => {
    setPublicOpen(true)
    if (!catalog)
      void run(async () =>
        setCatalog(
          await berth.scripts.run("private/library.js", {
            action: "publicCatalog",
          })
        )
      )
  }
  const addPublic = (entry) =>
    run(async () => {
      const { content } = await berth.scripts.run("private/library.js", {
        action: "publicLibrary",
        source: entry.source,
      })
      await call("import", { content, published: true, name: entry.name })
      await load()
      setPublicOpen(false)
      document.getElementById("root").scrollTop = 0
      await berth.ui.notify(
        zh ? `已添加素材库：${entry.name}` : `Library added: ${entry.name}`
      )
    })
  const label = (item, index) =>
    item.name ||
    (zh
      ? `素材 ${index + 1}（${item.count} 个元素）`
      : `Item ${index + 1} (${item.count} elements)`)

  return (
    <section
      className="berth-panel"
      aria-label={zh ? "素材库" : "Shape library"}
    >
      <header className="berth-drawing-name">
        {zh ? "插入目标：" : "Insert into: "}
        {editorPath}
      </header>
      <p className="berth-muted">
        {zh
          ? "图形组合可重复插入画板，素材在各项目间共用。"
          : "Reusable shapes for your drawings, shared across projects."}
      </p>
      <button className="berth-primary" disabled={busy} onClick={browse}>
        {zh
          ? "浏览公开素材库 · 添加素材"
          : "Browse public libraries · Add shapes"}
      </button>
      {publicOpen ? (
        <section
          className="berth-public-libraries"
          aria-label={zh ? "公开素材库" : "Public libraries"}
        >
          <div className="berth-actions">
            <button onClick={() => setPublicOpen(false)}>
              {zh ? "返回我的素材" : "Back to my shapes"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run(() => berth.ui.openUrl("https://libraries.excalidraw.com/"))
              }
            >
              {zh ? "打开官网" : "Open website"}
            </button>
          </div>
          <input
            type="search"
            aria-label={zh ? "搜索公开素材" : "Search public libraries"}
            placeholder={
              zh
                ? "搜索名称、说明、作者……"
                : "Search name, description, author…"
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPublicLimit(32)
            }}
          />
          {catalog ? (
            <>
              <p className="berth-muted">
                {zh
                  ? `官方目录 · ${publicMatches.length} 个素材库`
                  : `Official catalog · ${publicMatches.length} libraries`}
              </p>
              <ul className="berth-public-list">
                {publicMatches.slice(0, publicLimit).map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.name}</strong>
                    <p>{entry.description}</p>
                    <p className="berth-muted">{entry.authors}</p>
                    <button
                      disabled={busy || librarySaving || Boolean(libraryError)}
                      aria-label={
                        zh ? `添加 ${entry.name}` : `Add ${entry.name}`
                      }
                      onClick={() => addPublic(entry)}
                    >
                      {zh ? "添加到素材库" : "Add to library"}
                    </button>
                  </li>
                ))}
              </ul>
              {!publicMatches.length ? (
                <p className="berth-muted">
                  {zh ? "没有匹配的素材库。" : "No matching libraries."}
                </p>
              ) : null}
              {publicMatches.length > publicLimit ? (
                <button onClick={() => setPublicLimit((limit) => limit + 32)}>
                  {zh ? "显示更多" : "Show more"}
                </button>
              ) : null}
            </>
          ) : busy ? (
            <p role="status">
              {zh ? "正在加载官方素材目录……" : "Loading official catalog…"}
            </p>
          ) : (
            <button onClick={browse}>
              {zh ? "重试加载目录" : "Retry catalog"}
            </button>
          )}
        </section>
      ) : null}
      <div className="berth-actions berth-library-tools">
        <button
          disabled={busy || librarySaving || Boolean(libraryError) || !selected}
          onClick={() =>
            run(async () => {
              await call("add")
              await load()
            })
          }
        >
          {zh ? "收藏选中元素" : "Save selection"}
        </button>
        <button
          disabled={busy || librarySaving || Boolean(libraryError)}
          onClick={() => input.current.click()}
        >
          {zh ? "导入" : "Import"}
        </button>
        <button disabled={busy || !items?.length} onClick={exportFile}>
          {chosen.length
            ? zh
              ? "导出选中素材"
              : "Export selected"
            : zh
              ? "导出到项目"
              : "Export to project"}
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".excalidrawlib,application/vnd.excalidrawlib+json"
        hidden
        aria-label={zh ? "导入素材库文件" : "Import library file"}
        onChange={(e) => {
          void importFile(e.target.files[0])
          e.target.value = ""
        }}
      />
      {librarySaving ? (
        <p className="berth-muted" role="status">
          {zh ? "正在保存素材库……" : "Saving library…"}
        </p>
      ) : null}
      {libraryError ? (
        <div role="alert" className="berth-error-text">
          {zh
            ? "素材库读写失败，请重试或导出备份："
            : "Library storage failed. Retry or export a backup: "}
          {libraryError}
          <button disabled={busy} onClick={() => run(() => call("retry"))}>
            {zh ? "重试" : "Retry"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="berth-error-text" role="alert">
          {error}
        </p>
      ) : null}
      {items?.length === 0 ? (
        <p className="berth-muted">
          {zh
            ? "还没有素材。选中图形后收藏，或导入 .excalidrawlib 文件。"
            : "No shapes yet. Save selected elements or import an .excalidrawlib file."}
        </p>
      ) : null}
      {items?.length ? (
        <div className="berth-library-selection">
          <label>
            <input
              type="checkbox"
              aria-label={zh ? "选择全部素材" : "Select all shapes"}
              checked={chosen.length === items.length}
              ref={(node) => {
                if (node)
                  node.indeterminate =
                    chosen.length > 0 && chosen.length < items.length
              }}
              onChange={(e) =>
                setPicked(
                  e.target.checked
                    ? new Set(items.map((item) => item.id))
                    : new Set()
                )
              }
            />
            {zh ? `已选 ${chosen.length} 项` : `${chosen.length} selected`}
          </label>
          <div className="berth-actions">
            <button
              disabled={busy || !chosen.length}
              onClick={() => run(() => call("insert", { ids: chosen }))}
            >
              {zh ? "插入选中素材" : "Insert selected"}
            </button>
            <button
              disabled={
                busy || librarySaving || Boolean(libraryError) || !chosen.length
              }
              onClick={() => setRemoving(chosen)}
            >
              {zh ? "移除选中素材" : "Remove selected"}
            </button>
          </div>
        </div>
      ) : null}
      {removing ? (
        <div className="berth-pending" role="alert">
          <p>
            {zh
              ? `确认移除 ${removing.length} 项素材？不会删除画板中的图形。`
              : `Remove ${removing.length} library items? Drawings are not affected.`}
          </p>
          <div className="berth-actions">
            <button
              disabled={busy || librarySaving || Boolean(libraryError)}
              onClick={() =>
                run(async () => {
                  await call("remove", { ids: removing })
                  setRemoving(null)
                  setPicked(new Set())
                  await load()
                })
              }
            >
              {zh ? "确认移除" : "Confirm removal"}
            </button>
            <button onClick={() => setRemoving(null)}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
      <ul className="berth-shapes">
        {items?.map((item, index) => (
          <li key={item.id} className={picked.has(item.id) ? "picked" : ""}>
            <label className="berth-shape-check">
              <input
                type="checkbox"
                aria-label={
                  zh
                    ? `选择${label(item, index)}`
                    : `Select ${label(item, index)}`
                }
                checked={picked.has(item.id)}
                onChange={(e) =>
                  setPicked((current) => {
                    const next = new Set(current)
                    if (e.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })
                }
              />
              {item.status === "published"
                ? zh
                  ? "公开素材"
                  : "Public"
                : zh
                  ? "个人素材"
                  : "Personal"}
            </label>
            <button
              className="berth-shape-insert"
              disabled={busy}
              title={zh ? "插入当前画板" : "Insert into drawing"}
              aria-label={
                zh
                  ? `插入${label(item, index)}`
                  : `Insert ${label(item, index)}`
              }
              onClick={() => run(() => call("insert", { id: item.id }))}
            >
              <Thumb
                load={() => Promise.resolve(item.id)}
                render={(id) => call("render", { id })}
              />
              <span>{label(item, index)}</span>
            </button>
            <button
              className="berth-quiet"
              disabled={busy || librarySaving || Boolean(libraryError)}
              aria-label={
                zh
                  ? `移除${label(item, index)}`
                  : `Remove ${label(item, index)}`
              }
              onClick={() => setRemoving([item.id])}
            >
              {zh ? "移除" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
