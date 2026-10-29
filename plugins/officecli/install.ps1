# Berth org.berth.install 安装脚本（Windows）：跑 OfficeCLI 官方 install.ps1（镜像优先，GitHub 兜底）。
# 加固前言须在首次网络请求前生效，且经 iex 同作用域作用于官方脚本的二进制下载：
#   TLS 1.2 仅在非 SystemDefault(0) 时按位追加；关闭进度条（PS 5.1 下载极慢）；UTF-8 输出。
$ErrorActionPreference = 'Stop'
try { $sp = [Net.ServicePointManager]::SecurityProtocol; if ([int]$sp -ne 0) { [Net.ServicePointManager]::SecurityProtocol = $sp -bor [Net.SecurityProtocolType]::Tls12 } } catch {}
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $s = irm -TimeoutSec 60 https://d.officecli.ai/install.ps1 } catch { $s = irm -TimeoutSec 60 https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.ps1 }
iex $s
