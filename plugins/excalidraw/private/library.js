// 素材库（插件数据目录 library/）。三层合在一起：
// - 包里自带的起手模板（gallery/templates.js）；
// - collect.py 收集的 index.json（重跑会整个重写）；
// - 用户层 user.json：自己加的素材（文件在 library/user/）与移除名单。collect.py 不碰它，移除的不会被加回来。
// 图库页面经 berth.scripts.run 调；Agent 也可以：
//   berth tools call excalidraw private/library.js --input '{"action":"list"}'
//   berth tools call excalidraw private/library.js --input '{"action":"add","path":"/abs/fig.png","title":"…"}'

import { TEMPLATES } from "../gallery/templates.js"
import { layout } from "./layout.js"

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
}
const TEXT_EXT = ["md", "txt"]
/** 用户素材的子目录。 */
const USER_DIRS = {
  reference: "references",
  template: "templates",
  prompt: "prompts",
}

const libraryDir = () => `${berth.storage.dir}/library`
const extOf = (path) => path.split(".").pop().toLowerCase()
const baseName = (path) => path.split("/").pop()

async function readJson(path) {
  try {
    return JSON.parse(await berth.fs.readText(path))
  } catch (error) {
    if (error.reason === "not-found") return null
    throw error
  }
}

async function readUser() {
  const user = await readJson(`${libraryDir()}/user.json`)
  return { removed: user?.removed ?? [], items: user?.items ?? [] }
}

const writeUser = (user) =>
  berth.fs.writeText(
    `${libraryDir()}/user.json`,
    JSON.stringify(user, null, 1) + "\n"
  )

async function thumbUrl(relative) {
  const mime = IMAGE_MIME[extOf(relative)]
  if (!mime) return null
  const data = await berth.fs.readBase64(`${libraryDir()}/${relative}`)
  return `data:${mime};base64,${data}`
}

/** 卡片上的正文预览：前 4 行非空文字，最多 240 字。 */
function excerpt(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
  const joined = lines.join("\n")
  return joined.length > 240 ? `${joined.slice(0, 240)}…` : joined
}

/** 画板里的文字（用户模板没有缩略图，用它预览）。 */
function drawingLabels(text) {
  try {
    const labels = JSON.parse(text)
      .elements.filter(
        (element) => element.type === "text" && !element.isDeleted
      )
      .map((element) => element.text.replace(/\s+/g, " "))
    return excerpt(labels.join(" · "))
  } catch {
    return ""
  }
}

/** 文字类素材的全文：index 里带了就用，否则读文件。 */
async function fullText(item) {
  if (item.prompt) return item.prompt
  if (item.kind === "style" || item.kind === "prompt")
    return berth.fs.readText(`${libraryDir()}/${item.path}`)
  return null
}

/** 模板条目：缩略图在页面目录（`gallery/templates/<id>.png`），页面按相对地址直接显示。 */
const templateItem = ({ id, title, tags }) => ({
  id,
  title,
  tags,
  kind: "template",
  source: "berth",
  thumbAsset: `templates/${id}.png`,
})

/** 列表条目：去掉提示词全文，补 `hasPrompt` 与文字预览 `excerpt`。 */
async function listItem(item) {
  if (item.source === "berth") return { ...item, hasPrompt: false }
  const { prompt, ...rest } = item
  if (item.kind === "template" && item.path)
    return {
      ...rest,
      hasPrompt: false,
      excerpt: drawingLabels(
        await berth.fs.readText(`${libraryDir()}/${item.path}`)
      ),
    }
  if (item.kind !== "style" && item.kind !== "prompt")
    return { ...rest, hasPrompt: Boolean(prompt) }
  const text = await fullText(item).catch(() => "")
  return { ...rest, hasPrompt: Boolean(text), excerpt: excerpt(text ?? "") }
}

/** 全部条目（模板 + 收集 + 用户），`removed` 名单里的分开放。 */
async function allItems(bench) {
  const index = await readJson(`${libraryDir()}/index.json`)
  const user = await readUser()
  const collected = (index?.items ?? []).filter(
    (item) => bench || item.kind !== "bench"
  )
  const items = [...TEMPLATES.map(templateItem), ...user.items, ...collected]
  const removed = new Set(user.removed)
  return {
    index,
    user,
    items: items.filter((item) => !removed.has(item.id)),
    removed: items.filter((item) => removed.has(item.id)),
  }
}

async function findItem(id) {
  const template = TEMPLATES.find((entry) => entry.id === id)
  if (template)
    return { ...templateItem(template), structure: template.structure }
  const { index, user } = await allItems(true)
  const item = [...user.items, ...(index?.items ?? [])].find(
    (entry) => entry.id === id
  )
  if (!item) throw new Error(`no library item ${id}`)
  return item
}

/** 不重名的路径：`<dir>/<stem>.<ext>`、`<stem>-2.<ext>`… */
async function freePath(dir, stem, ext) {
  for (let n = 1; ; n++) {
    const path = `${dir}/${stem}${n === 1 ? "" : `-${n}`}.${ext}`
    if (!(await berth.fs.stat(path))) return path
  }
}

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item"

async function projectRoot() {
  const project = await berth.env.project()
  if (!project?.root) throw new Error("open a project first")
  return project.root
}

/** 用户素材入库：记进 user.json，返回条目。 */
async function addUserItem(entry) {
  const user = await readUser()
  const taken = new Set(user.items.map((item) => item.id))
  let id = `user-${slug(entry.title)}`
  for (let n = 2; taken.has(id); n++) id = `user-${slug(entry.title)}-${n}`
  const item = { id, source: "user", tags: [], thumb: null, ...entry }
  item.tags = [...new Set([...(entry.tags ?? []), "mine"])]
  user.items.unshift(item)
  await writeUser(user)
  return item
}

/** 文件入库：图片 → 参考，`.excalidraw` → 模板，`.md` / `.txt` → 提示词。路径可相对当前项目。 */
async function addFile(input) {
  const from = input.path.startsWith("/")
    ? input.path
    : `${await projectRoot()}/${input.path}`
  const ext = extOf(from)
  const kind = IMAGE_MIME[ext]
    ? "reference"
    : ext === "excalidraw"
      ? "template"
      : TEXT_EXT.includes(ext)
        ? "prompt"
        : null
  if (!kind)
    throw new Error(
      `cannot add ${baseName(from)}: use an image, .excalidraw, .md or .txt file`
    )
  const stem = baseName(from).slice(0, -(ext.length + 1))
  const to = await freePath(
    `${libraryDir()}/user/${USER_DIRS[kind]}`,
    slug(stem),
    ext
  )
  await berth.fs.mkdir(to.slice(0, to.lastIndexOf("/")))
  await berth.fs.copy(from, to)
  const path = to.slice(libraryDir().length + 1)
  return addUserItem({
    kind,
    title: input.title || stem,
    tags: input.tags,
    path,
    thumb: kind === "reference" ? path : null,
  })
}

/**
 * - `list`（`bench?: true` 含 Bench）：`items` 不含提示词全文（`hasPrompt`、文字预览 `excerpt`），
 *   `removed` 是移除名单里的条目；库没收集时 `missing: true`（模板与自己加的照常列出）。
 * - `get {id}`：完整条目，加绝对路径 `file`、缩略图 `thumbUrl`、文字素材的全文 `prompt`。
 * - `create {id}`：用模板在当前项目 `figures/` 下新建画板，返回绝对路径 `path`。
 * - `add {path, title?, tags?}`：把文件加进素材库（复制进 library/user/），按后缀归类。
 * - `addText {title, text, tags?}`：新建一条提示词。
 * - `remove {id}` / `restore {id}`：移出图库 / 放回（文件不删，collect.py 重跑也不会加回来）。
 */
export default async function library(input) {
  const action = input?.action ?? "list"
  const dir = libraryDir()
  if (action === "list") {
    const { index, items, removed } = await allItems(input?.bench === true)
    return {
      dir,
      missing: !index,
      generatedAt: index?.generatedAt ?? null,
      sources: index?.sources ?? [],
      items: await Promise.all(items.map(listItem)),
      removed: removed.map(({ id, kind, title }) => ({ id, kind, title })),
    }
  }
  if (action === "get") {
    const item = await findItem(input?.id)
    if (item.source === "berth") return item
    return {
      ...item,
      file: `${dir}/${item.path}`,
      thumbUrl: item.thumb ? await thumbUrl(item.thumb) : null,
      prompt: (await fullText(item)) ?? undefined,
    }
  }
  if (action === "create") {
    const item = await findItem(input?.id)
    if (item.kind !== "template")
      throw new Error(`${item.id} is not a template`)
    const root = await projectRoot()
    const path = await freePath(
      `${root}/figures`,
      slug(item.title),
      "excalidraw"
    )
    if (item.structure)
      await berth.fs.writeText(
        path,
        JSON.stringify(layout(item.structure), null, 2) + "\n"
      )
    else await berth.fs.copy(`${dir}/${item.path}`, path)
    return { path }
  }
  if (action === "add") {
    if (!input?.path) throw new Error("add needs path")
    return addFile(input)
  }
  if (action === "addText") {
    const title = String(input?.title ?? "").trim()
    const text = String(input?.text ?? "").trim()
    if (!title || !text) throw new Error("addText needs title and text")
    const to = await freePath(`${dir}/user/prompts`, slug(title), "md")
    await berth.fs.writeText(to, text + "\n")
    return addUserItem({
      kind: "prompt",
      title,
      tags: input.tags,
      path: to.slice(dir.length + 1),
    })
  }
  if (action === "remove" || action === "restore") {
    await findItem(input?.id)
    const user = await readUser()
    const removed = new Set(user.removed)
    if (action === "remove") removed.add(input.id)
    else removed.delete(input.id)
    user.removed = [...removed]
    await writeUser(user)
    return { id: input.id, removed: action === "remove" }
  }
  throw new Error(
    `unknown action ${action}; use list, get, create, add, addText, remove or restore`
  )
}
