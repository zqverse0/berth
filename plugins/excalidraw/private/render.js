// berth tools run excalidraw private/render.js <画板文件> <输出.png>
// 让 Berth 窗口里的 Excalidraw 页面把画板导出成白底 PNG，Agent 读这张图自检。要求 Berth 开着。

import { absolute } from "./paths.js"

export default async function render([file, out]) {
  if (!file || !out) {
    console.error(
      "usage: berth tools run excalidraw private/render.js <drawing.excalidraw> <out.png>"
    )
    return 2
  }
  try {
    const result = await berth.editor.render(absolute(file), {
      format: "png",
      out: absolute(out),
    })
    console.log(`${result.out} (${result.bytes} bytes)`)
    return 0
  } catch (error) {
    console.error(`render failed: ${error.message}`)
    return 1
  }
}
