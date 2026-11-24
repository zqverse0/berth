# tauri-browser

A CLI + Tauri plugin for automating and inspecting Tauri apps. Ref-based element targeting with output designed for LLM consumption.

## Install the Skill

Add the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill to your project:

```sh
npx skills add thrashr888/tauri-browser
```

Or install globally:

```sh
npx skills add thrashr888/tauri-browser -g
```

## Install the CLI

```sh
cargo install tauri-browser
```

## Setup

Add the plugin to your Tauri app behind a feature flag:

```toml
# Cargo.toml
[dependencies]
tauri-plugin-debug-bridge = { version = "0.5", optional = true }

[features]
debug-bridge = ["tauri-plugin-debug-bridge"]
```

```rust
// src-tauri/src/lib.rs
#[cfg(feature = "debug-bridge")]
app.plugin(tauri_plugin_debug_bridge::init());
```

No capability configuration is needed as of plugin **0.4.1** — the plugin self-grants its `debug-bridge:default` permission at runtime (`add_capability`), so the eval callback works out of the box.

> On plugin **0.4.0 and earlier** you had to add `"debug-bridge:default"` to a capability file yourself — and a capability file referencing a feature-gated plugin breaks release builds that don't compile it (unknown permission). Upgrade instead.

Run your app with the feature enabled:

```sh
cargo tauri dev --features debug-bridge
```

## Authentication

The plugin generates a random auth token on each startup and writes a discovery file to `/tmp/tauri-debug-bridge/<app-identifier>.json`. The CLI reads this automatically — no token needed in your commands:

```sh
tauri-browser connect              # auto-discovers token
tauri-browser snapshot -i          # just works
```

When multiple Tauri apps are running, specify which one:

```sh
tauri-browser --app com.example.myapp connect
```

You can still pass the token explicitly if needed:

```sh
export TAURI_BROWSER_TOKEN="a1b2c3d4e5f6..."
tauri-browser connect

# Or per-command:
tauri-browser --token "a1b2c3d4e5f6..." connect
```

The `/health` endpoint does not require auth.

## Usage

```sh
tauri-browser connect                        # verify connection
tauri-browser snapshot -i                    # interactive elements with @refs
tauri-browser click "@e3"                    # click by ref
tauri-browser fill "@e2" "user@example.com"  # fill input by ref
tauri-browser run-js "document.title"        # execute JS
tauri-browser screenshot out.png             # capture screenshot
tauri-browser windows                        # list app windows
tauri-browser invoke get_data '{"id":1}'     # call Tauri commands
tauri-browser events emit "refresh" '{}'     # emit events
tauri-browser errors                         # JS errors + Rust panics, recent history
tauri-browser console                        # webview console history
tauri-browser logs --level warn              # Rust-side records, warn and above
```

`errors`, `console`, and `logs` print recent history and exit (`--follow` to
keep streaming). Records are kept in a ring **and** mirrored to
`/tmp/tauri-debug-bridge/<identifier>.log`, so they are still readable after
the app has crashed. Rust panics are captured automatically — the plugin
installs a panic hook — and an app can push its own failures in with
`tauri_plugin_debug_bridge::record(Level::Warn, "sweep", "…")`.

## Multiwebview windows

Windows that host extra webviews via `Window::add_child` (Tauri's `unstable`
multiwebview API — e.g. an embedded live web view) are fully supported as of
plugin **0.5.0**. `windows` lists every webview per window, and the webview
commands (`run-js`, `screenshot`, `snapshot`, `click`, `fill`, `invoke`) take
`-w/--window` to target one:

```sh
tauri-browser windows
# label: main
# webviews:
#   label: main         url: tauri://localhost
#   label: live-main    url: https://example.com/

tauri-browser run-js "document.title"                 # main webview (default)
tauri-browser run-js -w live-main "document.title"    # child, by its own label
tauri-browser screenshot -w main/live-main child.png  # window/webview form
```

Bare labels and the `window/webview` compound form both work; a wrong label
returns the list of addressable targets. Console streaming tags each message
with its source webview (`"webview":"live-main"`).

Two caveats:
- Register the plugin before windows gain child webviews (registering it on
  the `tauri::Builder`, or first thing in `setup`, is always safe). The bridge
  learns window topology from webview creation events.
- Child webviews showing **remote** URLs execute injected JS, but the result
  callback is blocked by Tauri's ACL for remote origins, so `run-js` against
  them times out. `screenshot` uses a native capture path and always works.

> On plugin **0.4.x and earlier**, a window with a child webview disappears
> from `windows` entirely and eval/screenshot fail with "window 'main' not
> found" — Tauri's `webview_windows()` only covers single-webview windows.
> Upgrade.

## Architecture

```
tauri-browser (CLI)  ◄──── HTTP/WS ────►  tauri-plugin-debug-bridge (in-app)
                         localhost:9229
```

The plugin starts a local HTTP+WS server inside your Tauri app.
The CLI talks to it. No app code changes needed beyond plugin registration.

## Troubleshooting

**401 Unauthorized on all requests**
The CLI auto-discovers the token from `/tmp/tauri-debug-bridge/`. If that fails, set `TAURI_BROWSER_TOKEN` to the token printed at app startup. The token changes every restart.

**Eval/invoke times out after 10-30s**
Tauri's ACL is blocking the `eval_callback` command, so results never return — while native ops (`screenshot`, `windows`) keep working, which makes it look half-broken. Plugin **0.4.1+** self-grants the permission at runtime; upgrade. On older plugins, add `"debug-bridge:default"` to your capabilities.

**Console streaming shows nothing**
Make sure you're on plugin version 0.2.5+ which includes `console_callback` in the default permission set. Earlier versions only permitted `eval_callback`.

**`windows` returns nothing / "window 'main' not found" while the app is clearly running**
The app added a child webview to a window (`Window::add_child`), which makes the window invisible to Tauri's `webview_windows()`. Fixed in plugin **0.5.0** — upgrade, then target child webviews with `-w <label>`.

**Port already in use**
Configure a different port (or `0` for auto-assign) in `tauri.conf.json`:
```json
{
  "plugins": {
    "debug-bridge": {
      "port": 0
    }
  }
}
```

The CLI discovers the actual port from the discovery file automatically.

## License

MIT
