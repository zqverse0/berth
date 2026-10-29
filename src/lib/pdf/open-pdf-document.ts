import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist"
import type { WorkspaceFileRef } from "@/lib/files/file-workspace-tab"
import { openPdfSource, type PdfSource } from "./pdf-source"
import { PDFJS_WORKER_URL, pdfDocumentAssetOptions } from "./pdfjs-assets"

export interface OpenPdfDocumentRequest {
  file: WorkspaceFileRef
  revision: number
  signal: AbortSignal
  requestPassword(
    reason: "need-password" | "incorrect-password"
  ): Promise<string | null>
}

export interface PdfDocumentSession {
  document: PDFDocumentProxy
  sourceVersion: string
  close(): Promise<void>
}

function guardPageRequests(document: PDFDocumentProxy): {
  close(): Promise<void>
} {
  const originalGetPage = document.getPage.bind(document)
  const pendingRequests = new Set<Promise<unknown>>()
  const guardedPages = new WeakSet<PDFPageProxy>()
  let closing = false

  const track = <Value>(request: Promise<Value>): Promise<Value> => {
    pendingRequests.add(request)
    void request
      .finally(() => pendingRequests.delete(request))
      .catch(() => undefined)
    return request
  }

  const guardPage = (page: PDFPageProxy): PDFPageProxy => {
    if (guardedPages.has(page)) return page
    guardedPages.add(page)

    const originalRender = page.render.bind(page)
    page.render = ((params: Parameters<PDFPageProxy["render"]>[0]) => {
      const task = originalRender(params)
      track(task.promise)
      return task
    }) as PDFPageProxy["render"]

    const originalGetTextContent = page.getTextContent.bind(page)
    page.getTextContent = ((
      params?: Parameters<PDFPageProxy["getTextContent"]>[0]
    ) =>
      track(originalGetTextContent(params))) as PDFPageProxy["getTextContent"]

    return page
  }

  document.getPage = ((pageNumber: number) => {
    if (closing) {
      return Promise.reject(new DOMException("Aborted", "AbortError"))
    }
    return track(originalGetPage(pageNumber).then(guardPage))
  }) as PDFDocumentProxy["getPage"]

  return {
    async close() {
      closing = true
      await Promise.allSettled(pendingRequests)
    },
  }
}

export async function openPdfDocument(
  request: OpenPdfDocumentRequest
): Promise<PdfDocumentSession> {
  return openPdfDocumentAttempt(request, true)
}

function isRetryableSourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /lease|source changed|unavailable|precondition|not found|404|410|412/i.test(
    message
  )
}

async function openPdfDocumentAttempt(
  request: OpenPdfDocumentRequest,
  allowRetry: boolean
): Promise<PdfDocumentSession> {
  if (request.signal.aborted) throw new DOMException("Aborted", "AbortError")
  const { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } =
    await import("pdfjs-dist")
  let source: PdfSource
  try {
    source = await openPdfSource(request.file)
  } catch (error) {
    if (
      allowRetry &&
      !request.signal.aborted &&
      isRetryableSourceError(error)
    ) {
      return openPdfDocumentAttempt(request, false)
    }
    throw error
  }

  let rangeError: unknown = null
  let failRangeLoad: ((error: unknown) => void) | null = null
  GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL

  let documentParams: Record<string, unknown>
  if (source.kind === "url") {
    documentParams = { url: source.url, ...pdfDocumentAssetOptions }
  } else if (source.kind === "data") {
    // Local desktop full-file buffer — avoid PDFDataRangeTransport over IPC.
    // Copy so PDF.js worker transfer does not detach our retained buffer.
    documentParams = {
      data: source.data.slice(),
      ...pdfDocumentAssetOptions,
    }
  } else if (source.kind === "range") {
    const rangeSource = source
    const rangeAbortController = new AbortController()
    class SourceRangeTransport extends PDFDataRangeTransport {
      requestDataRange(begin: number, end: number): void {
        void rangeSource.read(begin, end, rangeAbortController.signal).then(
          (bytes) => {
            if (!rangeAbortController.signal.aborted) {
              this.onDataRange(begin, bytes)
            }
          },
          (error) => {
            if (!rangeAbortController.signal.aborted) failRangeLoad?.(error)
          }
        )
      }

      abort(): void {
        rangeAbortController.abort()
      }
    }
    documentParams = {
      range: new SourceRangeTransport(rangeSource.length, null),
      length: rangeSource.length,
      disableStream: true,
      disableAutoFetch: true,
      rangeChunkSize: 256 * 1024,
      ...pdfDocumentAssetOptions,
    }
  } else {
    throw new Error("Unsupported PDF source kind")
  }

  const loadingTask: PDFDocumentLoadingTask = getDocument(documentParams)
  failRangeLoad = (error) => {
    rangeError = error
    void loadingTask.destroy()
  }
  const abortLoading = () => void loadingTask.destroy()
  request.signal.addEventListener("abort", abortLoading, { once: true })
  loadingTask.onPassword = (
    updatePassword: (password: string) => void,
    reason: number
  ) => {
    void request
      .requestPassword(reason === 1 ? "need-password" : "incorrect-password")
      .then((password) => {
        if (password === null) void loadingTask.destroy()
        else updatePassword(password)
      })
  }

  try {
    const document = await loadingTask.promise
    if (!document || typeof document.getPage !== "function") {
      throw new Error("PDF.js returned an invalid document object")
    }
    if (!document.numPages || document.numPages < 1) {
      throw new Error("PDF has no pages")
    }
    request.signal.removeEventListener("abort", abortLoading)
    const pageRequests = guardPageRequests(document)
    let closed = false
    return {
      document,
      sourceVersion: source.sourceVersion,
      async close() {
        if (closed) return
        closed = true
        await pageRequests.close()
        await Promise.resolve(loadingTask.destroy()).catch(() => undefined)
        await source.close()
      },
    }
  } catch (caught) {
    const error = rangeError ?? caught
    request.signal.removeEventListener("abort", abortLoading)
    await Promise.resolve(loadingTask.destroy()).catch(() => undefined)
    await source.close()
    if (
      allowRetry &&
      !request.signal.aborted &&
      isRetryableSourceError(error)
    ) {
      return openPdfDocumentAttempt(request, false)
    }
    throw error
  }
}
