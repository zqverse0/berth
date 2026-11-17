# 构建后运行：python3 plugins/excalidraw/src/test/sidebar.browser.py
# 浏览器验证真实构建产物；宿主桥用内存替身，不修改用户画板。
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import mimetypes

root = Path(__file__).resolve().parents[2] / 'page'
bridge = r'''(() => {
  const model = window.__sidebarTest = { path: 'a.excalidraw', content: 'latest unsaved', attach: [], restored: [], header: null, changes: [], drops: [], library: [], inserted: [], exported: null, failPublic: false, downloads: [], copied: [], failCopy: false };
  const listeners = [];
  window.berth = {
    ready: Promise.resolve(),
    ui: { locale: 'zh-CN', context: { kind:'view', onDrop: f => {model.drops.push(f); return () => {}} }, setHeaderTabs: async (tabs, value) => { model.tabs=tabs }, onHeaderTab: f => { model.header=f; return () => {} }, notify: async () => {} },
    editor: {
      active: async () => model.path ? {path: model.path} : null,
      onChange: f => { listeners.push(f); return () => {} },
      request: async (path, method, input) => {
        if (path !== model.path) throw Error('wrong drawing');
        if (method === 'state') return {path:'/repo/'+path,selected:2,revision:0};
        if (method === 'library.list') return model.library;
        if (method === 'library.add') { model.library.push({id:'shape-'+model.library.length,name:'测试素材',count:2}); return; }
        if (method === 'library.render') return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
        if (method === 'library.insert') {model.inserted.push(input.ids ?? [input.id]);return;}
        if (method === 'library.remove') {model.library=model.library.filter(i=>!(input.ids ?? [input.id]).includes(i.id));return;}
        if (method === 'library.export') return JSON.stringify({type:'excalidrawlib',libraryItems:input?.ids?model.library.filter(i=>input.ids.includes(i.id)):model.library});
        if (method === 'library.import') {const data=JSON.parse(input.content);if(data.type!=='excalidrawlib')throw Error('invalid library');model.library.push(...data.libraryItems.map(i=>({...i,status:input.published?'published':i.status})));return;}
        if (method === 'snapshot') return {content:model.content,selection:['rect-1 (rectangle)']};
        if (method === 'render') return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
        if (method === 'restore') { if(input.expected !== model.content) throw Error('conflict'); model.content=input.content; model.restored.push(input); }
      }
    },
    scripts: {run: async (script,input) => {
      if(input.action === 'publicCatalog') {if(model.failPublic)throw Error('catalog unavailable');return [{id:'network',name:'Network diagrams',description:'Nodes and networks',authors:'Author',source:'author/network.excalidrawlib'}];}
      if(input.action === 'publicLibrary') {model.downloads.push(input.source);return {content:JSON.stringify({type:'excalidrawlib',libraryItems:[{id:'public',name:'network symbol',count:4}]})};}
      if(input.action === 'exportShapes') {model.exported=input.content;return {path:'/repo/figures/library.excalidrawlib'};}
      if(script.endsWith('library.js')) return {dir:'/library',items:[],removed:[]};
      if(input.action === 'get' || input.action === 'restore') return {content:'old version'};
      return {versions:[{id:1,by:'agent',hash:'x',time:0}]};
    }},
    agent: {attach: async item => model.attach.push(item)},
    storage: {get: async () => []},
    env: {project: async () => ({root:'/repo'})},
    files: {open: async path => model.opened=path},
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if(model.failCopy)throw Error('clipboard blocked'); model.copied.push(text); } } });
  document.execCommand = () => false;
  model.change = async path => {model.path=path; for(const f of listeners) await f()};
})();'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 330, 'height': 760})
    errors = []
    page.set_default_timeout(7000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    def serve(route):
        path = root / route.request.url.split('http://plugin.test/', 1)[1].split('?')[0]
        route.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(path)[0] or 'application/octet-stream')
    page.route('http://plugin.test/**', serve)
    page.add_init_script(bridge)
    page.goto('http://plugin.test/sidebar.html')
    page.wait_for_load_state('networkidle')
    page.wait_for_function('window.__sidebarTest.header !== null')
    assert page.evaluate('__sidebarTest.tabs.map(t=>t.label)') == ['图库', '素材库', '改图']
    page.evaluate('__sidebarTest.header("revise")')
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_be_visible()
    expect(page.get_by_text('当前画板：a.excalidraw', exact=True)).to_be_visible()
    page.get_by_role('textbox', name='修改要求', exact=True).fill('改成蓝色')
    page.evaluate('__sidebarTest.header("gallery")')
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_be_hidden()
    page.evaluate('__sidebarTest.header("revise")')
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_have_value('改成蓝色')
    page.get_by_role('button', name='保存要求并复制给 Agent').click()
    page.wait_for_function('__sidebarTest.copied.length === 1')
    copied = page.evaluate('__sidebarTest.copied[0]')
    assert all(part in copied for part in ['/repo/a.excalidraw', '改成蓝色', 'rect-1', 'private/history.js apply'])
    assert page.evaluate('__sidebarTest.attach.length') == 0
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_have_value('改成蓝色')
    expect(page.get_by_role('textbox', name='给 Agent 的修改说明')).to_have_value(copied)
    # 沙箱不允许自动复制时，说明仍可手动选中复制，要求不丢失。
    page.evaluate('__sidebarTest.failCopy = true')
    page.get_by_role('textbox', name='修改要求', exact=True).fill('复制失败也要保留的要求')
    page.get_by_role('button', name='保存要求并复制给 Agent').click()
    expect(page.get_by_role('alert')).to_contain_text('自动复制失败')
    assert '复制失败也要保留的要求' in page.get_by_role('textbox', name='给 Agent 的修改说明').input_value()
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_have_value('复制失败也要保留的要求')
    assert page.evaluate('__sidebarTest.attach.length') == 0
    page.evaluate('__sidebarTest.failCopy = false')
    page.get_by_role('button', name='对比', exact=True).click()
    expect(page.locator('.berth-compare img')).to_have_count(2)
    page.locator('.berth-compare').get_by_role('button', name='回到这一版').click()
    page.wait_for_function('__sidebarTest.restored.length === 1')
    assert page.evaluate('__sidebarTest.restored[0].expected') == 'latest unsaved'
    page.evaluate('__sidebarTest.header("library")')
    page.get_by_role('button', name='收藏选中元素').click()
    expect(page.get_by_role('button', name='插入测试素材')).to_be_visible()
    page.get_by_role('button', name='插入测试素材').click()
    page.wait_for_function('__sidebarTest.inserted.length === 1')
    page.get_by_role('button', name='导出到项目').click()
    page.wait_for_function('__sidebarTest.exported !== null')
    assert 'excalidrawlib' in page.evaluate('__sidebarTest.exported')
    page.locator('input[type=file]').set_input_files({'name':'test.excalidrawlib','mimeType':'application/json','buffer':'{"type":"excalidrawlib","libraryItems":[{"id":"imported","name":"导入素材","count":1}]}'.encode()})
    expect(page.get_by_role('button', name='插入导入素材')).to_be_visible()
    page.get_by_role('button', name='移除导入素材').click()
    assert page.evaluate('__sidebarTest.library.length') == 2
    page.get_by_role('button', name='确认移除').click()
    expect(page.get_by_role('button', name='插入导入素材')).to_have_count(0)
    # 官方目录失败可重试，不影响本地素材；搜索后可直接添加。
    page.evaluate('__sidebarTest.failPublic = true')
    page.get_by_role('button', name='浏览公开素材库 · 添加素材').click()
    expect(page.get_by_text('catalog unavailable', exact=True)).to_be_visible()
    assert page.evaluate('__sidebarTest.library.length') == 1
    page.evaluate('__sidebarTest.failPublic = false')
    page.get_by_role('button', name='重试加载目录').click()
    page.get_by_role('searchbox', name='搜索公开素材').fill('network')
    page.get_by_role('button', name='添加 Network diagrams').click()
    expect(page.get_by_role('button', name='插入network symbol')).to_be_visible()
    assert page.evaluate('__sidebarTest.downloads') == ['author/network.excalidrawlib']
    page.get_by_role('checkbox', name='选择全部素材').check()
    page.get_by_role('button', name='插入选中素材').click()
    page.wait_for_function('__sidebarTest.inserted.length === 2')
    assert len(page.evaluate('__sidebarTest.inserted[1]')) == 2
    page.get_by_role('button', name='导出选中素材').click()
    page.get_by_role('button', name='移除选中素材').click()
    page.get_by_role('button', name='确认移除').click()
    page.wait_for_function('__sidebarTest.library.length === 0')
    page.evaluate('__sidebarTest.header("revise")')
    page.get_by_role('textbox', name='修改要求', exact=True).fill('A 的草稿')
    page.evaluate('__sidebarTest.change("b.excalidraw")')
    expect(page.get_by_text('当前画板：b.excalidraw', exact=True)).to_be_visible()
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_have_value('')
    page.get_by_role('textbox', name='修改要求', exact=True).fill('B 的草稿')
    page.evaluate('__sidebarTest.change("a.excalidraw")')
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_have_value('A 的草稿')
    page.evaluate('__sidebarTest.change("b.excalidraw")')
    expect(page.get_by_role('textbox', name='修改要求', exact=True)).to_have_value('B 的草稿')
    page.evaluate('__sidebarTest.change(null)')
    expect(page.get_by_text('打开一张可编辑的 Excalidraw 画板，即可在这里改图。')).to_be_visible()
    assert not errors, errors
    page.screenshot(path='/tmp/berth-sidebar-browser.png')
    browser.close()
print('PASS: sidebar tabs, draft retention, selection, copy-only instructions + manual fallback, compare, safe restore, public browse/search/add/retry, batch shape operations, per-file drafts, drawing switch and empty state; no browser errors')
