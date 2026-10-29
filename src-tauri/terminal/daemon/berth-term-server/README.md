# berth-term-server

> **Private API.** Internal Berth terminal implementation; semver is not
> guaranteed inside `0.x`.

Tokio daemon and request dispatcher for the Berth terminal runtime. It owns
the in-memory sessions, windows, panes, and PTYs and serves the local IPC
protocol. Use `berth-term-sdk` for the stable client-facing API.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
