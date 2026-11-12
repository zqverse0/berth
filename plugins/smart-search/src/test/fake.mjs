// 测试替身：内存 fs、按 "METHOD url"（不含查询串）回放的 http，与 core 的 deps 同形。
import { readFileSync } from "node:fs"

export const fixtures = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"))

const notFound = (path) => Object.assign(new Error(`${path}: not found`), { reason: "not-found" })

export function memoryFs(files = {}) {
  const data = new Map(Object.entries(files))
  const modes = new Map()
  return {
    data,
    modes,
    readText: async (path) => {
      if (!data.has(path)) throw notFound(path)
      return data.get(path)
    },
    writeText: async (path, text, options) => {
      data.set(path, text)
      modes.set(path, options?.mode ?? 0o644)
    },
    list: async (dir) => {
      const names = new Set()
      for (const path of data.keys())
        if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split("/")[0])
      if (!names.size) throw notFound(dir)
      return [...names].sort()
    },
    remove: async (path) => {
      for (const key of [...data.keys()]) if (key === path || key.startsWith(`${path}/`)) data.delete(key)
    },
  }
}

export function replayHttp(responses) {
  const calls = []
  const reply = (spec) => {
    const key = `${spec.method ?? "GET"} ${spec.url.split("?")[0]}`
    calls.push({ key, spec })
    const found = responses[key]
    if (!found) throw Object.assign(new Error(`${key}: error sending request: connection refused`), { reason: "internal" })
    if (found.timeout) throw Object.assign(new Error(`${key}: operation timed out`), { reason: "internal" })
    return { status: found.status, headers: found.headers ?? {}, text: found.body }
  }
  return {
    calls,
    fetch: async (url, spec) => reply({ ...spec, url }),
    fetchAll: async (specs) =>
      specs.map((spec) => {
        try {
          return reply(spec)
        } catch (error) {
          return { error: { reason: error.reason, message: error.message } }
        }
      }),
  }
}

/** core 的 deps；`config` 是已保存的配置（等同 config.json）。 */
export function deps({ responses = {}, config = {}, files = {}, now = Date.parse("2026-11-11T15:02:33") } = {}) {
  const stateDir = "/state"
  const fs = memoryFs({ ...files, [`${stateDir}/config.json`]: JSON.stringify(config) })
  let clock = now
  return { http: replayHttp(responses), fs, stateDir, now: () => clock, tick: (ms) => (clock += ms) }
}

/** 去掉随时间变化的字段（elapsed_ms）。 */
export const stable = (value) =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === "elapsed_ms" ? undefined : item)))

/** 只比 JS 输出里也有的键（JS 去掉了 session_id、*_count、capability_status 等）。 */
export function common(js, py) {
  const out = {}
  for (const key of Object.keys(js)) if (key in py) out[key] = py[key]
  return stable(out)
}
