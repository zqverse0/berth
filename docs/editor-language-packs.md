# Editor language support

Berth uses two language-support tiers for CodeMirror 6.

## Built-in languages

Common parsers are bundled as separate lazy chunks and load automatically only
when a matching file is opened. They do not appear in Settings and require no
installation or network access.

Built-in support covers JSON, JavaScript/TypeScript/JSX/TSX, HTML, CSS,
Markdown/MDX, Python, Rust, YAML, and SQL.

## npm extension language packs

Settings → Appearance searches the public npm registry for packages carrying
the `berth-language-pack` keyword and using a `berth-language-*` package name.
Berth downloads the npm tarball itself; users do not need Node.js and Berth
never runs npm or package lifecycle scripts.

A compatible package declares this field in `package.json`:

```json
{
  "name": "berth-language-example",
  "version": "1.0.0",
  "keywords": ["berth-language-pack"],
  "berthLanguagePack": {
    "id": "example",
    "displayName": "Example",
    "extensions": [".example"],
    "languageIds": ["example"],
    "entry": "dist/language.mjs",
    "editorApiVersion": 1
  }
}
```

The entry must be a prebuilt, browser-compatible single ESM file exporting a
Lezer parser as `parser` or the default export. It must not require package
resolution at runtime, include another CodeMirror state/view runtime, or use
install scripts.

Installation performs these checks before an atomic rename:

- npm `sha512` integrity
- compressed limit of 8 MiB
- expanded limit of 16 MiB and 64 regular files
- safe npm archive and entry paths
- safe language ID
- editor API compatibility
- entry presence and post-install SHA-256

Installed packages live under
`BERTH_DATA_DIR/editor-language-packs/<language-id>/`. A downloaded parser has
priority over a matching built-in parser. If it is missing, disabled, or
invalid, Berth falls back to the built-in parser and then plain text.

Language packages execute parser code inside the application renderer. Users
should install only packages whose publisher and source they trust; npm
integrity protects transport integrity, not publisher intent.
