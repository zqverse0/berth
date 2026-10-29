# berth-term-sdk

Public, daemon-backed Rust SDK for the Berth terminal runtime.

Drives sessions, windows, and panes through typed handles over local IPC — no
TTY scraping and no string-formatted commands. Snapshots, send-keys,
wait-for-text, output streams, and `EnsureSession` bootstrap are the primary
primitives.

## Usage

```toml
[dependencies]
berth-term-sdk = "0.29.9"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

```rust
use berth_term_sdk::{EnsureSession, EnsureSessionPolicy, Terminal, SessionName};

#[tokio::main]
async fn main() -> berth_term_sdk::Result<()> {
    let terminal = Terminal::builder().connect_or_start().await?;
    let session = terminal
        .ensure_session(
            EnsureSession::named(SessionName::new("work").unwrap())
                .policy(EnsureSessionPolicy::CreateOrReuse)
                .detached(true),
        )
        .await?;

    let pane = session.pane(0, 0);
    pane.send_text("printf 'ready\\n'\\n").await?;
    pane.wait_for_text("ready").await?;

    let logs = session.new_window_with().name("logs").detached(true).await?;
    assert!(logs.exists().await?);

    let snapshot = pane.snapshot().await?;
    println!("{}x{}", snapshot.cols, snapshot.rows);
    Ok(())
}
```

## Surface

- `Terminal::builder().connect_or_start()` — reuse a running daemon or spawn one.
- `EnsureSession` — idempotent session bootstrap.
- Typed handles: `Session`, `Window`, `Pane`.
- `Session::window(index)` — lazy handle for a window slot;
  `Session::new_window()` creates one now.
- `Pane::send_text`, `Pane::wait_for_text`, `Pane::snapshot`, plus streams and
events for incremental output.

The SDK is a peer of the local IPC layer, not a wrapper around daemon
implementation crates.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
