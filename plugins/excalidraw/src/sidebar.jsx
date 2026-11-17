// 图库与改图共享一个侧栏入口；画板状态始终向当前编辑器取，不另存副本。
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { LibraryPanel } from "./library-panel.jsx"
import { HistoryPanel } from "./history-panel.jsx"
import "./gallery/style.css"
import "./history-panel.css"

await berth.ready
const zh = berth.ui.locale.startsWith("zh")
const tabs = [
  { id: "gallery", label: zh ? "图库" : "Gallery" },
  { id: "library", label: zh ? "素材库" : "Library" },
  { id: "revise", label: zh ? "改图" : "Revise" },
]

function Sidebar() {
  const [tab, setTab] = useState("gallery")
  const [target, setTarget] = useState(null)
  const [error, setError] = useState(null)
  const current = useRef(null)

  useEffect(() => {
    let cancelled = false
    let sequence = 0
    const refresh = async () => {
      const id = ++sequence
      try {
        const active = await berth.editor.active()
        if (cancelled || id !== sequence) return
        current.current = active?.path ?? null
        const state = active
          ? await berth.editor.request(active.path, "state")
          : null
        if (cancelled || id !== sequence) return
        setTarget(state ? { ...state, editorPath: active.path } : null)
        setError(null)
      } catch (e) {
        if (cancelled || id !== sequence) return
        current.current = null
        setTarget(null)
        setError(e.message)
      }
    }
    const off = berth.editor.onChange(refresh)
    void refresh()
    return () => {
      cancelled = true
      current.current = null
      off()
    }
  }, [])

  useEffect(() => {
    const off = berth.ui.onHeaderTab(setTab)
    void berth.ui
      .setHeaderTabs(tabs, "gallery")
      .catch((e) => setError(e.message))
    // 图库仍用原来的实现；隐藏而不是卸载，保留搜索和勾选。
    void import("./gallery/app.js").catch((e) => setError(e.message))
    return off
  }, [])

  useEffect(() => {
    document.getElementById("root").scrollTop = 0
  }, [tab, target?.path, target?.editorPath])

  useEffect(
    () =>
      berth.ui.context.onDrop?.((drop) => {
        if (
          (tab === "revise" || tab === "library") &&
          drop.kind === "file" &&
          /\.excalidraw(?:\.md)?$/i.test(drop.path)
        ) {
          void berth.files.open(drop.path).catch((e) => setError(e.message))
        }
      }),
    [tab]
  )

  return (
    <>
      <div id="app" hidden={tab !== "gallery"} />
      {tab === "library" ? (
        target ? (
          <LibraryPanel key={target.path ?? target.editorPath} {...target} />
        ) : (
          <p className="berth-muted">
            {zh
              ? "打开一张可编辑的 Excalidraw 画板，即可使用素材库。"
              : "Open an editable Excalidraw drawing to use the shape library."}
          </p>
        )
      ) : null}
      <div hidden={tab !== "revise"}>
        {target ? (
          <HistoryPanel
            key={target.path ?? target.editorPath}
            {...target}
            isCurrent={() => current.current === target.editorPath}
          />
        ) : (
          <p className="berth-muted">
            {zh
              ? "打开一张可编辑的 Excalidraw 画板，即可在这里改图。"
              : "Open an editable Excalidraw drawing to revise it here."}
          </p>
        )}
      </div>
      {error ? (
        <p className="berth-error-text" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

createRoot(document.getElementById("root")).render(<Sidebar />)
