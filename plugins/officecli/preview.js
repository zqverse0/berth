// OfficeCLI preview adapter (org.berth.preview.script): officecli's own viewer
// scripts are blocked by Berth's strict CSP, so re-run the bits the preview
// needs: pptx fit-to-width (960pt slides overflow narrow panels; the
// JS-populated thumbnail sidebar is hidden) and xlsx sheet tabs. Scroll
// position and active sheet survive live-refresh srcdoc swaps via window.name
// (storage APIs are off in the opaque-origin sandbox).
;(function () {
  var KEY = "berth-office-view:",
    timer = 0
  function scroller() {
    var c = [
      document.querySelector(".main"),
      document.querySelector(".sheet-content.active .table-wrapper"),
    ]
    for (var i = 0; i < c.length; i++)
      if (c[i] && c[i].scrollHeight > c[i].clientHeight) return c[i]
    return document.scrollingElement
  }
  function save() {
    var s = scroller(),
      tab = document.querySelector(".sheet-tab.active")
    window.name =
      KEY +
      JSON.stringify({
        top: s ? s.scrollTop : 0,
        left: s ? s.scrollLeft : 0,
        sheet: tab ? tab.getAttribute("data-sheet") : null,
      })
  }
  function showSheet(id) {
    document.querySelectorAll(".sheet-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-sheet") === id)
    })
    document.querySelectorAll(".sheet-content").forEach(function (c) {
      c.classList.toggle("active", c.getAttribute("data-sheet") === id)
    })
  }
  function fit() {
    var main = document.querySelector(".main")
    if (!main) return
    var w = main.clientWidth - 40
    document
      .querySelectorAll(".main > .slide-container .slide")
      .forEach(function (s) {
        var d = s.offsetWidth,
          k = w > 0 && d > w ? w / d : 1,
          p = s.parentElement,
          n = s.closest(".slide-container").querySelector(".slide-notes")
        s.style.transform = k < 1 ? "scale(" + k + ")" : ""
        s.style.transformOrigin = "center top"
        p.style.width = k < 1 ? d * k + "px" : ""
        p.style.height = k < 1 ? s.offsetHeight * k + "px" : ""
        if (n) n.style.width = k < 1 ? d * k + "px" : ""
      })
  }
  addEventListener(
    "scroll",
    function () {
      clearTimeout(timer)
      timer = setTimeout(save, 100)
    },
    true
  )
  document.addEventListener("click", function (e) {
    var tab = e.target.closest && e.target.closest(".sheet-tab[data-sheet]")
    if (!tab) return
    showSheet(tab.getAttribute("data-sheet"))
    save()
  })
  document.addEventListener("DOMContentLoaded", function () {
    if (document.querySelector(".slide-container")) {
      document
        .querySelectorAll(".sidebar,.sidebar-toggle,.toggle-zone")
        .forEach(function (e) {
          e.style.display = "none"
        })
      fit()
      addEventListener("resize", fit)
    }
  })
  addEventListener("load", function () {
    var state = null
    try {
      if (window.name.indexOf(KEY) === 0)
        state = JSON.parse(window.name.slice(KEY.length))
    } catch (_) {}
    if (!state) return
    if (
      state.sheet != null &&
      [].some.call(document.querySelectorAll(".sheet-tab"), function (t) {
        return t.getAttribute("data-sheet") === String(state.sheet)
      })
    )
      showSheet(String(state.sheet))
    var s = scroller()
    if (s)
      s.scrollTo({
        top: state.top || 0,
        left: state.left || 0,
        behavior: "instant",
      })
  })
})()
