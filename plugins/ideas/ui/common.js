// @ts-check
// 侧栏（app.js）与编辑页（editor.js）共用。

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node | string | null)[]} [children]
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value)
    else if (value === true) el.setAttribute(key, "")
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  for (const child of children) if (child != null) el.append(child)
  return el
}

const STATUS_EN = /** @type {Record<string, string>} */ ({
  待讨论: "To discuss",
  讨论中: "Discussing",
  已落地: "Landed",
  已放下: "Dropped",
})

/**
 * @param {string} status 文件里存的中文状态
 * @param {string} locale
 */
export const statusLabel = (status, locale) =>
  locale.startsWith("zh") ? status : (STATUS_EN[status] ?? status)

/** id `2026-10-11-191324` 是本地创建时间。 @param {string} id */
export function ideaDate(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}
