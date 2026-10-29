# berth-term-ipc

Local IPC endpoint and transport primitives for the Berth terminal runtime.

Resolves where the daemon listens (Unix domain socket on Linux and macOS,
named pipe on Windows) and provides the listener / stream types used by the
daemon and clients. Strictly local — no network listener is ever opened.

## Surface

- `LocalEndpoint` — platform-neutral endpoint descriptor.
- `default_endpoint`, `endpoint_for_label`, `resolve_endpoint` — endpoint discovery.
- `LocalListener` — bind a daemon socket / named pipe.
- Stream types — async I/O bridges used by the daemon and SDK.

Most callers reach `berth-term-ipc` through `berth-term-sdk` rather than
depending on it directly.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
