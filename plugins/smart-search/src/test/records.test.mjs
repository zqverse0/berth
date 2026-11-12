import assert from "node:assert/strict"
import test from "node:test"

import * as records from "../../private/core/records.js"
import { deps } from "./fake.mjs"

const project = { id: "1", name: "p", root: "/p" }
const save = (d, query, extra = {}) =>
  records.write(d, { kind: "search", query, project, by: { id: "claude" }, result: { ok: true }, ...extra }, 90)

test("normalize folds case, full-width and punctuation", () => {
  assert.equal(records.normalize("  Ｔａｕｒｉ　2.0，最新版本？ "), "tauri 2 0 最新版本")
  assert.equal(records.slugOf("Tauri 2 最新稳定版本!"), "tauri-2-最新稳定版本")
})

test("find matches same project within 30 days, equal or containing", async () => {
  const d = deps()
  const first = await save(d, "Tauri 2 最新稳定版本")
  d.tick(1000)
  await save(d, "完全无关")
  await records.write(d, { kind: "search", query: "Tauri 2 最新稳定版本", project: { root: "/other" }, result: {} }, 90)
  await records.write(d, { kind: "fetch", query: "tauri 2", project, result: {} }, 90)
  assert.match(first, /^2026-11-11\/150233-tauri-2-最新稳定版本-[0-9a-f]{4}$/)
  const hits = await records.find(d, "tauri 2", "/p")
  assert.deepEqual(hits.map((hit) => hit.id), [first])
  assert.deepEqual(hits[0].by, { id: "claude" })
  assert.deepEqual((await records.find(d, "ＴＡＵＲＩ 2 最新稳定版本？", "/p")).length, 1)
  d.tick(31 * 86_400_000)
  assert.deepEqual(await records.find(d, "tauri 2", "/p"), [])
})

test("show, addPage, update and remove round-trip; ids cannot escape", async () => {
  const d = deps()
  const id = await save(d, "q", { pages: [{ url: "https://a.test", content: "# A\nbody" }] })
  assert.equal(await records.addPage(d, id, { url: "https://b.test", content: "B" }), 2)
  await records.update(d, id, { ok: true, content: "answer" })
  const shown = await records.show(d, id)
  assert.equal(shown.result.content, "answer")
  assert.deepEqual(shown.pages, [{ url: "https://a.test", content: "# A\nbody" }, { url: "https://b.test", content: "B" }])
  assert.equal(await records.pageFor(d, "https://b.test"), "B")
  await assert.rejects(records.show(d, "../config.json"))
  await records.remove(d, id)
  await assert.rejects(records.show(d, id), { reason: "not-found" })
})

test("writing prunes day folders older than the retention", async () => {
  const d = deps()
  await save(d, "old")
  d.tick(10 * 86_400_000)
  await records.write(d, { kind: "search", query: "new", project, result: {} }, 5)
  const days = await d.fs.list("/state/records")
  assert.deepEqual(days, ["2026-11-21"])
  assert.deepEqual((await records.list(d, { project: "/p" })).map((item) => item.query), ["new"])
})
