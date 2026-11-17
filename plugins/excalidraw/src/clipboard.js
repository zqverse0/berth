// 图库与改图复用同一条复制路径；沙箱禁用 Clipboard API 时退回浏览器复制命令。
export async function copyText(text, failureMessage) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const active = document.activeElement
    const area = document.createElement("textarea")
    area.value = text
    area.readOnly = true
    area.style.position = "fixed"
    area.style.left = "-9999px"
    document.body.append(area)
    try {
      area.select()
      if (!document.execCommand("copy")) throw new Error(failureMessage)
    } catch {
      throw new Error(failureMessage)
    } finally {
      area.remove()
      active?.focus({ preventScroll: true })
    }
  }
}
