// 字体随包放在 page/fonts/，画板与导出 SVG 都从这里取。放成文件不内联：CEF 往页面 CSP 里追加脚本哈希后内联脚本会被拦。
// 必须是 main.jsx 的第一个 import，先于 excalidraw 执行。
window.EXCALIDRAW_ASSET_PATH = new URL("./", location.href).href
