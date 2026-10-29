# berth-term-pty

> **Private API.** Internal Berth terminal implementation; semver is not
> guaranteed inside `0.x`.

PTY allocation, resize, and child-process control used by the terminal daemon.
Native Unix PTYs on Linux and macOS, native ConPTY on Windows, together with
named pipes for local IPC.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
