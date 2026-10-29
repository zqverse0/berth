import type { ComponentType, SVGProps } from "react"
import {
  BookOpen,
  Braces,
  Code2,
  CodeXml,
  Container,
  Database,
  FileArchive,
  FileAudio,
  FileCode2,
  FileDigit,
  FileIcon,
  FileImage,
  FileLock2,
  FileSliders,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
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
  Sliders,
  SquareTerminal,
} from "lucide-react"

export type LucideIconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { className?: string; size?: number | string }
>

export interface IconStyleConfig {
  icon: LucideIconComponent
  openIcon?: LucideIconComponent
  colorClass: string
}

/**
 * Maps exact lower-cased file names to specialized icon configurations.
 */
const EXACT_FILE_NAME_MAP: Record<string, IconStyleConfig> = {
  "package.json": {
    icon: Package,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  "package-lock.json": {
    icon: FileLock2,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  "pnpm-lock.yaml": {
    icon: FileLock2,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  "yarn.lock": {
    icon: FileLock2,
    colorClass: "text-blue-700 dark:text-blue-400",
  },
  "cargo.toml": {
    icon: Package,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  "cargo.lock": {
    icon: FileLock2,
    colorClass: "text-orange-700 dark:text-orange-500",
  },
  "tsconfig.json": {
    icon: FileSliders,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  "tsconfig.node.json": {
    icon: FileSliders,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  "jsconfig.json": {
    icon: FileSliders,
    colorClass: "text-yellow-600 dark:text-yellow-400",
  },
  ".gitignore": {
    icon: GitBranch,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  ".gitmodules": {
    icon: GitBranch,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  ".gitattributes": {
    icon: GitBranch,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  dockerfile: {
    icon: Container,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  "docker-compose.yml": {
    icon: Container,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  "docker-compose.yaml": {
    icon: Container,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  license: {
    icon: Scale,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  "license.md": {
    icon: Scale,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  "license.txt": {
    icon: Scale,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  "readme.md": {
    icon: BookOpen,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  readme: {
    icon: BookOpen,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  "tauri.conf.json": {
    icon: FileSliders,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  "components.json": {
    icon: FileSliders,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  "vite.config.ts": {
    icon: FileSliders,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  "vite.config.js": {
    icon: FileSliders,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  "next.config.ts": {
    icon: FileSliders,
    colorClass: "text-slate-700 dark:text-slate-300",
  },
  "next.config.js": {
    icon: FileSliders,
    colorClass: "text-slate-700 dark:text-slate-300",
  },
  "next.config.mjs": {
    icon: FileSliders,
    colorClass: "text-slate-700 dark:text-slate-300",
  },
}

/**
 * Maps file extension to specialized icon configurations.
 */
const EXTENSION_MAP: Record<string, IconStyleConfig> = {
  // TypeScript & React
  ts: {
    icon: FileCode2,
    colorClass: "text-[#3178c6] dark:text-[#58a6ff]",
  },
  tsx: {
    icon: Code2,
    colorClass: "text-[#23b3eb] dark:text-[#61dafb]",
  },
  // JavaScript & React
  js: {
    icon: FileCode2,
    colorClass: "text-[#d49a00] dark:text-[#f1e05a]",
  },
  jsx: {
    icon: Code2,
    colorClass: "text-[#23b3eb] dark:text-[#61dafb]",
  },
  mjs: {
    icon: FileCode2,
    colorClass: "text-[#d49a00] dark:text-[#f1e05a]",
  },
  cjs: {
    icon: FileCode2,
    colorClass: "text-[#d49a00] dark:text-[#f1e05a]",
  },
  // Systems & backend
  rs: {
    icon: FileCode2,
    colorClass: "text-[#e43717] dark:text-[#f34b28]",
  },
  py: {
    icon: FileCode2,
    colorClass: "text-[#3572A5] dark:text-[#54a3ff]",
  },
  pyc: {
    icon: FileDigit,
    colorClass: "text-muted-foreground/60",
  },
  go: {
    icon: FileCode2,
    colorClass: "text-[#00ADD8] dark:text-[#29beb0]",
  },
  c: {
    icon: FileCode2,
    colorClass: "text-[#555555] dark:text-[#a0a0a0]",
  },
  cpp: {
    icon: FileCode2,
    colorClass: "text-[#f34b7d] dark:text-[#f34b7d]",
  },
  h: {
    icon: FileCode2,
    colorClass: "text-[#a074c4] dark:text-[#a074c4]",
  },
  hpp: {
    icon: FileCode2,
    colorClass: "text-[#a074c4] dark:text-[#a074c4]",
  },
  java: {
    icon: FileCode2,
    colorClass: "text-[#b07219] dark:text-[#e08b26]",
  },
  kt: {
    icon: FileCode2,
    colorClass: "text-[#A97BFF] dark:text-[#A97BFF]",
  },
  kts: {
    icon: FileCode2,
    colorClass: "text-[#A97BFF] dark:text-[#A97BFF]",
  },
  rb: {
    icon: FileCode2,
    colorClass: "text-[#701516] dark:text-[#ea4335]",
  },
  php: {
    icon: FileCode2,
    colorClass: "text-[#4F5D95] dark:text-[#777bb4]",
  },
  swift: {
    icon: FileCode2,
    colorClass: "text-[#F05138] dark:text-[#F05138]",
  },
  dart: {
    icon: FileCode2,
    colorClass: "text-[#00B4AB] dark:text-[#00B4AB]",
  },
  // Web markup & styling
  html: {
    icon: CodeXml,
    colorClass: "text-[#e34c26] dark:text-[#ff7b72]",
  },
  htm: {
    icon: CodeXml,
    colorClass: "text-[#e34c26] dark:text-[#ff7b72]",
  },
  xml: {
    icon: CodeXml,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  svg: {
    icon: FileImage,
    colorClass: "text-[#e34c26] dark:text-[#ff7b72]",
  },
  css: {
    icon: Palette,
    colorClass: "text-[#563d7c] dark:text-[#bc8cff]",
  },
  scss: {
    icon: Palette,
    colorClass: "text-[#c6538c] dark:text-[#ff79c6]",
  },
  sass: {
    icon: Palette,
    colorClass: "text-[#c6538c] dark:text-[#ff79c6]",
  },
  less: {
    icon: Palette,
    colorClass: "text-[#1d365d] dark:text-[#569cd6]",
  },
  // Data, config & serializers
  json: {
    icon: Braces,
    colorClass: "text-[#cb8e00] dark:text-[#f5c042]",
  },
  jsonc: {
    icon: Braces,
    colorClass: "text-[#cb8e00] dark:text-[#f5c042]",
  },
  json5: {
    icon: Braces,
    colorClass: "text-[#cb8e00] dark:text-[#f5c042]",
  },
  yaml: {
    icon: Sliders,
    colorClass: "text-[#cb171e] dark:text-[#f85149]",
  },
  yml: {
    icon: Sliders,
    colorClass: "text-[#cb171e] dark:text-[#f85149]",
  },
  toml: {
    icon: Sliders,
    colorClass: "text-[#9c4221] dark:text-[#f0883e]",
  },
  ini: {
    icon: Sliders,
    colorClass: "text-muted-foreground",
  },
  env: {
    icon: KeyRound,
    colorClass: "text-amber-600 dark:text-amber-400",
  },
  properties: {
    icon: Sliders,
    colorClass: "text-muted-foreground",
  },
  // Shell scripts
  sh: {
    icon: SquareTerminal,
    colorClass: "text-[#2e7d32] dark:text-[#7ee787]",
  },
  bash: {
    icon: SquareTerminal,
    colorClass: "text-[#2e7d32] dark:text-[#7ee787]",
  },
  zsh: {
    icon: SquareTerminal,
    colorClass: "text-[#2e7d32] dark:text-[#7ee787]",
  },
  fish: {
    icon: SquareTerminal,
    colorClass: "text-[#2e7d32] dark:text-[#7ee787]",
  },
  bat: {
    icon: SquareTerminal,
    colorClass: "text-muted-foreground",
  },
  cmd: {
    icon: SquareTerminal,
    colorClass: "text-muted-foreground",
  },
  ps1: {
    icon: SquareTerminal,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  // Documents & notes
  md: {
    icon: FileText,
    colorClass: "text-[#0969da] dark:text-[#58a6ff]",
  },
  mdx: {
    icon: FileText,
    colorClass: "text-[#0969da] dark:text-[#58a6ff]",
  },
  txt: {
    icon: FileText,
    colorClass: "text-muted-foreground",
  },
  pdf: {
    icon: FileText,
    colorClass: "text-rose-600 dark:text-rose-400",
  },
  doc: {
    icon: FileText,
    colorClass: "text-blue-700 dark:text-blue-400",
  },
  docx: {
    icon: FileText,
    colorClass: "text-blue-700 dark:text-blue-400",
  },
  csv: {
    icon: FileSpreadsheet,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  xlsx: {
    icon: FileSpreadsheet,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  xls: {
    icon: FileSpreadsheet,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  sql: {
    icon: Database,
    colorClass: "text-[#00758f] dark:text-[#388bfd]",
  },
  // Images
  png: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  jpg: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  jpeg: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  gif: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  webp: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  ico: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  bmp: {
    icon: FileImage,
    colorClass: "text-purple-600 dark:text-purple-400",
  },
  // Audio / Video
  mp3: {
    icon: FileAudio,
    colorClass: "text-violet-600 dark:text-violet-400",
  },
  wav: {
    icon: FileAudio,
    colorClass: "text-violet-600 dark:text-violet-400",
  },
  ogg: {
    icon: FileAudio,
    colorClass: "text-violet-600 dark:text-violet-400",
  },
  flac: {
    icon: FileAudio,
    colorClass: "text-violet-600 dark:text-violet-400",
  },
  mp4: {
    icon: FileVideo,
    colorClass: "text-pink-600 dark:text-pink-400",
  },
  mkv: {
    icon: FileVideo,
    colorClass: "text-pink-600 dark:text-pink-400",
  },
  webm: {
    icon: FileVideo,
    colorClass: "text-pink-600 dark:text-pink-400",
  },
  mov: {
    icon: FileVideo,
    colorClass: "text-pink-600 dark:text-pink-400",
  },
  // Archives
  zip: {
    icon: FileArchive,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  tar: {
    icon: FileArchive,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  gz: {
    icon: FileArchive,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  "7z": {
    icon: FileArchive,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  rar: {
    icon: FileArchive,
    colorClass: "text-amber-700 dark:text-amber-500",
  },
  // Fonts
  woff: {
    icon: FileType,
    colorClass: "text-slate-600 dark:text-slate-400",
  },
  woff2: {
    icon: FileType,
    colorClass: "text-slate-600 dark:text-slate-400",
  },
  ttf: {
    icon: FileType,
    colorClass: "text-slate-600 dark:text-slate-400",
  },
  otf: {
    icon: FileType,
    colorClass: "text-slate-600 dark:text-slate-400",
  },
}

/**
 * Maps specialized directory names to tailored folder icons.
 */
const SPECIAL_FOLDER_MAP: Record<string, IconStyleConfig> = {
  ".git": {
    icon: FolderGit2,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  ".github": {
    icon: FolderGit2,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  node_modules: {
    icon: FolderArchive,
    colorClass: "text-muted-foreground/60",
  },
  target: {
    icon: FolderArchive,
    colorClass: "text-muted-foreground/60",
  },
  dist: {
    icon: FolderArchive,
    colorClass: "text-muted-foreground/60",
  },
  build: {
    icon: FolderArchive,
    colorClass: "text-muted-foreground/60",
  },
  ".next": {
    icon: FolderArchive,
    colorClass: "text-muted-foreground/60",
  },
  ".turbo": {
    icon: FolderArchive,
    colorClass: "text-muted-foreground/60",
  },
  src: {
    icon: FolderCode,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  app: {
    icon: FolderCode,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  components: {
    icon: FolderCode,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  lib: {
    icon: FolderCode,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  packages: {
    icon: FolderCode,
    colorClass: "text-blue-600 dark:text-blue-400",
  },
  crates: {
    icon: FolderCode,
    colorClass: "text-orange-600 dark:text-orange-400",
  },
  docs: {
    icon: FolderRoot,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  documentation: {
    icon: FolderRoot,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  test: {
    icon: FolderCheck,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  tests: {
    icon: FolderCheck,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  __tests__: {
    icon: FolderCheck,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  spec: {
    icon: FolderCheck,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
}

const DEFAULT_FILE_ICON_CONFIG: IconStyleConfig = {
  icon: FileIcon,
  colorClass: "text-muted-foreground/80",
}

const DEFAULT_FOLDER_ICON_CONFIG: IconStyleConfig = {
  icon: FolderIcon,
  openIcon: FolderOpenIcon,
  colorClass: "text-blue-500 dark:text-blue-400",
}

/**
 * Resolves an icon configuration for a given file name.
 */
export function getFileIconConfig(fileName: string): IconStyleConfig {
  const normalized = fileName.trim().toLowerCase()

  // 1. Direct exact file name match
  if (EXACT_FILE_NAME_MAP[normalized]) {
    return EXACT_FILE_NAME_MAP[normalized]
  }

  // 2. Environment file variants (.env.local, .env.development, etc.)
  if (normalized.startsWith(".env")) {
    return {
      icon: KeyRound,
      colorClass: "text-amber-600 dark:text-amber-400",
    }
  }

  // 3. Double extension or single extension match
  // e.g. "foo.tar.gz" -> check "tar.gz", then "gz"
  const parts = normalized.split(".")
  if (parts.length > 2) {
    const doubleExt = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
    if (EXTENSION_MAP[doubleExt]) {
      return EXTENSION_MAP[doubleExt]
    }
  }

  if (parts.length > 1) {
    const ext = parts[parts.length - 1]
    if (EXTENSION_MAP[ext]) {
      return EXTENSION_MAP[ext]
    }
  }

  return DEFAULT_FILE_ICON_CONFIG
}

/**
 * Resolves an icon configuration for a given folder name.
 */
export function getFolderIconConfig(folderName: string): IconStyleConfig {
  const normalized = folderName.trim().toLowerCase()

  if (SPECIAL_FOLDER_MAP[normalized]) {
    return SPECIAL_FOLDER_MAP[normalized]
  }

  return DEFAULT_FOLDER_ICON_CONFIG
}
