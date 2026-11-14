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

export function imageMimeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "image/png"
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/** 读本地图片为 Blob；显示方自己 createObjectURL，并在不显示时 revoke。 */
export async function readLocalImageBlob(absPath: string): Promise<Blob> {
  return base64ToBlob(await readFileBase64(absPath), imageMimeForPath(absPath))
}

// markdown 图片跨文档共享，用 data URL：淘汰只删条目，仍在显示的图由 GC 兜底，不会裂图。
// 按总字符数限量（data URL 每字符约占 1 字节以上），单张超过上限的不进缓存。
// ponytail: 不按 mtime 失效；图片频繁改动时再加
const LOCAL_IMAGE_CACHE_MAX_CHARS = 64 * 1024 * 1024
type CacheEntry = { pending: Promise<string | null>; chars: number }
const localImageCache = new Map<string, CacheEntry>()
let cachedChars = 0

function dropCached(key: string) {
  const entry = localImageCache.get(key)
  if (!entry) return
  cachedChars -= entry.chars
  localImageCache.delete(key)
}

/** 读本地图片为 data URL；块部件滚动重挂时命中缓存不闪烁。 */
export function loadLocalImageDataUrl(absPath: string): Promise<string | null> {
  const cached = localImageCache.get(absPath)
  if (cached) {
    localImageCache.delete(absPath)
    localImageCache.set(absPath, cached)
    return cached.pending
  }
  const entry: CacheEntry = { pending: Promise.resolve(null), chars: 0 }
  entry.pending = readFileBase64(absPath).then(
    (b64) => {
      const url = `data:${imageMimeForPath(absPath)};base64,${b64}`
      // 读取期间已被淘汰的不再记账
      if (localImageCache.get(absPath) !== entry) return url
      if (url.length > LOCAL_IMAGE_CACHE_MAX_CHARS) {
        localImageCache.delete(absPath)
        return url
      }
      entry.chars = url.length
      cachedChars += url.length
      for (const key of localImageCache.keys()) {
        if (cachedChars <= LOCAL_IMAGE_CACHE_MAX_CHARS) break
        if (key !== absPath) dropCached(key)
      }
      return url
    },
    () => {
      if (localImageCache.get(absPath) === entry)
        localImageCache.delete(absPath)
      return null
    }
  )
  localImageCache.set(absPath, entry)
  return entry.pending
}
