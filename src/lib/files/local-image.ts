import { readFileBase64 } from "@/lib/api"

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

// ponytail: 会话级缓存不失效、不限量；图片频繁改动或文档图片极多时再加 LRU / 按 mtime 失效
const localImageCache = new Map<string, Promise<string | null>>()

/** 读本地图片为 data URL；块部件滚动重挂时命中缓存不闪烁。 */
export function loadLocalImageDataUrl(absPath: string): Promise<string | null> {
  const cached = localImageCache.get(absPath)
  if (cached) return cached
  const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
  const pending = readFileBase64(absPath).then(
    (b64) => `data:${MIME_BY_EXT[ext] ?? "image/png"};base64,${b64}`,
    () => {
      localImageCache.delete(absPath)
      return null
    }
  )
  localImageCache.set(absPath, pending)
  return pending
}
