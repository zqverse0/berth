export const DOCUMENT_FRAME_CONTEXT_MESSAGE = "berth:document-context"

export type DocumentFrameContextEvent = "selection" | "document" | "contextmenu"

export interface DocumentFrameContextMessage {
  type: typeof DOCUMENT_FRAME_CONTEXT_MESSAGE
  event: DocumentFrameContextEvent
  /** Identity of the loaded document instance, not merely its URL. */
  generation?: string | null
  url: string
  title?: string | null
  text?: string | null
  content?: string | null
  /** event === "contextmenu" 时沙箱内右键的视口坐标（frame 内部）。 */
  clientX?: number | null
  clientY?: number | null
  /** 选区/拾取覆盖的预览插件元素路径（预览 HTML 的 `data-path`）。 */
  dataPaths?: string[] | null
}

/**
 * Small renderer-neutral bridge for sandboxed HTML/Office-style frames.
 * Native WebViews use the same payload contract from Rust; browser frames use
 * this script and the parent validates the exact iframe window before use.
 */
export const DOCUMENT_CONTEXT_BRIDGE_SCRIPT = `
(() => {
  if (window.__BERTH_DOCUMENT_CONTEXT_BRIDGE__) return;
  window.__BERTH_DOCUMENT_CONTEXT_BRIDGE__ = true;
  const MAX_TEXT = 65536;
  const MAX_DOCUMENT = 524288;
  const generation = (() => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (_) {}
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  })();
  let lastSelection = "";
  let lastDocument = null;
  let documentTimer = 0;
  const clip = (value, max) => String(value || "").slice(0, max);
  const emit = (event, extra) => {
    try {
      window.parent.postMessage(
        {
          type: "berth:document-context",
          event,
          generation,
          url: window.location.href,
          title: document.title || null,
          ...(extra || {}),
        },
        "*"
      );
    } catch (_) {}
  };
  // 预览插件给每个元素标了 data-path（watch/1，如 /slide[1]/shape[@id=12]），
  // 随选区上报，Agent 可直接用它定位要改的元素。整段落在同一元素内取该
  // 元素；跨元素取所有相交的最内层元素。
  // 宿主脚本（晚于本脚本执行）用 __BERTH_ELEMENT_PICK__ 配置拾取：true =
  // Office（data-path，始终开启）；对象 { attr, lines, toggle } = HTML 预览
  // （attr 值是源码行号，lines 时上报元素行范围，toggle 时默认关闭、由宿主
  // 消息开关）。首次用到时读取。
  let pickConfig;
  const config = () => {
    if (pickConfig !== undefined) return pickConfig;
    const raw = window.__BERTH_ELEMENT_PICK__;
    pickConfig = !raw
      ? null
      : raw === true
        ? { attr: "data-path", lines: false, toggle: false }
        : { attr: String(raw.attr || "data-path"), lines: Boolean(raw.lines), toggle: Boolean(raw.toggle) };
    return pickConfig;
  };
  const attrName = () => (config() ? config().attr : "data-path");
  const attrSelector = () => "[" + attrName() + "]";
  const MAX_PATHS = 50;
  const pathOf = (element) => clip(element.getAttribute(attrName()), 512);
  // lines 模式：元素行范围 = 自身起始行 … 带标注后代的最大起始行。
  const spanOf = (element) => {
    const start = pathOf(element);
    if (!config() || !config().lines) return start;
    let end = Number(start);
    element.querySelectorAll(attrSelector()).forEach((child) => {
      end = Math.max(end, Number(child.getAttribute(attrName())) || 0);
    });
    return end > Number(start) ? start + "-" + end : start;
  };
  const leafPaths = (elements) =>
    elements
      .filter((el) => !elements.some((other) => other !== el && el.contains(other)))
      .slice(0, MAX_PATHS)
      .map(spanOf);
  // 选区只碰到元素边界（如三击段落时终点落在下一元素开头）不算选中它。
  const selectsTextIn = (range, el) => {
    const part = document.createRange();
    part.selectNodeContents(el);
    if (range.compareBoundaryPoints(range.START_TO_START, part) > 0) {
      part.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(range.END_TO_END, part) < 0) {
      part.setEnd(range.endContainer, range.endOffset);
    }
    return !part.collapsed && part.toString().trim() !== "";
  };
  const dataPathsOf = (selection) => {
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node || !node.closest) return null;
    const own = node.closest(attrSelector());
    if (own) return [spanOf(own)];
    const hits = Array.prototype.filter
      .call(node.querySelectorAll(attrSelector()), (el) => range.intersectsNode(el) && selectsTextIn(range, el))
      .slice(0, 4 * MAX_PATHS);
    return hits.length ? leafPaths(hits) : null;
  };
  let clearPicks = null;
  const readSelection = () => {
    const selection = window.getSelection ? window.getSelection() : null;
    const text = clip(selection ? selection.toString() : "", MAX_TEXT).trim();
    if (!text || text === lastSelection) return;
    lastSelection = text;
    if (clearPicks) clearPicks();
    emit("selection", { text, dataPaths: dataPathsOf(selection) });
  };
  let pickedContextMenu = null;
  // 右键坐标随选区即时上报：父页选区层用它换算视口坐标弹出 pointer
  // 胶囊，菜单与正文同层，不再钉在宿主顶边。
  const onContextMenu = (event) => {
    const point = {
      clientX: Number.isFinite(event.clientX) ? event.clientX : null,
      clientY: Number.isFinite(event.clientY) ? event.clientY : null,
    };
    const selection = window.getSelection ? window.getSelection() : null;
    const text = clip(selection ? selection.toString() : "", MAX_TEXT).trim();
    if (!text) {
      // 无文字选区：交给元素拾取（右键点中的元素即目标）。
      if (pickedContextMenu && pickedContextMenu(event, point)) event.preventDefault();
      return;
    }
    // 有选区时由宿主弹 Berth 菜单；不拦会叠出 WebView 原生菜单。
    event.preventDefault();
    emit("contextmenu", { text, dataPaths: dataPathsOf(selection), ...point });
  };
  // ---- 元素拾取：仅宿主显式开启且文档带拾取属性时启用 ----
  // 悬停虚线框、单击选中、Ctrl/⌘ 单击增减、Shift 单击（表格）选区域、Esc 清空。
  // 同一层还画 Agent 的标注（watch/1 的 mark-update，宿主 postMessage 下发）。
  // toggle 模式下拾取开启时拦下页面自身的点击（检查器语义）。
  const setupElementPick = () => {
    const pick = config();
    if (!pick || !document.querySelector(attrSelector())) return;
    let active = !pick.toggle;
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647";
    // 标注文字走 ::before + attr()：不进 innerText，也不触发正文重读。
    // 标签挂在框右上角，平时只显示编号，悬停到该元素时展开备注，避免压住正文。
    const style = document.createElement("style");
    style.textContent = "[data-berth-note]::before{content:attr(data-berth-note);position:absolute;right:-2px;bottom:100%;margin-bottom:2px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.6 system-ui,sans-serif;color:#111;background:#fff;border:1px solid var(--berth-mark,#f59e0b);border-left-width:4px;border-radius:3px;padding:0 6px;box-shadow:0 1px 3px rgba(0,0,0,.25)}";
    layer.appendChild(style);
    document.body.appendChild(layer);
    // 框只改 style（attribute 变更不触发正文 MutationObserver 重读）。
    const boxes = [];
    const boxAt = (i) => {
      while (boxes.length <= i) {
        const box = document.createElement("div");
        box.style.cssText = "position:fixed;box-sizing:border-box;display:none;border-radius:2px";
        layer.appendChild(box);
        boxes.push(box);
      }
      return boxes[i];
    };
    let picks = [];
    let marks = [];
    let hovered = null;
    // 宿主定位（revealLine）后短暂高亮的元素；不是拾取，不上报。
    let flashed = null;
    let flashTimer = 0;
    let anchorCell = null;
    const targetOf = (node) => {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      return el && el.closest ? el.closest(attrSelector()) : null;
    };
    // 表格单元格路径 /<Sheet>/<Col><Row>（watch/1 约定）；sheet 名可含 "/"，取最后一段。
    const cellOf = (path) => {
      const cut = path ? path.lastIndexOf("/") : -1;
      const match = cut > 0 ? /^([A-Z]+)([0-9]+)$/.exec(path.slice(cut + 1)) : null;
      if (!match) return null;
      let col = 0;
      for (const ch of match[1]) col = col * 26 + ch.charCodeAt(0) - 64;
      return { sheet: path.slice(0, cut), col, row: Number(match[2]) };
    };
    const colName = (col) => {
      let name = "";
      for (; col > 0; col = Math.floor((col - 1) / 26)) {
        name = String.fromCharCode(65 + ((col - 1) % 26)) + name;
      }
      return name;
    };
    const textOf = (el) => clip(el.innerText || el.textContent, MAX_TEXT).trim();
    const single = (el) => ({ path: spanOf(el), elements: [el], text: textOf(el) || "[" + spanOf(el) + "]" });
    const rangePick = (a, b) => {
      const top = Math.min(a.row, b.row), bottom = Math.max(a.row, b.row);
      const left = Math.min(a.col, b.col), right = Math.max(a.col, b.col);
      const cells = Array.prototype.filter.call(document.querySelectorAll(attrSelector()), (el) => {
        const cell = cellOf(el.getAttribute(attrName()));
        return cell && cell.sheet === a.sheet && cell.row >= top && cell.row <= bottom && cell.col >= left && cell.col <= right;
      });
      const rows = {};
      cells.forEach((el) => {
        const cell = cellOf(el.getAttribute(attrName()));
        (rows[cell.row] = rows[cell.row] || []).push(textOf(el));
      });
      const text = Object.keys(rows).map((row) => rows[row].join("\\t")).join("\\n").trim();
      const path = a.sheet + "/" + colName(left) + top + ":" + colName(right) + bottom;
      return { path, elements: cells, text: text || "[" + path + "]" };
    };
    let frame = 0;
    const draw = () => {
      frame = 0;
      const items = marks.map((mark, index) => ({
        elements: [mark.element],
        border: mark.stale ? "2px dashed #9ca3af" : "2px solid " + mark.color,
        background: "transparent",
        color: mark.stale ? "#9ca3af" : mark.color,
        note:
          hovered && mark.note && mark.element.contains(hovered)
            ? index + 1 + " · " + mark.note
            : String(index + 1),
      }));
      if (flashed) {
        items.push({ elements: [flashed], border: "2px solid #f59e0b", background: "rgba(245,158,11,0.12)" });
      }
      picks.forEach((pick) => {
        items.push({ elements: pick.elements, border: "2px solid #2563eb", background: "rgba(37,99,235,0.08)" });
      });
      if (hovered && !picks.some((pick) => pick.elements.indexOf(hovered) >= 0)) {
        items.push({ elements: [hovered], border: "1px dashed #2563eb", background: "transparent" });
      }
      items.forEach((item, index) => {
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        item.elements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          l = Math.min(l, rect.left); t = Math.min(t, rect.top);
          r = Math.max(r, rect.right); b = Math.max(b, rect.bottom);
        });
        const box = boxAt(index);
        const visible = r > l && b > t;
        box.style.display = visible ? "block" : "none";
        if (item.note) box.setAttribute("data-berth-note", item.note);
        else box.removeAttribute("data-berth-note");
        if (!visible) return;
        box.style.left = l + "px";
        box.style.top = t + "px";
        box.style.width = r - l + "px";
        box.style.height = b - t + "px";
        box.style.border = item.border;
        box.style.background = item.background;
        box.style.setProperty("--berth-mark", item.color || "#f59e0b");
      });
      for (let i = items.length; i < boxes.length; i++) {
        boxes[i].style.display = "none";
        boxes[i].removeAttribute("data-berth-note");
      }
    };
    const redraw = () => {
      if (frame) return;
      frame = window.requestAnimationFrame
        ? window.requestAnimationFrame(draw)
        : window.setTimeout(draw, 16);
    };
    const emitPicks = (eventName, extra) => {
      const text = clip(picks.map((pick) => pick.text).join("\\n"), MAX_TEXT).trim();
      lastSelection = "";
      emit(eventName, { text, dataPaths: picks.slice(0, MAX_PATHS).map((pick) => pick.path), ...(extra || {}) });
    };
    clearPicks = () => {
      if (!picks.length) return;
      picks = [];
      anchorCell = null;
      redraw();
    };
    const pickAt = (event) => {
      const el = targetOf(event.target);
      if (!el) {
        if (clearPicks) clearPicks();
        return;
      }
      const path = pathOf(el);
      const cell = cellOf(path);
      if (event.shiftKey && anchorCell && cell && cell.sheet === anchorCell.sheet) {
        picks = [rangePick(anchorCell, cell)];
      } else if (event.ctrlKey || event.metaKey) {
        const at = picks.findIndex((item) => item.path === path);
        if (at >= 0) picks.splice(at, 1);
        else picks.push(single(el));
        anchorCell = cell;
      } else {
        picks = [single(el)];
        anchorCell = cell;
      }
      redraw();
      if (picks.length) emitPicks("selection");
    };
    // Shift 单击默认会扩展文字选区，先拦掉，交给区域拾取。
    document.addEventListener("mousedown", (event) => {
      if (active && event.button === 0 && event.shiftKey && targetOf(event.target)) event.preventDefault();
    }, true);
    document.addEventListener("click", (event) => {
      if (!active || event.button !== 0) return;
      const selection = window.getSelection ? window.getSelection() : null;
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      if (pick.toggle) {
        event.preventDefault();
        event.stopPropagation();
      }
      pickAt(event);
    }, true);
    pickedContextMenu = (event, point) => {
      if (!active) return false;
      const el = targetOf(event.target);
      if (el && !picks.some((item) => item.elements.indexOf(el) >= 0)) {
        picks = [single(el)];
        anchorCell = cellOf(pathOf(el));
        redraw();
      }
      if (!picks.length) return false;
      emitPicks("contextmenu", point);
      return true;
    };
    document.addEventListener("mousemove", (event) => {
      const el = active ? targetOf(event.target) : null;
      if (el === hovered) return;
      hovered = el;
      redraw();
    }, true);
    document.addEventListener("mouseleave", () => {
      hovered = null;
      redraw();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && clearPicks) clearPicks();
    }, true);
    window.addEventListener("scroll", redraw, true);
    window.addEventListener("resize", redraw);
    // 宿主下发：{ marks?: [{path,color,note,find,tofix,stale}], revealPath?, revealAnchor? }。
    // 路径按属性值逐个比较，不拼选择器。
    const byPath = (path) =>
      Array.prototype.find.call(
        document.querySelectorAll(attrSelector()),
        (el) => el.getAttribute(attrName()) === path
      ) || null;
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.type !== "berth:preview-view") return;
      if (pick.toggle && typeof data.pick === "boolean") {
        active = data.pick;
        if (!active) {
          picks = [];
          anchorCell = null;
          hovered = null;
        }
        redraw();
      }
      if (Array.isArray(data.marks)) {
        marks = data.marks.slice(0, 200).map((mark) => {
          const find = clip(mark && mark.find, 120);
          const tofix = clip(mark && mark.tofix, 120);
          const note = [
            clip(mark && mark.note, 200),
            find ? "「" + find + "」" + (tofix ? " → 「" + tofix + "」" : "") : "",
          ].filter(Boolean).join(" ");
          return {
            element: byPath(String((mark && mark.path) || "")),
            color: clip(mark && mark.color, 64) || "#f59e0b",
            note,
            stale: Boolean(mark && mark.stale),
          };
        }).filter((mark) => mark.element);
        redraw();
      }
      const target = typeof data.revealPath === "string"
        ? byPath(data.revealPath)
        : typeof data.revealAnchor === "string"
          ? document.getElementById(data.revealAnchor.replace(/^#/, ""))
          : null;
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" });
      // lines 模式：定位到起始行 ≤ 目标行的最后一个元素（光标所在或之前最近的元素）。
      if (pick.lines && Number.isFinite(data.revealLine)) {
        let best = null;
        let bestLine = 0;
        document.querySelectorAll(attrSelector()).forEach((el) => {
          const line = Number(el.getAttribute(attrName()));
          if (line <= data.revealLine && line >= bestLine) {
            best = el;
            bestLine = line;
          }
        });
        if (best) {
          if (best.scrollIntoView) best.scrollIntoView({ block: "center" });
          flashed = best;
          redraw();
          window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => {
            flashed = null;
            redraw();
          }, 1500);
        }
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupElementPick);
  } else {
    setupElementPick();
  }
  const resetSelection = () => {
    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || !selection.toString().trim()) lastSelection = "";
  };
  document.addEventListener("mouseup", readSelection, true);
  document.addEventListener("keyup", readSelection, true);
  document.addEventListener("selectionchange", resetSelection, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  const readDocument = () => {
    const content = clip(document.body ? document.body.innerText : "", MAX_DOCUMENT);
    if (content === lastDocument) return;
    lastDocument = content;
    emit("document", { content });
  };
  const scheduleDocument = () => {
    if (documentTimer) window.clearTimeout(documentTimer);
    documentTimer = window.setTimeout(() => {
      documentTimer = 0;
      readDocument();
    }, 180);
  };
  window.addEventListener(
    "load",
    scheduleDocument,
    { once: true }
  );
  if (window.MutationObserver) {
    const observer = new MutationObserver(scheduleDocument);
    observer.observe(document.documentElement || document, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
})();
`

/**
 * Parse messages emitted by a renderer-owned iframe.  The caller must still
 * verify `MessageEvent.source` against the exact iframe window; this function
 * only validates the payload shape and bounds the data before it reaches the
 * document-context module.
 */
export function parseDocumentFrameContextMessage(
  value: unknown
): DocumentFrameContextMessage | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.type !== DOCUMENT_FRAME_CONTEXT_MESSAGE ||
    (candidate.event !== "selection" &&
      candidate.event !== "document" &&
      candidate.event !== "contextmenu") ||
    typeof candidate.url !== "string" ||
    !/^(?:https?:\/\/|about:srcdoc$)/i.test(candidate.url)
  ) {
    return null
  }

  const clip = (input: unknown, limit: number): string | null => {
    if (typeof input !== "string") return null
    const value = input.slice(0, limit).trim()
    return value || null
  }
  const clipContent = (input: unknown, limit: number): string | null =>
    typeof input === "string" ? input.slice(0, limit) : null
  const clipCoordinate = (input: unknown): number | null => {
    const value = typeof input === "number" ? input : Number(input)
    return Number.isFinite(value) ? value : null
  }

  const message: DocumentFrameContextMessage = {
    type: DOCUMENT_FRAME_CONTEXT_MESSAGE,
    event: candidate.event,
    generation: clip(candidate.generation, 128),
    url: candidate.url,
    title: clip(candidate.title, 4096),
    text: clip(candidate.text, 64 * 1024),
    content: clipContent(candidate.content, 512 * 1024),
  }
  if (candidate.event !== "document" && Array.isArray(candidate.dataPaths)) {
    const paths = candidate.dataPaths
      .slice(0, 50)
      .map((path) => clip(path, 512))
      .filter((path): path is string => path !== null)
    message.dataPaths = paths.length ? paths : null
  }
  if (candidate.event === "contextmenu") {
    message.clientX = clipCoordinate(candidate.clientX)
    message.clientY = clipCoordinate(candidate.clientY)
  }
  if (
    (message.event === "selection" || message.event === "contextmenu") &&
    !message.text
  ) {
    return null
  }
  return message
}
