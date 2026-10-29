# 同步与发布流程

## 仓库

| remote | 仓库 | 用途 |
|---|---|---|
| `origin` | `zqverse0/berth-private`（私有） | 完整开发历史，日常 push 都到这里 |
| `public` | `zqverse0/berth`（公开） | 只有发布快照；push 地址故意设为 `DISABLED-use-snapshot-publish`，只读 |

代码里的仓库地址（`tauri.conf.json` 更新器、`Cargo.toml`、README、设置页）都指向公开仓库，不要改成私有仓库。

## worktree 与分支

| 目录 | 分支 | `git push` 到 |
|---|---|---|
| `~/Project/berth-dev` | `dev` | `origin/dev` |
| `~/Project/berth` | `main` | `origin/main` |

- 在 `berth-dev` 开发；合并到 main 要去 `berth` 目录做（main 已在那个 worktree 检出，`berth-dev` 里切不过去）。
- 不要在 git 里给 `public` 配可用的 push 地址，也不要 `git push public`。

## 日常流程

```bash
# 1. berth-dev：开发、提交
git push                        # → origin/dev

# 2. berth：合并、测试
git merge dev && git push       # → origin/main（私有，不对外）

# 3. 发布到公开仓库（在 berth 目录）
scripts/publish-public          # 去掉内部资料后作为一个快照提交推到公开 main → 触发公开 Test
scripts/publish-public --tag    # 同上，再推 v<package.json 版本> tag → 触发 Release 构建全平台安装包
```

## 注意

- **私有仓库不跑 CI**：push 到 `origin/main` 没有任何检查，问题要到 `publish-public` 后才在公开仓库的 Test 暴露。发布前本地先过一遍要改动的 crate 的 clippy 和相关测试（规则见 `docs/verification.md`）。
- **Windows clippy 更严**：公开 Test 在 windows-latest 跑 `cargo clippy`，曾因 Linux 本地没报的 lint 失败；看 `gh run list -R zqverse0/berth` 确认是绿的。
- **先改版本再 `--tag`**：版本取自 `package.json`（`scripts/set-version.mjs`），重复版本会撞已有 tag。
- **Release 失败**：公开仓库会留下一个 draft release，修好后重推 tag 或手动删掉 draft，不要留着。
- **不公开的内容**：`scripts/publish-public` 的 `EXCLUDE` 决定哪些路径不进公开仓库，新增内部资料目录时加进去；脚本还会拦截本机路径和密钥。
- **签名密钥**：updater 私钥在本机 `~/.tauri/berth.key`，密码在 `~/.tauri/berth.key.password`，公钥写在 `tauri.conf.json`；对应的 `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` 只配在公开仓库的 Actions secrets。丢了私钥，已安装的用户就收不到自动更新，要另外备份。macOS 签名见 `macos-signing.md`。
- **设置 secret 不要用对话框的 `!`**：它不是交互终端，`gh secret set` 会存进空值。用文件喂：`gh secret set NAME -R zqverse0/berth < 文件`。
- **归档不删**：暂时不用但不确定能删的文件移到本机的 `REMOVE/` 并 `git rm --cached`；该目录被 `.gitignore` 忽略，不进 git。
- **README 截图**：放在 `docs/screenshots/`（会发布到公开仓库），截图前确认画面里没有私有项目名、会话内容和本机路径。
