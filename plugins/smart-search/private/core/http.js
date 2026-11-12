// 服务商请求：入口注入的 http（berth.http 或测试替身）。请求描述与响应解析分开，路由才能用
// fetchAll 并发；错误归成原 CLI 的 error_type（timeout / rate_limited / auth_error / …）。

export class ProviderError extends Error {
  constructor(type, message, status) {
    super(message)
    this.type = type
    this.status = status
  }
}

/** 一个请求（`http.fetch` / `fetchAll` 的参数）。`json` 给出时按 JSON 发送。 */
export function request(
  url,
  { method = "POST", headers = {}, json, timeoutMs, retry } = {}
) {
  return {
    url,
    method,
    headers:
      json === undefined
        ? headers
        : { "Content-Type": "application/json", ...headers },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(retry ? { retry } : {}),
  }
}

const REASONS = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

/** 非 2xx → ProviderError（类型按状态码，消息形如 `HTTP 429: Too Many Requests`）。 */
export function check(response, { detail = false } = {}) {
  const { status } = response
  if (status >= 200 && status < 300) return response
  const type =
    status === 429
      ? "rate_limited"
      : status === 401 || status === 403
        ? "auth_error"
        : detail && (status === 400 || status === 422)
          ? "parameter_error"
          : "network_error"
  const body = detail ? response.text.trim().slice(0, 500) : ""
  throw new ProviderError(
    type,
    `HTTP ${status}: ${REASONS[status] ?? ""}${body ? ` - ${body}` : ""}`,
    status
  )
}

export const json = (response, options) =>
  JSON.parse(check(response, options).text)

/** 宿主抛的错误或 ProviderError → `{error_type, error}`。取消不在这里吞掉。 */
export function errorOf(error) {
  if (error?.reason === "cancelled") throw error
  if (error instanceof ProviderError)
    return { error_type: error.type, error: error.message }
  const message = String(error?.message ?? error)
  if (/timed out|timeout/i.test(message))
    return { error_type: "timeout", error: "request timed out" }
  if (error?.reason === "internal")
    return { error_type: "network_error", error: message }
  return { error_type: "runtime_error", error: message }
}

/** 发一个请求并解析；`fetchAll` 的单项错误转成抛出，调用方统一 catch。 */
export const send = (deps, spec) => deps.http.fetch(spec.url, spec)

export async function sendAll(deps, specs) {
  if (!specs.length) return []
  const replies = await deps.http.fetchAll(specs)
  return replies.map((reply) =>
    reply.error
      ? Object.assign(new Error(reply.error.message), {
          reason: reply.error.reason,
        })
      : reply
  )
}
