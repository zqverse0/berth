# berth-term-os

Small OS abstraction layer used by Berth terminal IPC and runtime
integrations.

A thin, dependency-light wrapper around host introspection, process identity,
user identity, and terminal queries. Linux, macOS, and Windows are all
first-class — Windows uses native Win32 APIs rather than WSL.

## Surface

- `host` — OS host information.
- `identity` — process and user identity helpers.
- `process` — process control primitives.
- `terminal` — terminal queries.

Pull it in when you need the same OS-boundary primitives as the terminal
runtime; most users get them through the higher-level crates.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
