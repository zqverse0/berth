import {
  EDITOR_RENDER_EVENT,
  editorRenderComplete,
  readFileForEdit,
  type EditorRenderRequest,
} from "@/lib/api"
import { isPathUnderRoot, splitAbsPath } from "@/lib/files/file-open-target"
import { getCurrentWindow, subscribe } from "@/lib/platform"
import {
  connectPluginPage,
  pluginAssetUrl,
  pluginFrameSandbox,
  type PageConnection,
} from "@/lib/plugins/plugin-page"
import {
  editorForPath,
  usePluginViewsStore,
  type PluginEditor,
} from "@/lib/plugins/plugin-views"

/**
 * Markdown 嵌入走插件（§4.2 `embed`）：`embed: true` 的编辑器页面以 `mode: "embed"` 开在隐藏 iframe 里，
 * 宿主调 `editor.render` 拿图片 data URL。每个（插件, 编辑器, files 根）一个页面，第一次用时建，之后复用。
 * ponytail: 隐藏页面常驻不回收；同时打开很多项目的嵌入文档时再按最近使用回收。
 */

const pages = new Map<string, Promise<PageConnection>>()

/** 当前启用、能渲染嵌入的编辑器。 */
export function embedEditors(): PluginEditor[] {
  return usePluginViewsStore.getState().editors.filter((editor) => editor.embed)
}

/** 接管 `path` 且能渲染嵌入的编辑器。 */
export function embedEditorForPath(path: string): PluginEditor | null {
  return editorForPath(embedEditors(), path)
}

function openPage(editor: PluginEditor, root: string): Promise<PageConnection> {
  const key = `${editor.plugin}\n${editor.id}\n${root}`
  let page = pages.get(key)
  if (!page) {
    page = new Promise((resolve) => {
      const frame = document.createElement("iframe")
      frame.setAttribute("aria-hidden", "true")
      frame.tabIndex = -1
      frame.setAttribute("sandbox", pluginFrameSandbox())
      // 不能 display:none：有的引擎不给隐藏 frame 加载字体、量文字
      frame.style.cssText =
        "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;pointer-events:none"
      const connection = connectPluginPage(frame, {
        plugin: editor.plugin,
        permissions: editor.permissions,
        root,
        project: null,
        locale: document.documentElement.lang || "en",
        context: {
          kind: "editor",
          id: editor.id,
          mode: "embed",
          path: "",
          readOnly: true,
          content: "",
        },
      })
      frame.src = pluginAssetUrl(editor.plugin, editor.page)
      document.body.append(frame)
      resolve(connection)
    })
    pages.set(key, page)
  }
  return page
}

/** 把 `absPath`（内容 `content`）渲染成图片 data URL；插件没出图或出错为 null。 */
export async function renderPluginEmbed(
  editor: PluginEditor,
  absPath: string,
  content: string,
  projectRoot: string | null
): Promise<string | null> {
  try {
    return await renderEmbedImage(editor, absPath, content, projectRoot)
  } catch {
    return null
  }
}

/** 同上，但出错时抛出原因；`format` 原样交给插件页面（如 `png`），省略时由插件决定。 */
async function renderEmbedImage(
  editor: PluginEditor,
  absPath: string,
  content: string,
  projectRoot: string | null,
  format?: string
): Promise<string> {
  const root =
    projectRoot && isPathUnderRoot(absPath, projectRoot)
      ? projectRoot.replace(/[\\/]+$/, "")
      : (splitAbsPath(absPath)?.rootPath ?? null)
  if (!root) throw new Error(`${absPath} is not an absolute path`)
  const page = await openPage(editor, root)
  const result = await page.request("editor.render", {
    path: absPath.slice(root.length + 1),
    content,
    theme: document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
    ...(format ? { format } : {}),
  })
  if (typeof result === "string" && result.startsWith("data:image/"))
    return result
  throw new Error(`plugin ${editor.plugin} returned no image`)
}

let listening = false

/**
 * 插件脚本 `berth.editor.render`（经 control 的 `editor.render`）：只用该插件自己的嵌入编辑器，
 * 按后缀选；渲染结果交回后端写盘。只在主窗口订阅，重复调用无副作用。
 */
export function listenForEditorRenders(): void {
  if (listening) return
  listening = true
  void (async () => {
    const win = await getCurrentWindow()
    if (win && win.label !== "main") return
    await subscribe<EditorRenderRequest>(EDITOR_RENDER_EVENT, (request) => {
      void (async () => {
        try {
          const editor = editorForPath(
            embedEditors().filter((item) => item.plugin === request.plugin),
            request.path
          )
          if (!editor)
            throw new Error(
              `plugin ${request.plugin} has no enabled embed editor for ${request.path}`
            )
          const split = splitAbsPath(request.path)
          if (!split) throw new Error(`${request.path} is not an absolute path`)
          const { content } = await readFileForEdit(
            split.rootPath,
            split.ioPath
          )
          const image = await renderEmbedImage(
            editor,
            request.path,
            content,
            null,
            request.format
          )
          await editorRenderComplete(request.request_id, { image })
        } catch (error) {
          await editorRenderComplete(request.request_id, {
            message: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined)
        }
      })()
    })
  })().catch(() => {
    // 非桌面环境：没有渲染请求
  })
}
