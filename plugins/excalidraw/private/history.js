// 画板的改图记录：Agent 改画板前自动存档，用户在Excalidraw 侧栏的「改图」页签里看每一版、回到任意一版。
// 记录在插件数据目录 history/<画板绝对路径编码>/，不进项目：index.json + <版本号>.excalidraw。
//
// Agent 改画板一律经 apply（先存当前版，再写入新版，记下这次改了什么），不直接写画板文件：
//   berth tools run excalidraw private/history.js apply <画板> <新版文件> "<一句话：改了什么>"
//   berth tools run excalidraw private/history.js list <画板>
// 画板页面经 berth.scripts.run 调 list / get / request / snapshot / restore（见 default 导出）。

import { absolute } from "./paths.js"

// ponytail: 每张画板只留最近 100 版，按版本数截断；画板很大时再按总字节截
const KEEP = 100

/** 内容指纹（djb2），页面用同一算法判断「当前是哪一版」、去重。 */
export function hash(text) {
  let value = 5381
  for (let i = 0; i < text.length; i++)
    value = ((value << 5) + value + text.charCodeAt(i)) | 0
  return `${(value >>> 0).toString(36)}-${text.length}`
}

const dirOf = (path) =>
  `${berth.storage.dir}/history/${encodeURIComponent(path)}`

async function readIndex(path) {
  try {
    return JSON.parse(await berth.fs.readText(`${dirOf(path)}/index.json`))
  } catch (error) {
    if (error.reason !== "not-found") throw error
    return { path, next: 1, pending: null, versions: [] }
  }
}

const writeIndex = (index) =>
  berth.fs.writeText(
    `${dirOf(index.path)}/index.json`,
    JSON.stringify(index, null, 1) + "\n"
  )

/** 记一版（与最新一版内容相同就不记），返回这一版；index 由调用方写回。 */
async function record(index, content, entry) {
  const key = hash(content)
  const last = index.versions[index.versions.length - 1]
  if (last?.hash === key) return last
  const version = { id: index.next++, time: Date.now(), hash: key, ...entry }
  await berth.fs.writeText(
    `${dirOf(index.path)}/${version.id}.excalidraw`,
    content
  )
  index.versions.push(version)
  for (const old of index.versions.splice(0, index.versions.length - KEEP))
    await berth.fs.remove(`${dirOf(index.path)}/${old.id}.excalidraw`)
  return version
}

async function readDrawing(path) {
  try {
    return await berth.fs.readText(path)
  } catch (error) {
    if (error.reason === "not-found") return null
    throw error
  }
}

/** 写坏的画板会让用户打不开，入库前先确认是场景 JSON。 */
function checkScene(path, content) {
  if (/\.excalidraw\.md$/i.test(path)) return
  let scene
  try {
    scene = JSON.parse(content)
  } catch (error) {
    throw new Error(`new version is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(scene?.elements))
    throw new Error("new version has no elements array")
}

/** 存当前版 → 记新版（带上用户在面板里提的要求）→ 写画板。index 先落盘，页面收到改写时记录已在。 */
async function apply(path, content, note) {
  checkScene(path, content)
  const index = await readIndex(path)
  const current = await readDrawing(path)
  if (current !== null) await record(index, current, { by: "before" })
  const version = await record(index, content, {
    by: "agent",
    request: index.pending?.text,
    note: note || undefined,
  })
  index.pending = null
  await writeIndex(index)
  await berth.fs.writeText(path, content)
  return version
}

const summary = (index) => ({
  path: index.path,
  pending: index.pending,
  versions: [...index.versions].reverse(),
})

async function cli([command, drawing, file, ...note]) {
  if (command === "list" && drawing) {
    const index = await readIndex(absolute(drawing))
    for (const v of summary(index).versions)
      console.log(
        `#${v.id} ${new Date(v.time).toISOString()} ${v.by}` +
          `${v.request ? ` 要求：${v.request}` : ""}${v.note ? ` 改动：${v.note}` : ""}`
      )
    return 0
  }
  if (command === "apply" && drawing && file) {
    const path = absolute(drawing)
    const version = await apply(
      path,
      await berth.fs.readText(absolute(file)),
      note.join(" ").trim()
    )
    console.log(`${path}: saved as version #${version.id}`)
    return 0
  }
  console.error(
    "usage: berth tools run excalidraw private/history.js apply <drawing> <new-version-file> <note>\n" +
      "       berth tools run excalidraw private/history.js list <drawing>"
  )
  return 2
}

/**
 * `path` 一律是画板绝对路径。
 * - `list {path}`：`{ pending, versions }`，新的在前；版本 `by`：`agent` Agent 改的、`before` 改动前存档、
 *   `restore` 回到旧版（`from` 是哪一版）、`external` 画板被外部直接改写。
 * - `get {path, id}`：`{ content }`。
 * - `request {path, text, content}`：用户在面板提了要求：存下当前内容，要求挂到下一次 apply。
 * - `snapshot {path, content, by?}`：存一版（内容没变就不存）。
 * - `restore {path, id, content}`：先存当前内容，再记一版「回到 #id」，返回旧版 `content` 由页面写回。
 * - `apply {path, content, note?}`：同命令行 apply。
 */
export default async function history(input) {
  if (Array.isArray(input)) {
    try {
      return await cli(input)
    } catch (error) {
      console.error(`history failed: ${error.message}`)
      return 1
    }
  }
  const path = input?.path
  if (!path) throw new Error("history needs path")
  const action = input.action ?? "list"
  if (action === "apply")
    return apply(path, String(input.content ?? ""), input.note)
  const index = await readIndex(path)
  if (action === "list") return summary(index)
  if (action === "get") {
    if (!index.versions.some((v) => v.id === input.id))
      throw new Error(`no version #${input.id}`)
    return {
      content: await berth.fs.readText(`${dirOf(path)}/${input.id}.excalidraw`),
    }
  }
  if (action === "request" || action === "snapshot") {
    const content = String(input.content ?? "")
    if (content) await record(index, content, { by: input.by ?? "before" })
    if (action === "request")
      index.pending = {
        text: String(input.text ?? "").trim(),
        time: Date.now(),
      }
    await writeIndex(index)
    return summary(index)
  }
  if (action === "restore") {
    if (!index.versions.some((v) => v.id === input.id))
      throw new Error(`no version #${input.id}`)
    const content = await berth.fs.readText(
      `${dirOf(path)}/${input.id}.excalidraw`
    )
    if (input.content)
      await record(index, String(input.content), { by: "before" })
    // 与最新版相同时 record 不记，「回到」这一步就不单独出现
    await record(index, content, { by: "restore", from: input.id })
    await writeIndex(index)
    return { content }
  }
  throw new Error(
    `unknown action ${action}; use list, get, request, snapshot, restore or apply`
  )
}
