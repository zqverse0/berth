#!/usr/bin/env python3
"""收集画图素材到 Excalidraw 插件数据目录（个人运行，素材不进插件包、不进公开仓库）。

    python3 -I collect.py [--dest DIR] [--skip-bench] [--refresh]
    python3 -I collect.py --check        # 离线自检：用内置样例生成 index 并校验格式

默认目录 $BERTH_HOME/state/excalidraw/library/（BERTH_HOME 缺省 ~/.berth），插件更新不会覆盖。
只用 Python 标准库。来源与版本记在 index.json 的 sources 里：

- PaperBanana（github.com/dwzhu-pku/PaperBanana，Apache-2.0）：style_guides/*.md → styles/；
  prompts/*.py 与 agents/*.py 顶层的大写字符串常量（原版提示词，逐字）→ prompts/paperbanana/；
  static/images 与 assets 的案例图、方法图 → references/
- smart-excalidraw-next（github.com/liujuntao123/smart-excalidraw-next，仓库未声明许可证，仅个人参考）：
  lib/prompts.js 的 SYSTEM_PROMPT 与每种图类型的视觉规范（CHART_VISUAL_SPECS，逐字）、docs/excalidraw-doc.md、
  docs/arrow-compute-rule.md → prompts/smart-excalidraw/；原文件与 lib/optimizeArrows.js、lib/json-repair.js
  → sources/smart-excalidraw/（只读参考，不进 index）
- PaperBananaBench（huggingface.co/datasets/dwzhu/PaperBananaBench）：全集 → bench/{diagram,plot}/；
  每项进 index（kind bench，页面默认不列）；ref 集每个类别挑前 3 项另记一条 reference

index.json 格式（library.js 与图库页面读它）：

    {"version": 1, "generatedAt": "<ISO 时间>",
     "sources": [{"name", "url", "revision", "license"}],
     "items": [{"id", "kind", "title", "tags": [...], "path", "thumb", "prompt"?, "source"}]}

- kind：template | reference | style | prompt | bench
- path / thumb：相对 library 目录；thumb 为图片或 null；prompt：可直接发给 Agent 的文字（可省略）
- source：对应 sources[].name
"""

from __future__ import annotations

import argparse
import ast
import datetime
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PAPERBANANA = ("paperbanana", "dwzhu-pku/PaperBanana", "Apache-2.0")
SMART = ("smart-excalidraw", "liujuntao123/smart-excalidraw-next", "none (personal reference only)")
BENCH_URL = "https://huggingface.co/datasets/dwzhu/PaperBananaBench/resolve/main/PaperBananaBench.zip"
KINDS = {"template", "reference", "style", "prompt", "bench"}
PICKS_PER_CATEGORY = 3
USER_AGENT = "berth-excalidraw-collect"


def default_dest() -> Path:
    home = Path(os.environ.get("BERTH_HOME") or Path.home() / ".berth")
    return home / "state" / "excalidraw" / "library"


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def head_commit(repo: str) -> str:
    data = json.loads(fetch(f"https://api.github.com/repos/{repo}/commits?per_page=1"))
    return data[0]["sha"]


def repo_files(repo: str, sha: str, wanted) -> dict[str, bytes]:
    """下载仓库 tarball，返回 wanted(相对路径) 为真的文件。"""
    archive = tarfile.open(fileobj=io.BytesIO(fetch(f"https://codeload.github.com/{repo}/tar.gz/{sha}")))
    files = {}
    for member in archive.getmembers():
        if not member.isfile():
            continue
        relative = member.name.split("/", 1)[1] if "/" in member.name else member.name
        if wanted(relative):
            files[relative] = archive.extractfile(member).read()
    return files


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80] or "item"


def write(dest: Path, relative: str, data: bytes | str) -> str:
    path = dest / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    path.write_bytes(data)
    return relative


def python_prompts(source: str) -> list[tuple[str, str]]:
    """模块顶层的大写字符串常量（含相加拼接），逐字取出。"""

    def literal(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = literal(node.left), literal(node.right)
            if left is not None and right is not None:
                return left + right
        return None

    prompts = []
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name, value = node.targets[0].id, literal(node.value)
            if name.isupper() and value and len(value.strip()) >= 80:
                prompts.append((name, value.strip()))
    return prompts


def collect_paperbanana(dest: Path, items: list, sources: list) -> None:
    name, repo, license_ = PAPERBANANA
    sha = head_commit(repo)
    sources.append({"name": name, "url": f"https://github.com/{repo}", "revision": sha, "license": license_})
    images = ("static/images/case_", "static/images/teaser", "static/images/method", "assets/method", "assets/teaser")
    files = repo_files(
        repo,
        sha,
        lambda p: (p.startswith("style_guides/") and p.endswith(".md"))
        or (p.startswith(("prompts/", "agents/")) and p.endswith(".py"))
        or p.startswith(images),
    )
    for path, data in sorted(files.items()):
        if path.startswith("style_guides/"):
            stem = Path(path).stem
            kind = "plot" if "plot" in stem else "diagram"
            items.append({
                "id": f"style-{slug(stem)}", "kind": "style", "title": stem.replace("_", " "),
                "tags": ["style", kind, "paperbanana"], "path": write(dest, f"styles/{Path(path).name}", data),
                "thumb": None, "source": name,
            })
        elif path.endswith(".py"):
            group = "eval" if path.startswith("prompts/") else "agent"
            for const, text in python_prompts(data.decode("utf-8")):
                kind = "plot" if const.startswith("PLOT") else "diagram" if const.startswith("DIAGRAM") else "general"
                relative = write(dest, f"prompts/paperbanana/{Path(path).stem}/{const}.md", text + "\n")
                items.append({
                    "id": f"prompt-pb-{slug(const)}", "kind": "prompt", "title": const.replace("_", " ").title(),
                    "tags": ["prompt", group, kind, "paperbanana"], "path": relative, "thumb": None,
                    "prompt": text, "source": name,
                })
        else:
            # 同名图在 static/ 与 assets/ 各有一份时只留第一份
            target = f"references/paperbanana/{Path(path).name}"
            if (dest / target).exists() and any(item["path"] == target for item in items):
                continue
            relative = write(dest, target, data)
            stem = Path(path).stem
            items.append({
                "id": f"ref-pb-{slug(stem)}", "kind": "reference", "title": stem.replace("_", " "),
                "tags": ["reference", "diagram", "paperbanana"], "path": relative, "thumb": relative, "source": name,
            })


def template_literals(source: str, start: int) -> tuple[str, int]:
    """从 start（反引号处）读一个 JS 模板字符串，返回值（按 JS 还原 \\n、\\t 与其余反斜杠转义）与结束位置。"""
    assert source[start] == "`"
    out, i = [], start + 1
    while source[i] != "`":
        if source[i] == "\\":
            out.append({"n": "\n", "t": "\t"}.get(source[i + 1], source[i + 1]))
            i += 2
        else:
            out.append(source[i])
            i += 1
    return "".join(out), i + 1


def js_prompts(source: str) -> tuple[str | None, list[tuple[str, str, str]]]:
    """smart-excalidraw 的 prompts.js：SYSTEM_PROMPT 与 [(图类型, 中文名, 视觉规范)]。"""
    system = None
    match = re.search(r"SYSTEM_PROMPT\s*=\s*`", source)
    if match:
        system = template_literals(source, match.end() - 1)[0].strip()
    names = dict(re.findall(r"^\s*(\w+):\s*'([^']+)'", source[source.find("CHART_TYPE_NAMES"):], re.M))
    specs = []
    block = source.find("CHART_VISUAL_SPECS = {")
    if block >= 0:
        end = source.find("\n};", block)
        for match in re.finditer(r"^\s*(\w+):\s*`", source[block:end], re.M):
            text = template_literals(source, block + match.end() - 1)[0].strip()
            specs.append((match.group(1), names.get(match.group(1), match.group(1)), text))
    return system, specs


def collect_smart(dest: Path, items: list, sources: list) -> None:
    name, repo, license_ = SMART
    sha = head_commit(repo)
    sources.append({"name": name, "url": f"https://github.com/{repo}", "revision": sha, "license": license_})
    prompt_files = {"lib/prompts.js", "docs/excalidraw-doc.md", "docs/arrow-compute-rule.md"}
    source_files = {"lib/optimizeArrows.js", "lib/json-repair.js"}
    files = repo_files(repo, sha, lambda p: p in prompt_files | source_files)
    for path, data in sorted(files.items()):
        if path in source_files or path == "lib/prompts.js":
            write(dest, f"sources/smart-excalidraw/{Path(path).name}", data)
        if path in source_files:
            continue
        if path == "lib/prompts.js":
            system, specs = js_prompts(data.decode("utf-8"))
            if system:
                items.append({
                    "id": "prompt-se-system", "kind": "prompt", "title": "Excalidraw 生成系统提示词",
                    "tags": ["prompt", "excalidraw", "smart-excalidraw"],
                    "path": write(dest, "prompts/smart-excalidraw/system-prompt.md", system + "\n"),
                    "thumb": None, "prompt": system, "source": name,
                })
            for chart, title, spec in specs:
                items.append({
                    "id": f"prompt-se-chart-{slug(chart)}", "kind": "prompt", "title": f"{title}（{chart}）视觉规范",
                    "tags": ["prompt", "excalidraw", "chart-type", chart, "smart-excalidraw"],
                    "path": write(dest, f"prompts/smart-excalidraw/chart-types/{chart}.md", spec + "\n"),
                    "thumb": None, "prompt": spec, "source": name,
                })
            continue
        text = data.decode("utf-8")
        relative = write(dest, f"prompts/smart-excalidraw/{Path(path).name}", text)
        items.append({
            "id": f"prompt-se-{slug(Path(path).stem)}", "kind": "prompt", "title": Path(path).stem.replace("-", " "),
            "tags": ["prompt", "excalidraw", "smart-excalidraw"], "path": relative, "thumb": None,
            "prompt": text, "source": name,
        })


def download(url: str, target: Path, attempts: int = 20) -> None:
    """大文件下载：核对总长度，断开就按 Range 从断点续传；完整后才改成正式文件名。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    head = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(head, timeout=120) as response:
        total = int(response.headers["Content-Length"])
    print(f"downloading {url} ({total >> 20} MB)", file=sys.stderr)
    for _ in range(attempts):
        done = partial.stat().st_size if partial.exists() else 0
        if done >= total:
            break
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={done}-"}
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response, open(partial, "ab") as out:
                if done and response.status != 206:
                    out.truncate(0)  # 服务器不支持续传：从头来
                shutil.copyfileobj(response, out, 1 << 20)
        except OSError as error:
            print(f"  interrupted at {done >> 20} MB: {error}; resuming", file=sys.stderr)
    if not partial.exists() or partial.stat().st_size != total:
        raise SystemExit(f"download incomplete: {url}; run again to resume")
    partial.replace(target)


def fixed_name(info: zipfile.ZipInfo) -> str:
    """还原被按 CP437 误解码的 UTF-8 文件名。这份 zip 里有的名字没标 UTF-8，有的标了但内容本身已是
    乱码（被转了两次），所以不看标记：能按 CP437 编回字节且是合法 UTF-8 就用还原后的名字，否则原样。"""
    try:
        return info.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


def collect_bench(dest: Path, items: list, sources: list, refresh: bool) -> None:
    cache = dest / ".cache" / "PaperBananaBench.zip"
    if refresh or not cache.exists():
        download(BENCH_URL, cache)
    sources.append({
        "name": "paperbananabench", "url": "https://huggingface.co/datasets/dwzhu/PaperBananaBench",
        "revision": "main", "license": "see dataset card",
    })
    with zipfile.ZipFile(cache) as archive:
        for info in archive.infolist():
            name = fixed_name(info)
            if info.is_dir() or not name.startswith("PaperBananaBench/"):
                continue
            target = dest / "bench" / name.split("/", 1)[1]
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, open(target, "wb") as out:
                shutil.copyfileobj(source, out)
    for task in ("diagram", "plot"):
        picked: dict[str, int] = {}
        for split in ("ref", "test"):
            records_path = dest / "bench" / task / f"{split}.json"
            if not records_path.exists():
                continue
            for record in json.loads(records_path.read_text(encoding="utf-8")):
                image = record.get("path_to_gt_image")
                relative = f"bench/{task}/{image}" if image else None
                if relative and not (dest / relative).exists():
                    relative = None
                category = str(record.get("category") or "uncategorized")
                intent = str(record.get("visual_intent") or "").strip()
                item = {
                    "id": f"bench-{task}-{split}-{slug(str(record.get('id', '')))}", "kind": "bench",
                    "title": intent.split("\n", 1)[0][:120] or str(record.get("id")),
                    "tags": ["bench", task, split, category], "path": relative or f"bench/{task}/{split}.json",
                    "thumb": relative, "prompt": intent or None, "source": "paperbananabench",
                }
                items.append(item)
                if split == "ref" and relative and picked.get(category, 0) < PICKS_PER_CATEGORY:
                    picked[category] = picked.get(category, 0) + 1
                    items.append({**item, "id": item["id"].replace("bench-", "ref-bench-", 1), "kind": "reference",
                                  "tags": ["reference", task, category, "paperbananabench"]})


def validate(index: dict, dest: Path) -> list[str]:
    errors = []
    if index.get("version") != 1:
        errors.append("version must be 1")
    names = {source.get("name") for source in index.get("sources", [])}
    seen = set()
    for item in index.get("items", []):
        label = item.get("id", "<no id>")
        for key in ("id", "kind", "title", "path", "source"):
            if not isinstance(item.get(key), str) or not item[key]:
                errors.append(f"{label}: {key} must be a non-empty string")
        if item.get("kind") not in KINDS:
            errors.append(f"{label}: unknown kind {item.get('kind')}")
        if not isinstance(item.get("tags"), list):
            errors.append(f"{label}: tags must be a list")
        if item.get("id") in seen:
            errors.append(f"{label}: duplicate id")
        seen.add(item.get("id"))
        if item.get("source") not in names:
            errors.append(f"{label}: source not listed in sources")
        for key in ("path", "thumb"):
            value = item.get(key)
            if value and (Path(value).is_absolute() or ".." in Path(value).parts or not (dest / value).exists()):
                errors.append(f"{label}: {key} {value} is missing or outside the library")
    return errors


def write_index(dest: Path, items: list, sources: list) -> dict:
    index = {
        "version": 1,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "sources": sources,
        "items": items,
    }
    errors = validate(index, dest)
    if errors:
        raise SystemExit("index invalid:\n  " + "\n  ".join(errors[:20]))
    partial = dest / "index.json.part"
    partial.write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    partial.replace(dest / "index.json")
    return index


def self_check() -> int:
    """离线：用内置样例走一遍提示词抽取、zip 文件名修复与 index 校验。"""
    sample = 'X = 1\nSHORT = "hi"\nDIAGRAM_A_PROMPT = """' + "a" * 90 + '"""\nPLOT_B = "' + "b" * 50 + '" + "' + "c" * 40 + '"\n'
    assert [name for name, _ in python_prompts(sample)] == ["DIAGRAM_A_PROMPT", "PLOT_B"]
    system, specs = js_prompts(
        "export const SYSTEM_PROMPT = `## 任务\\n用 \\`json\\``;\nconst CHART_TYPE_NAMES = {\n  flow: '流程图',\n};\n"
        "const CHART_VISUAL_SPECS = {\n  flow: `\n### 规范`,\n};\n"
    )
    assert system == "## 任务\n用 `json`" and specs == [("flow", "流程图", "### 规范")], (system, specs)
    info = zipfile.ZipInfo("Schrödinger.jpg".encode("utf-8").decode("cp437"))
    assert fixed_name(info) == "Schrödinger.jpg"
    assert fixed_name(zipfile.ZipInfo("Schrödinger.jpg")) == "Schrödinger.jpg"
    assert fixed_name(zipfile.ZipInfo("Graph–Based")) == "Graph–Based"
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        write(dest, "styles/a.md", "# a")
        sources = [{"name": "s", "url": "u", "revision": "r", "license": "l"}]
        good = [{"id": "a", "kind": "style", "title": "A", "tags": [], "path": "styles/a.md", "thumb": None, "source": "s"}]
        write_index(dest, good, sources)
        assert json.loads((dest / "index.json").read_text())["items"][0]["id"] == "a"
        bad = good + [{**good[0], "kind": "x", "path": "../etc"}]
        assert len(validate({"version": 1, "sources": sources, "items": bad}, dest)) == 3
    print("collect.py self-check ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--dest", type=Path, default=default_dest())
    parser.add_argument("--skip-bench", action="store_true", help="不下载 PaperBananaBench（~270 MB）")
    parser.add_argument("--refresh", action="store_true", help="重新下载已缓存的 Bench zip")
    parser.add_argument("--check", action="store_true", help="离线自检，不联网、不写数据目录")
    args = parser.parse_args()
    if args.check:
        return self_check()
    dest = args.dest.expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    items: list = []
    sources: list = []
    collect_paperbanana(dest, items, sources)
    collect_smart(dest, items, sources)
    if not args.skip_bench:
        collect_bench(dest, items, sources, args.refresh)
    index = write_index(dest, items, sources)
    counts: dict[str, int] = {}
    for item in index["items"]:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    print(f"{dest}/index.json: " + ", ".join(f"{kind} {count}" for kind, count in sorted(counts.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
