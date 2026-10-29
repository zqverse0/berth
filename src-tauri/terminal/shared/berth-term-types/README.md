# berth-term-types

Shared platform-neutral value types for the Berth terminal workspace.

This crate holds the small, dependency-free primitives used across the public
SDK surface and internal runtime crates without adding dependencies to the
graph.

## Surface

- `TerminalSize { cols: u16, rows: u16 }` and associated constructors.

Most users get these primitives through `berth-term-sdk` or
`berth-term-proto` rather than depending on this crate directly.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
