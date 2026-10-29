import { getTransport, isDesktop } from "@/lib/transport"

const MAX_LOCAL_RANGE_BYTES = 256 * 1024

export interface PdfFileRef {
  rootPath: string
  path: string
}

export type PdfSource =
  | {
      kind: "url"
      url: string
      length: number
      sourceVersion: string
      close(): Promise<void>
    }
  | {
      kind: "data"
      data: Uint8Array
      length: number
      sourceVersion: string
      close(): Promise<void>
    }
  | {
      kind: "range"
      length: number
      sourceVersion: string
      read(begin: number, end: number, signal: AbortSignal): Promise<Uint8Array>
      close(): Promise<void>
    }

/** Normalize Tauri binary invoke payloads into a Uint8Array for PDF.js. */
function coercePdfRangeBytes(result: unknown): Uint8Array {
  if (result instanceof Uint8Array) return result
  if (result instanceof ArrayBuffer) return new Uint8Array(result)
  if (ArrayBuffer.isView(result)) {
    const view = result as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  if (Array.isArray(result)) return Uint8Array.from(result as number[])
  throw new Error(
    `Unexpected PDF range payload type: ${Object.prototype.toString.call(result)}`
  )
}

async function openLocalRangeSource(file: PdfFileRef): Promise<PdfSource> {
  const transport = getTransport()
  const opened = await transport.call<{
    sourceId: string
    length: number
    sourceVersion: string
  }>("open_local_pdf_source", {
    rootPath: file.rootPath,
    path: file.path,
  })
  const length = opened.length
  if (!Number.isFinite(length) || length <= 0) {
    await transport
      .call("close_local_pdf_source", { sourceId: opened.sourceId })
      .catch(() => undefined)
    throw new Error(`Invalid PDF length: ${length}`)
  }
  const MAX_LOCAL_BYTES = 80 * 1024 * 1024
  if (length > MAX_LOCAL_BYTES) {
    await transport
      .call("close_local_pdf_source", { sourceId: opened.sourceId })
      .catch(() => undefined)
    throw new Error(
      `PDF is too large to preview in-app (${length} bytes). Open externally instead.`
    )
  }
  return {
    kind: "range",
    length,
    sourceVersion: opened.sourceVersion,
    async read(begin, end, signal) {
      const bytes = new Uint8Array(end - begin)
      for (
        let chunkBegin = begin;
        chunkBegin < end;
        chunkBegin += MAX_LOCAL_RANGE_BYTES
      ) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")
        const chunkEnd = Math.min(chunkBegin + MAX_LOCAL_RANGE_BYTES, end)
        const result = await transport.call("read_local_pdf_range", {
          sourceId: opened.sourceId,
          begin: chunkBegin,
          end: chunkEnd,
        })
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")
        const chunk = coercePdfRangeBytes(result)
        if (chunk.byteLength !== chunkEnd - chunkBegin) {
          throw new Error(
            `PDF range size mismatch: expected ${chunkEnd - chunkBegin}, got ${chunk.byteLength}`
          )
        }
        bytes.set(chunk, chunkBegin - begin)
      }
      return bytes
    },
    async close() {
      await transport
        .call("close_local_pdf_source", { sourceId: opened.sourceId })
        .catch(() => undefined)
    },
  }
}

export async function openPdfSource(file: PdfFileRef): Promise<PdfSource> {
  if (!isDesktop()) {
    throw new Error("PDF preview requires the Berth desktop app")
  }
  return openLocalRangeSource(file)
}
