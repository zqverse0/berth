# 跨设备操作（Tailscale）

用户的设备在同一个 Tailscale 网络里。另一台设备上的 Berth 就是 `ssh <设备> berth …`，
命令、参数、退出码与本机完全一样。

## 0. 先看设备在不在线

```bash
tailscale status --json | python3 -c 'import json,sys
for p in json.load(sys.stdin)["Peer"].values():
    print(p["DNSName"].split(".")[0], p["OS"], "online" if p["Online"] else "offline")'
```

离线设备不要去连；命令一律带 `-o ConnectTimeout=5`，连不上就告诉用户，不要重试刷屏。

## 1. 操作另一台设备上的 Berth

```bash
H="ssh -o ConnectTimeout=5 aliyun"
$H berth project ls                                   # 对方注册的项目
$H berth terminal ls --project codeg                  # 对方的终端
$H berth terminal create --project codeg --agent claude
$H berth terminal send -t codeg:3 --text "pytest"; $H berth terminal send -t codeg:3 --key Enter
$H berth terminal capture -t codeg:3                  # 读输出
$H berth project codeg task list
```

对方没装 berth（`command not found`）时只能用普通 shell：`$H 'cd <路径> && <命令>'`。

## 2. 传文件

```bash
rsync -az ./dist/ aliyun:~/app/dist/      # 目录，增量
scp report.pdf aliyun:~/                  # 单个文件
```

## 3. 边界

- 删除、覆盖远程文件、重启服务前先让用户确认，和本机一样。
- 不改对方的 `~/.ssh`、Tailscale 配置，不代填密码；认证失败（`Host key verification failed`、
  `Permission denied`）请用户自己在终端里跑一次 `ssh <设备>`。
