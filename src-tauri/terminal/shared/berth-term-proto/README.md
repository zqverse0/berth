# berth-term-proto

Detached IPC protocol DTOs, framing, and wire-safe errors for the Berth
terminal runtime.

Defines the local wire protocol used by clients to talk to the daemon. All
DTOs are platform-neutral, bincode-encoded, and framed by a single envelope:

```
magic byte      0x52
wire version    varint (LEB128)
payload length  little-endian u32
payload         bincode v1 DTO
```

The crate currently emits detached RPC wire version 2. It also ships the
`V1_FRAME_LEDGER`, the first stable ledger of frame-kind IDs and bincode tags.
Breaking wire changes bump the envelope varint; compatible DTO additions
append ledger entries rather than mutating existing frame IDs.

## Surface

- `BERTH_TERM_FRAME_MAGIC = 0x52`, `BERTH_TERM_WIRE_VERSION = 2`, `V1_FRAME_LEDGER`.
- `encode_frame`, `decode_frame`, `FrameDecoder`.
- Request, response, attach, control, capability DTOs.
- `PaneId`, `SessionId`, `SessionName`, `WindowId` identity types.
- `TerminalError` — wire-safe error type.

`berth-term-proto` is the source of truth for the detached wire format.
Anything that needs to encode or decode frames depends on it directly.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
