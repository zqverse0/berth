// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 页面经 scripts.run("ui/api.js", { action, … }) 调用的后端：读写 `<主项目>/.berth/ideas/`。
// 一条想法一个文件 `<创建时间>.idea.md`（后缀让包里的编辑页接管），固定三块：用户原话 / `## 讨论` / `## 结论`；
// 已落地 / 已放下的移进 `归档/`。worktree 里也读写主项目那一份。
// 想法的关闭、重开只走 setStatus：关闭时进知识库的待入库清单，重开时移除。

const DIR = ".berth/ideas"
/** 旧版内置「想法」的位置，第一次打开时整体搬过来。 */
const LEGACY_DIR = ".berth/knowledge/想法"
const ARCHIVE = "归档"
const STATUSES = ["待讨论", "讨论中", "已落地", "已放下"]
const CLOSED = ["已落地", "已放下"]
const EXT = ".idea.md"

/** @param {any} input */
export default async function (input) {
  switch (input?.action) {
    case "list":
      return await list(input.main)
    case "create":
      return await create()
    case "setStatus":
      return await setStatus(
        // Agent 用 `berth tools call` 调时不传，按当前项目找。
        input.main ? String(input.main) : await mainProject(),
        String(input.id),
        String(input.status)
      )
    default:
      throw new Error(`unknown action: ${input?.action}`)
  }
}

/** 主项目（`berth init` 过的 checkout）：worktree 项目也落到它。 */
async function mainProject() {
  const project = await berth.env.project()
  if (!project) throw new Error("没有打开项目")
  const { code, stdout, stderr } = await berth.process.exec(
    "berth",
    ["project", project.root, "knowledge", "root"],
    { timeoutMs: 15000 }
  )
  if (code !== 0) throw new Error(stderr.trim() || "找不到项目的 .berth 目录")
  return stdout.trim().replace(/[\\/]\.berth[\\/]knowledge$/, "")
}

/** @param {string} [known] 页面已知的主项目：轮询时不用每次起 `berth` 进程 */
async function list(known) {
  const main = known || (await mainProject())
  const enabled = (await berth.fs.stat(`${main}/.berth`))?.kind === "dir"
  if (enabled && !known) await migrate(main)
  const ideas = []
  for (const dir of [DIR, `${DIR}/${ARCHIVE}`]) {
    const names = await berth.fs.list(`${main}/${dir}`).catch(() => [])
    for (const name of names) {
      if (name.endsWith(".md")) ideas.push(await read(main, `${dir}/${name}`))
    }
  }
  ideas.sort((a, b) => (a.id < b.id ? 1 : -1))
  return { main, enabled, ideas }
}

/** @param {string} main */
async function migrate(main) {
  if (
    !(await berth.fs.stat(`${main}/${DIR}`)) &&
    (await berth.fs.stat(`${main}/${LEGACY_DIR}`))?.kind === "dir"
  ) {
    await berth.fs.rename(`${main}/${LEGACY_DIR}`, `${main}/${DIR}`)
  }
  // 早期的 `<id>.md` 改成 `<id>.idea.md`
  for (const dir of [DIR, `${DIR}/${ARCHIVE}`]) {
    const names = await berth.fs.list(`${main}/${dir}`).catch(() => [])
    for (const name of names) {
      if (name.endsWith(".md") && !name.endsWith(EXT)) {
        await berth.fs.rename(
          `${main}/${dir}/${name}`,
          `${main}/${dir}/${name.slice(0, -3)}${EXT}`
        )
      }
    }
  }
}

/** 建一条空想法并返回绝对路径：tab 栏「+」（tool.json `new`）与侧栏共用，正文在工作区写。 */
async function create() {
  const main = await mainProject()
  if ((await berth.fs.stat(`${main}/.berth`))?.kind !== "dir") {
    throw new Error("项目还没启用 Berth")
  }
  await migrate(main)
  await berth.fs.mkdir(`${main}/${DIR}`)
  const stamp = timestamp(new Date())
  let rel = `${DIR}/${stamp}${EXT}`
  for (let n = 2; await berth.fs.stat(`${main}/${rel}`); n++) {
    rel = `${DIR}/${stamp}-${n}${EXT}`
  }
  await berth.fs.writeText(
    `${main}/${rel}`,
    `---\ntype: 想法\nstatus: 待讨论\n---\n\n\n\n## 讨论\n\n## 结论\n`
  )
  return { path: `${main}/${rel}` }
}

/**
 * 改状态；关闭的移进归档并进待入库，重新打开的移回来并移除。
 * 待入库失败不回退状态，结果里带 `inboxError`。
 * @param {string} main
 * @param {string} id
 * @param {string} status
 */
async function setStatus(main, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`不支持的状态：${status}`)
  if (!/^[\w-]+$/.test(id)) throw new Error(`想法 id 不合法：${id}`)
  const from = await locate(main, id)
  const content = await berth.fs.readText(`${main}/${from}`)
  const name = from.replace(/^.*\//, "")
  const to = `${DIR}/${CLOSED.includes(status) ? `${ARCHIVE}/` : ""}${name}`
  await berth.fs.writeText(`${main}/${from}`, replaceStatus(content, status))
  if (to !== from) {
    await berth.fs.mkdir(`${main}/${to.replace(/\/[^/]+$/, "")}`)
    await berth.fs.rename(`${main}/${from}`, `${main}/${to}`)
  }
  const idea = await read(main, to)
  const inboxError = await syncInbox(main, idea, content, from)
  return inboxError ? { ...idea, inboxError } : idea
}

/**
 * 关闭 → 生成待入库（结论写了「→ 任务」的随任务归档时一起处理，不单独生成）；从归档重开 → 移除。
 * @param {string} main
 * @param {{ id: string, status: string, text: string }} idea
 * @param {string} content 想法全文
 * @param {string} from 改状态前的相对路径
 * @returns {Promise<string | null>} 失败原因
 */
async function syncInbox(main, idea, content, from) {
  const closed = CLOSED.includes(idea.status)
  /** @type {string[] | null} */
  let args = null
  if (closed && !/^##\s*结论[\s\S]*^→\s*任务/m.test(content)) {
    args = [
      "add",
      idea.id,
      "--kind=想法",
      `--title=${idea.text.split("\n")[0] || idea.id}`,
      `--result=${idea.status === "已放下" ? "已放下" : "已完成"}`,
      `--body=${split(content).body}`,
    ]
  } else if (!closed && from.startsWith(`${DIR}/${ARCHIVE}/`)) {
    args = ["remove", idea.id]
  }
  if (!args) return null
  try {
    const { code, stderr } = await berth.process.exec(
      "berth",
      // 按目录找项目，主目录没注册（只打开了 worktree）时也写得进去。
      ["project", ".", "knowledge", "inbox", ...args],
      { cwd: main, timeoutMs: 15000 }
    )
    return code === 0 ? null : stderr.trim() || `berth exit ${code}`
  } catch (error) {
    return String(error)
  }
}

/**
 * @param {string} main
 * @param {string} id
 */
async function locate(main, id) {
  // Agent 手写的文件可能还是 `.md`（下次打开列表时才改名）
  for (const name of [`${id}${EXT}`, `${id}.md`]) {
    for (const rel of [`${DIR}/${name}`, `${DIR}/${ARCHIVE}/${name}`]) {
      if (await berth.fs.stat(`${main}/${rel}`)) return rel
    }
  }
  throw new Error(`没有想法 ${id}`)
}

/**
 * @param {string} main
 * @param {string} rel
 */
async function read(main, rel) {
  const path = `${main}/${rel}`
  const content = await berth.fs.readText(path)
  const { front, body } = split(content)
  return {
    id: rel.replace(/^.*\//, "").replace(/(\.idea)?\.md$/, ""),
    path: rel,
    status: /^status:\s*(.+?)\s*$/m.exec(front)?.[1] ?? "待讨论",
    // 用户原话：第一个二级标题（`## 讨论` 等）之前；其余是 Agent 追加的讨论与结论。
    text: `\n${body}`.split("\n## ")[0].trim(),
    modifiedAt: (await berth.fs.stat(path))?.mtimeMs ?? 0,
  }
}

/** @param {string} content */
function split(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  return match
    ? { front: match[1], body: content.slice(match[0].length) }
    : { front: "", body: content }
}

/**
 * @param {string} content
 * @param {string} status
 */
function replaceStatus(content, status) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return `---\ntype: 想法\nstatus: ${status}\n---\n\n${content}`
  const front = /^status:.*$/m.test(match[1])
    ? match[1].replace(/^status:.*$/m, `status: ${status}`)
    : `${match[1]}\nstatus: ${status}`
  return `---\n${front}\n---\n${content.slice(match[0].length)}`
}

/** @param {Date} d `2026-10-11-191324`（本地时间） */
function timestamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
