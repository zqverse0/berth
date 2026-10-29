export type UnsubscribeFn = () => void

/**
 * Optional request tuning for commands that have a longer native deadline.
 * Tauri IPC itself does not impose a client-side timeout, but the option stays
 * at the domain boundary so long-running calls keep one typed call shape.
 */
export interface CallOptions {
  timeoutMs?: number
}

/**
 * The single renderer-to-desktop transport boundary.
 *
 * This is intentionally small: the product has one Tauri runtime, so remote
 * HTTP/WS configuration and reconnect/attach protocols do not belong here.
 */
export interface Transport {
  /** Invoke a registered Tauri command. */
  call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T>

  /** Invoke a command with an opaque byte body when the command supports it. */
  callRaw?<T>(
    command: string,
    body: Uint8Array,
    headers: Record<string, string>
  ): Promise<T>

  /** Subscribe to a Tauri event and return a synchronous cleanup function. */
  subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn>

  /** Whether the current renderer is running inside the desktop shell. */
  isDesktop(): boolean

  /** Test-only cache cleanup hook for transports that own resources. */
  destroy?(): void
}
