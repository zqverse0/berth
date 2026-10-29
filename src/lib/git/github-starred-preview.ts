import { VIRTUAL_PREVIEW_ROOT } from "@/lib/files/file-open-target"

export const GITHUB_STARRED_PREVIEW_ID_PREFIX = "github-starred:"

export interface GithubStarredPreviewMeta {
  full_name: string
  name: string
  html_url: string
  clone_url: string | null
}

const previewMeta = new Map<string, GithubStarredPreviewMeta>()

export function githubStarredPreviewId(fullName: string): string {
  return `${GITHUB_STARRED_PREVIEW_ID_PREFIX}${fullName}`
}

export function rememberGithubStarredPreview(repo: {
  full_name: string
  name: string
  html_url: string
  clone_url?: string | null
}): GithubStarredPreviewMeta {
  const meta: GithubStarredPreviewMeta = {
    full_name: repo.full_name,
    name: repo.name,
    html_url: repo.html_url,
    clone_url: repo.clone_url ?? null,
  }
  previewMeta.set(githubStarredPreviewId(repo.full_name), meta)
  return meta
}

export function githubStarredPreviewIdFromPath(
  path: string | null | undefined
): string | null {
  if (!path) return null
  const encoded = path.split(`${VIRTUAL_PREVIEW_ROOT}/`)[1]?.split("/")[0]
  if (!encoded) return null
  const id = decodeURIComponent(encoded)
  return id.startsWith(GITHUB_STARRED_PREVIEW_ID_PREFIX) ? id : null
}

export function githubStarredPreviewMetaFromPath(
  path: string | null | undefined
): GithubStarredPreviewMeta | null {
  const id = githubStarredPreviewIdFromPath(path)
  if (!id) return null
  const remembered = previewMeta.get(id)
  if (remembered) return remembered
  const fullName = id.slice(GITHUB_STARRED_PREVIEW_ID_PREFIX.length)
  if (!fullName.includes("/")) return null
  const name = fullName.split("/")[1] ?? fullName
  return {
    full_name: fullName,
    name,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
  }
}

export function isGithubStarredPreviewPath(
  path: string | null | undefined
): boolean {
  return githubStarredPreviewIdFromPath(path) != null
}

/**
 * 将 GitHub README 中的相对资源路径（图片、链接）补全为绝对 GitHub CDN / 网页 URL，
 * 确保在本地虚拟只读阅读区渲染时图片不裂开、链接可正常外部访问。
 */
export function resolveGithubReadmeRelativeUrls(
  markdown: string,
  repoFullName: string,
  branch = "HEAD"
): string {
  if (!markdown || !repoFullName) return markdown

  const rawBase = `https://raw.githubusercontent.com/${repoFullName}/${branch}/`
  const blobBase = `https://github.com/${repoFullName}/blob/${branch}/`

  const isAbsoluteOrAnchor = (url: string): boolean =>
    /^(?:[a-z+.-]+:|\/\/|#)/i.test(url.trim())

  const cleanPath = (url: string): string => url.trim().replace(/^\.?\/+/, "")

  // 1. 处理 Markdown 图片: ![alt](url "title")
  let processed = markdown.replace(
    /!\[(.*?)\]\((<)?([^)\s>]+)(>)?(\s+["'][^"']*["'])?\)/g,
    (match, alt, openAngle, url, closeAngle, title) => {
      if (isAbsoluteOrAnchor(url)) return match
      const fullUrl = `${rawBase}${cleanPath(url)}`
      const open = openAngle ?? ""
      const close = closeAngle ?? ""
      const t = title ?? ""
      return `![${alt}](${open}${fullUrl}${close}${t})`
    }
  )

  // 2. 处理 HTML <img> 标签中的 src
  processed = processed.replace(
    /(<img\b[^>]*?\bsrc=["'])([^"'>\s]+)(["'][^>]*>)/gi,
    (match, prefix, src, suffix) => {
      if (isAbsoluteOrAnchor(src)) return match
      return `${prefix}${rawBase}${cleanPath(src)}${suffix}`
    }
  )

  // 3. 处理 HTML <source> 标签中的 srcset
  processed = processed.replace(
    /(<source\b[^>]*?\bsrcset=["'])([^"'>\s]+)(["'][^>]*>)/gi,
    (match, prefix, srcset, suffix) => {
      if (isAbsoluteOrAnchor(srcset)) return match
      return `${prefix}${rawBase}${cleanPath(srcset)}${suffix}`
    }
  )

  // 4. 处理 Markdown 相对超链接: [text](url)（但不匹配图片，前面非 !）
  processed = processed.replace(
    /(^|[^\!])\[(.*?)\]\((<)?([^)\s>]+)(>)?(\s+["'][^"']*["'])?\)/g,
    (match, prefix, text, openAngle, url, closeAngle, title) => {
      if (isAbsoluteOrAnchor(url)) return match
      const fullUrl = `${blobBase}${cleanPath(url)}`
      const open = openAngle ?? ""
      const close = closeAngle ?? ""
      const t = title ?? ""
      return `${prefix}[${text}](${open}${fullUrl}${close}${t})`
    }
  )

  // 5. 处理 HTML <a> 标签中的 href
  processed = processed.replace(
    /(<a\b[^>]*?\bhref=["'])([^"'>\s]+)(["'][^>]*>)/gi,
    (match, prefix, href, suffix) => {
      if (isAbsoluteOrAnchor(href)) return match
      return `${prefix}${blobBase}${cleanPath(href)}${suffix}`
    }
  )

  return processed
}
