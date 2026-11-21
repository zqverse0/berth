// node --test plugins/excalidraw/src/test/history.test.mjs
import assert from "node:assert/strict"
import test from "node:test"

// 内存里的 berth.fs / storage，够 history.js 用
const files = new Map()
const notFound = (path) =>
  Object.assign(new Error(`not found: ${path}`), { reason: "not-found" })
globalThis.berth = {
  storage: { dir: "/state" },
  env: { vars: { PWD: "/p" } },
  fs: {
    readText: async (path) => {
      if (!files.has(path)) throw notFound(path)
      return files.get(path)
    },
    writeText: async (path, text) => void files.set(path, text),
    remove: async (path) => void files.delete(path),
  },
}
const { default: history } = await import("../../private/history.js")

const scene = (label) =>
  JSON.stringify({ type: "excalidraw", elements: [{ id: "a", text: label }] })
const drawing = "/p/figures/a.excalidraw"

test("request + apply keep the old version and the request text", async () => {
  files.clear()
  files.set(drawing, scene("v1"))
  await history({
    action: "request",
    path: drawing,
    text: "改成 v2",
    content: scene("v1"),
  })
  files.set("/tmp/new.excalidraw", scene("v2"))
  assert.equal(
    await history([
      "apply",
      "figures/a.excalidraw",
      "/tmp/new.excalidraw",
      "改了",
      "文字",
    ]),
    0
  )
  assert.equal(files.get(drawing), scene("v2"))
  const { versions, pending } = await history({ action: "list", path: drawing })
  assert.equal(pending, null)
  assert.deepEqual(
    versions.map(({ id, by, request, note }) => ({ id, by, request, note })),
    [
      { id: 2, by: "agent", request: "改成 v2", note: "改了 文字" },
      { id: 1, by: "before", request: undefined, note: undefined },
    ]
  )
  // 外部改写的内容已在记录里：不重复记
  await history({
    action: "snapshot",
    path: drawing,
    content: scene("v2"),
    by: "external",
  })
  assert.equal(
    (await history({ action: "list", path: drawing })).versions.length,
    2
  )
})

test("restore returns the old content and records the step", async () => {
  const { content } = await history({
    action: "restore",
    path: drawing,
    id: 1,
    content: scene("v2 手改"),
  })
  assert.equal(content, scene("v1"))
  const { versions } = await history({ action: "list", path: drawing })
  assert.deepEqual(
    versions.slice(0, 2).map(({ by, from }) => ({ by, from })),
    [
      { by: "restore", from: 1 },
      { by: "before", from: undefined },
    ]
  )
  assert.equal(
    (await history({ action: "get", path: drawing, id: versions[1].id }))
      .content,
    scene("v2 手改")
  )
})

test("apply rejects content that is not a scene and leaves the drawing alone", async () => {
  const before = files.get(drawing)
  await assert.rejects(
    history({ action: "apply", path: drawing, content: "{oops" }),
    /not valid JSON/
  )
  assert.equal(files.get(drawing), before)
})

test("keeps only the latest 100 versions", async () => {
  files.clear()
  for (let i = 0; i < 105; i++)
    await history({
      action: "snapshot",
      path: "/p/b.excalidraw",
      content: scene(`v${i}`),
    })
  const { versions } = await history({
    action: "list",
    path: "/p/b.excalidraw",
  })
  assert.equal(versions.length, 100)
  assert.equal(versions.at(-1).id, 6)
  assert.equal(
    [...files.keys()].filter((key) => key.endsWith("/1.excalidraw")).length,
    0
  )
})
