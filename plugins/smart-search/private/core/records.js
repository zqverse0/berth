// 搜索 / 抓取记录：`<数据目录>/records/<YYYY-MM-DD>/<HHMMSS>-<slug>-<4位随机>/`，
// 里面 query.json（问题、模式、项目、发起方、时间）、result.json（输出）、pages/<n>.md（抓取全文，首行注明 url）。
// 不建共享索引：多个 Agent 同时写也互不覆盖，查找时按日期目录倒序扫。

const pad = (n) => String(n).padStart(2, "0")
const DAY_MS = 86_400_000
/** `find` 只看这么多天内的记录。 */
export const FIND_DAYS = 30

const root = (deps) => `${deps.stateDir}/records`

export const dayOf = (time) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 比较用的规范化：小写、全角转半角、去标点与多余空白。 */
export function normalize(text) {
  return String(text ?? "")
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** 目录名里的 slug：字母数字与汉字，其余换成 `-`，最多 24 字。 */
export function slugOf(text) {
  const slug = [...normalize(text).replace(/[^\p{L}\p{N}]+/gu, "-")]
    .slice(0, 24)
    .join("")
    .replace(/^-+|-+$/g, "")
  return slug || "query"
}

const readJson = async (deps, path) => {
  try {
    return JSON.parse(await deps.fs.readText(path))
  } catch (error) {
    if (error?.reason === "cancelled") throw error
    return null
  }
}

const listDir = async (deps, dir) => {
  try {
    return await deps.fs.list(dir)
  } catch (error) {
    if (error?.reason === "not-found") return []
    throw error
  }
}

/**
 * 写一条记录，返回 id（`<日期>/<目录名>`）。`entry`：{ kind: search | fetch, query, mode?, project?, by, result, pages? }，
 * `pages` 是 `[{ url, content }]`。顺带清理超过保留天数的日期目录。
 */
export async function write(deps, entry, retentionDays) {
  const now = deps.now()
  const date = new Date(now)
  const random = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")
  const name = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${slugOf(entry.query)}-${random}`
  const id = `${dayOf(now)}/${name}`
  const dir = `${root(deps)}/${id}`
  const query = {
    kind: entry.kind,
    query: entry.query,
    mode: entry.mode ?? null,
    project: entry.project ?? null,
    by: entry.by ?? { id: "user" },
    at: date.toISOString(),
  }
  await deps.fs.writeText(`${dir}/query.json`, JSON.stringify(query, null, 2) + "\n")
  await deps.fs.writeText(`${dir}/result.json`, JSON.stringify(entry.result, null, 2) + "\n")
  for (const [index, page] of (entry.pages ?? []).entries())
    await deps.fs.writeText(`${dir}/pages/${index + 1}.md`, `<!-- ${page.url} -->\n${page.content}`)
  await prune(deps, retentionDays)
  return id
}

/** 删掉早于保留天数的日期目录。 */
export async function prune(deps, retentionDays) {
  const oldest = dayOf(deps.now() - retentionDays * DAY_MS)
  for (const day of await listDir(deps, root(deps)))
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < oldest)
      await deps.fs.remove(`${root(deps)}/${day}`)
}

/** 记录 id 的合法形式（防止 `../` 跳出记录目录）。 */
const validId = (id) => /^\d{4}-\d{2}-\d{2}\/[^/\\]+$/.test(String(id ?? "")) && !String(id).includes("..")

/** 最近的记录摘要，新的在前。`project` 给出时只看该项目；`days` 限定天数；`limit` 条数上限。 */
export async function list(deps, { project, days, limit = 200 } = {}) {
  const since = days ? dayOf(deps.now() - days * DAY_MS) : ""
  const out = []
  const daysDesc = (await listDir(deps, root(deps))).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= since).reverse()
  for (const day of daysDesc) {
    for (const name of (await listDir(deps, `${root(deps)}/${day}`)).reverse()) {
      const query = await readJson(deps, `${root(deps)}/${day}/${name}/query.json`)
      if (!query) continue
      if (project && query.project?.root !== project) continue
      out.push({ id: `${day}/${name}`, ...query })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 同项目 30 天内问过的相同问题（规范化后相等或互相包含），只看搜索记录。 */
export async function find(deps, text, project) {
  const wanted = normalize(text)
  if (!wanted) return []
  const records = await list(deps, { project, days: FIND_DAYS })
  return records
    .filter((record) => record.kind === "search")
    .filter((record) => {
      const seen = normalize(record.query)
      return seen && (seen === wanted || seen.includes(wanted) || wanted.includes(seen))
    })
    .map(({ id, query, mode, by, at }) => ({ id, query, mode, by, at }))
}

/** 一条记录的全部内容：query、result、抓取正文。 */
export async function show(deps, id) {
  if (!validId(id)) throw new Error(`bad record id ${id}`)
  const dir = `${root(deps)}/${id}`
  const query = await readJson(deps, `${dir}/query.json`)
  if (!query) throw Object.assign(new Error(`record ${id} not found`), { reason: "not-found" })
  const pages = []
  const names = (await listDir(deps, `${dir}/pages`)).sort((a, b) => parseInt(a) - parseInt(b))
  for (const name of names) {
    const text = await deps.fs.readText(`${dir}/pages/${name}`)
    const [head, ...rest] = text.split("\n")
    const url = head.match(/^<!-- (.*) -->$/)?.[1] ?? ""
    pages.push({ url, content: url ? rest.join("\n") : text })
  }
  return { id, ...query, result: await readJson(deps, `${dir}/result.json`), pages }
}

/** 用新结果覆盖一条记录的 result.json（页面先出来源、再补 AI 回答）。返回 id。 */
export async function update(deps, id, result) {
  if (!validId(id)) throw new Error(`bad record id ${id}`)
  await deps.fs.writeText(`${root(deps)}/${id}/result.json`, JSON.stringify(result, null, 2) + "\n")
  return id
}

/** 给已有记录追加抓取正文（页面「抓全文」、save 时先抓）。返回页序号。 */
export async function addPage(deps, id, page) {
  if (!validId(id)) throw new Error(`bad record id ${id}`)
  const dir = `${root(deps)}/${id}`
  const count = (await listDir(deps, `${dir}/pages`)).length
  await deps.fs.writeText(`${dir}/pages/${count + 1}.md`, `<!-- ${page.url} -->\n${page.content}`)
  return count + 1
}

export async function remove(deps, id) {
  if (!validId(id)) throw new Error(`bad record id ${id}`)
  await deps.fs.remove(`${root(deps)}/${id}`)
}

/** 记录里已有的某网址正文（save 免得重抓）。 */
export async function pageFor(deps, url) {
  for (const record of await list(deps, { days: FIND_DAYS, limit: 500 })) {
    const full = await show(deps, record.id).catch(() => null)
    const page = full?.pages.find((item) => item.url === url)
    if (page) return page.content
  }
  return null
}
