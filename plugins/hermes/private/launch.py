import hermes_bootstrap  # noqa: F401
import hashlib
import json
import os
import sys

from hermes_cli.config import read_user_config_raw, save_config

# 节点目录由 Hermes 原生配置管理；密钥只在会话中传递。
base_url = os.environ.pop("BERTH_HERMES_URL")
api_key = os.environ.pop("BERTH_HERMES_KEY")
model = os.environ.pop("BERTH_HERMES_MODEL")
name = os.environ.pop("BERTH_HERMES_NAME")
models = json.loads(os.environ.pop("BERTH_HERMES_MODELS"))
identity = hashlib.sha256((name + "\0" + base_url).encode()).hexdigest()[:16]
provider = "berth-" + identity
entry = {"name": provider, "api": base_url, "transport": "openai_chat",
         "discover_models": False, "models": models}
existing = read_user_config_raw().get("providers") or {}
if not isinstance(existing, dict):
    raise RuntimeError("Hermes providers 配置不是对象，无法同步 Berth 服务商")
if provider in existing and (not isinstance(existing[provider], dict)
                             or existing[provider].get("api") != base_url):
    raise RuntimeError("Hermes 中存在同名服务商，拒绝覆盖")
if existing.get(provider) != entry:
    save_config({"providers": {provider: entry}}, merge_existing=True)
    if (read_user_config_raw().get("providers") or {}).get(provider) != entry:
        raise RuntimeError("无法保存 Hermes 服务商配置")

# 密钥不出现在操作系统进程参数里，也不写入 Hermes 配置。
sys.argv = ["hermes", "chat", "--provider", provider, "--base-url", base_url,
            "--api-key", api_key, "--model", model, *sys.argv[1:]]
from hermes_cli.main import main

main()
