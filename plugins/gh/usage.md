# 在 Berth 里用 GitHub CLI

gh 管 PR、CI、issue 和审阅意见。你在终端里跑，用户在 Berth 里看结果、做决定。

## 0. 先确认能用

```bash
gh auth status            # 未登录时请用户在终端里跑一次 `gh auth login`，你不要代填 token
```

## 1. 对外动作先给用户看

开 PR、发评论、合并、关 issue 都会公开发布，**先让用户确认**。正文先写到仓库外的临时文件
（别写进仓库，`.berth/` 是 git 跟踪的），用 Berth 打开给用户看：

```bash
draft=$(mktemp -d)                # 把正文写进 "$draft/pr-body.md"
berth open "$draft/pr-body.md"    # 在用户的 Berth 窗口里打开
```

用户确认后再发：

```bash
gh pr create --base main --title "<标题>" --body-file "$draft/pr-body.md"   # 加 --draft 开草稿
gh pr comment <编号> --body-file "$draft/reply.md"
```

- 不要用 `-w/--web`：那会打开外部浏览器。给用户看东西一律 `berth open`。
- 任务绑定了 PRD（`.berth/tasks/<任务>/prd.md`）时，PR 正文写“改了什么 + 怎么验证的”，需求引用 PRD，不要整段复制。

## 2. 等 CI、看失败原因

```bash
gh pr checks <编号> --watch --fail-fast        # 阻塞到出结果，第一个失败就返回
gh run view <run-id> --log-failed              # 只看失败步骤的日志
```

`gh pr checks` 的输出里有 run 链接，run-id 是链接最后那段数字。

## 3. 处理审阅意见

```bash
gh pr view <编号> --comments                                  # 总评与对话
gh api repos/{owner}/{repo}/pulls/<编号>/comments \
  --jq '.[] | {path, line, body, user: .user.login}'           # 行内意见（带文件与行号）
gh pr diff <编号> --name-only                                  # 改了哪些文件
```

`{owner}/{repo}` 原样写，gh 会按当前仓库填入。改完后把逐条处理结果写进回复正文，同样先 `berth open` 给用户看。

## 4. 取结构化数据

要解析就用 `--json <字段>`（加 `--jq` 过滤），不要解析表格输出：

```bash
gh pr view <编号> --json state,mergeable,reviewDecision,headRefName
gh issue view <编号> --json title,body,labels --comments
```
