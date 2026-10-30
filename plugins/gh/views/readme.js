// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// README 详情：gh 取原文，相对路径的图片与链接指回 GitHub。

import { gh, repoName, strings } from "./common.js"

/** @type {import("berth").ViewHooks} */
export default {
  async render(req) {
    const repo = repoName(req.params.repo)
    let markdown
    try {
      markdown = await gh([
        "api",
        `repos/${repo}/readme`,
        "-H",
        "Accept: application/vnd.github.raw",
      ])
    } catch (error) {
      if (!/404|Not Found/.test(String(error))) throw error
      markdown = strings(req.locale).noReadme
    }
    return { type: "detail", title: repo, markdown: absolutize(markdown, repo) }
  },
}

/** 相对地址：图片指向 raw，链接指向 blob。 */
function absolutize(
  /** @type {string} */ markdown,
  /** @type {string} */ repo
) {
  const relative = (/** @type {string} */ url) =>
    !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)
  const raw = (/** @type {string} */ url) =>
    `https://raw.githubusercontent.com/${repo}/HEAD/${url.replace(/^\.?\//, "")}`
  const blob = (/** @type {string} */ url) =>
    `https://github.com/${repo}/blob/HEAD/${url.replace(/^\.?\//, "")}`
  return markdown
    .replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (all, head, url) =>
      relative(url) ? head + raw(url) : all
    )
    .replace(/((?<!!)\[[^\]]*\]\()([^)\s]+)/g, (all, head, url) =>
      relative(url) ? head + blob(url) : all
    )
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)/gi, (all, head, url) =>
      relative(url) ? head + raw(url) : all
    )
}
