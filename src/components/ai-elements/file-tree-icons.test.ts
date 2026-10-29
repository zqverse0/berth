import { describe, expect, it } from "vitest"
import { getFileIconConfig, getFolderIconConfig } from "./file-tree-icons"
import {
  BookOpen,
  Code2,
  Container,
  FileArchive,
  FileCode2,
  FileIcon,
  FileImage,
  FileLock2,
  FileSliders,
  FileText,
  FolderArchive,
  FolderCheck,
  FolderCode,
  FolderGit2,
  FolderIcon,
  FolderOpenIcon,
  FolderRoot,
  GitBranch,
  KeyRound,
  Package,
  Palette,
  Scale,
  SquareTerminal,
} from "lucide-react"

describe("getFileIconConfig", () => {
  it("resolves exact file names correctly", () => {
    expect(getFileIconConfig("package.json").icon).toBe(Package)
    expect(getFileIconConfig("Cargo.toml").icon).toBe(Package)
    expect(getFileIconConfig("pnpm-lock.yaml").icon).toBe(FileLock2)
    expect(getFileIconConfig("tsconfig.json").icon).toBe(FileSliders)
    expect(getFileIconConfig(".gitignore").icon).toBe(GitBranch)
    expect(getFileIconConfig("Dockerfile").icon).toBe(Container)
    expect(getFileIconConfig("LICENSE").icon).toBe(Scale)
    expect(getFileIconConfig("README.md").icon).toBe(BookOpen)
  })

  it("resolves .env files with variants", () => {
    expect(getFileIconConfig(".env").icon).toBe(KeyRound)
    expect(getFileIconConfig(".env.local").icon).toBe(KeyRound)
    expect(getFileIconConfig(".env.production").icon).toBe(KeyRound)
  })

  it("resolves common programming languages", () => {
    expect(getFileIconConfig("app.ts").icon).toBe(FileCode2)
    expect(getFileIconConfig("page.tsx").icon).toBe(Code2)
    expect(getFileIconConfig("script.js").icon).toBe(FileCode2)
    expect(getFileIconConfig("main.rs").icon).toBe(FileCode2)
    expect(getFileIconConfig("train.py").icon).toBe(FileCode2)
    expect(getFileIconConfig("server.go").icon).toBe(FileCode2)
    expect(getFileIconConfig("build.sh").icon).toBe(SquareTerminal)
  })

  it("resolves styles, media, and docs", () => {
    expect(getFileIconConfig("global.css").icon).toBe(Palette)
    expect(getFileIconConfig("logo.png").icon).toBe(FileImage)
    expect(getFileIconConfig("doc.md").icon).toBe(FileText)
    expect(getFileIconConfig("archive.tar.gz").icon).toBe(FileArchive)
  })

  it("falls back to default icon for unknown extensions", () => {
    const unknown = getFileIconConfig("unknown.xyz123")
    expect(unknown.icon).toBe(FileIcon)
  })
})

describe("getFolderIconConfig", () => {
  it("resolves special directories", () => {
    expect(getFolderIconConfig(".git").icon).toBe(FolderGit2)
    expect(getFolderIconConfig("node_modules").icon).toBe(FolderArchive)
    expect(getFolderIconConfig("src").icon).toBe(FolderCode)
    expect(getFolderIconConfig("docs").icon).toBe(FolderRoot)
    expect(getFolderIconConfig("tests").icon).toBe(FolderCheck)
  })

  it("falls back to default folder icon for normal folders", () => {
    const normal = getFolderIconConfig("my-folder")
    expect(normal.icon).toBe(FolderIcon)
    expect(normal.openIcon).toBe(FolderOpenIcon)
  })
})
