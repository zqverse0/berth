import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import eslintConfigPrettier from "eslint-config-prettier"
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/target/**",
    "src-tauri/experts/**",
    "public/vs/**",
    "public/pdfjs/**",
    ".pi/**",
    // 内部过程资料（调研探针、迁移脚本），不是产品代码
    ".trellis/**",
    ".berth/**",
    "REMOVE/**",
    "perf/**",
    "outputs/**",
  ]),
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
  {
    rules: {
      "prettier/prettier": "error",
    },
  },
  {
    // 插件脚本用 `/// <reference>` 引入 berth-plugin.d.ts 的类型（QuickJS 里没有 import 类型的途径）
    files: ["plugins/**", "src-tauri/tool/berth-plugin-api/src/**"],
    rules: {
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  {
    // Conversation render path: the aggregate workspace hook subscribes to
    // the high-frequency fileTabs slice, so any consumer here would
    // re-render on every keystroke / watcher reload in the file editor.
    // Use the narrow slice hooks instead.
    files: [
      "src/components/chat/**",
      "src/components/message/**",
      "src/components/ai-elements/**",
      "src/components/conversations/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='useWorkspaceContext']",
          message:
            "Hot path: use useWorkspaceActions / useWorkspaceView / useWorkspaceFileTabs instead of the aggregate useWorkspaceContext (it re-renders on every fileTabs change).",
        },
      ],
    },
  },
  // ── Module boundary guards (architecture fitness functions) ──
  {
    // Neutral domain contracts must not depend on UI/runtime layers.
    files: ["src/lib/domain-types/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/contexts/**",
                "@/stores/**",
                "@/hooks/**",
                "@/components/**",
              ],
              message:
                "domain-types is a neutral contract layer: do not import Context, Store, Hook, or feature UI.",
            },
          ],
        },
      ],
    },
  },
])

export default eslintConfig
