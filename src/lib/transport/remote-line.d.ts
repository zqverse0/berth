export interface RemoteSessionOptions {
  url(path: string): string | Promise<string>
  deliver(
    channel: number,
    packet: { index: number; message: ArrayBuffer }
  ): void
  alive(channel: number): boolean
  onEvent(name: string, payload: unknown): void
  onReset(): void
  onState?(open: boolean, error: unknown): void
  notice(text: string): void
}

export interface RemoteSession {
  call<T>(
    cmd: string,
    payload: unknown,
    headers?: Record<string, string>
  ): Promise<T>
  setEvents(names: string[]): void
  log(text: string): void
  readonly open: boolean
}

export function createRemoteSession(
  options: RemoteSessionOptions
): RemoteSession
