# 构建后运行：python3 plugins/excalidraw/src/test/library.browser.py
# 运行真实画板及原生持久化适配器；宿主存储是隔离内存，不触碰用户数据。
import json
import mimetypes
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2] / 'page'
storage = {}
scene = {'type': 'excalidraw', 'version': 2, 'elements': [
    {'id': 'box', 'groupIds': ['original-group'], 'type': 'rectangle', 'x': 10, 'y': 10, 'width': 160, 'height': 100, 'boundElements': [{'id': 'text', 'type': 'text'}, {'id': 'arrow', 'type': 'arrow'}]},
    {'id': 'text', 'type': 'text', 'x': 25, 'y': 30, 'width': 70, 'height': 25, 'text': 'shape', 'originalText': 'shape', 'containerId': 'box', 'fontSize': 20, 'fontFamily': 1},
    {'id': 'box2', 'groupIds': ['original-group'], 'type': 'rectangle', 'x': 300, 'y': 10, 'width': 160, 'height': 100, 'boundElements': [{'id': 'arrow', 'type': 'arrow'}]},
    {'id': 'arrow', 'groupIds': ['original-group'], 'type': 'arrow', 'x': 170, 'y': 60, 'width': 130, 'height': 0, 'points': [[0,0],[130,0]], 'startBinding': {'elementId':'box','focus':0,'gap':1}, 'endBinding': {'elementId':'box2','focus':0,'gap':1}},
], 'appState': {}, 'files': {}}
bridge = '''(() => {
  const model = window.__canvasTest = { request: null, content: INITIAL_SCENE, failSave: false };
  const context = { kind: 'editor', mode: 'edit', id: 'drawing', path: 'drawing.excalidraw', readOnly: false,
    load: async () => model.content, change: text => model.content = text,
    onExternalChange: () => () => {}, onFlush: () => () => {}, onDrop: () => () => {},
    onRequest: f => {model.request=f; return () => {if(model.request===f) model.request=null}}, notify: () => {} };
  window.berth = { ready: Promise.resolve(), ui: {context, locale:'zh-CN', theme:async()=> 'light', onTheme:()=>()=>{}, notify:async()=>{}},
    storage:{get:key=>window.testStorageGet(key),set:(key,value)=>model.failSave?Promise.reject(Error('disk full')):window.testStorageSet(key,value)},
    env:{project:async()=>({root:'/test'})},files:{readBase64:async()=>'',open:async()=>{}}, scripts:{run:async()=>({})} };
})();'''.replace('INITIAL_SCENE', json.dumps(json.dumps(scene)))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1100, 'height': 800})
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.expose_function('testStorageGet', lambda key: storage.get(key))
    page.expose_function('testStorageSet', lambda key, value: storage.update({key: value}))
    def serve(route):
        path = root / route.request.url.split('http://plugin.test/', 1)[1].split('?')[0]
        if not path.is_file():
            route.fulfill(status=404, body='not found')
            return
        route.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(path)[0] or 'application/octet-stream')
    page.route('http://plugin.test/**', serve)
    page.add_init_script(bridge)
    def ready():
        page.wait_for_function('async () => { try { return (await __canvasTest.request("library.list")).length >= 0 } catch { return false } }')
    def call(method, data=None):
        return page.evaluate('([method,input]) => __canvasTest.request(method,input)', [method, data])
    def saved(count):
        page.wait_for_function('async n => { const d=await testStorageGet("shape-library"); return d?.libraryItems.length === n }', arg=count)
    page.goto('http://plugin.test/index.html')
    page.wait_for_load_state('networkidle')
    ready()
    assert page.locator('.default-sidebar-trigger').is_hidden()
    page.locator('.excalidraw-container').press('Control+a')
    page.wait_for_function('async () => (await __canvasTest.request("state")).selected > 0')
    call('library.add')
    saved(1)
    items = call('library.list')
    assert items[0]['count'] == 4, items
    call('library.insert', {'id': items[0]['id']})
    call('library.insert', {'id': items[0]['id']})
    elements = json.loads(call('snapshot')['content'])['elements']
    assert len(elements) == 12, elements
    ids = {e['id'] for e in elements}
    assert len(ids) == 12
    for element in elements:
        if element.get('containerId'):
            assert element['containerId'] in ids
        if element['id'] not in {'box','box2','arrow','text'}:
            assert element.get('containerId') != 'box'
            assert 'original-group' not in element.get('groupIds', [])
            for binding in ('startBinding','endBinding'):
                if element.get(binding):
                    assert element[binding]['elementId'] in ids - {'box','box2','arrow','text'}
    exported = json.loads(call('library.export'))
    assert exported['type'] == 'excalidrawlib' and len(exported['libraryItems']) == 1
    error = page.evaluate('async () => { try { await __canvasTest.request("library.import",{content:"not JSON"}) } catch(e) { return e.message } }')
    assert error and len(call('library.list')) == 1
    # 导入同 ID 的不同版本，不能导致素材 ID 冲突或覆盖原素材。
    exported['libraryItems'][0]['elements'][0]['versionNonce'] += 1
    exported['libraryItems'][0]['elements'][0]['strokeColor'] = '#ff0000'
    call('library.import', {'content': json.dumps(exported)})
    saved(2)
    assert len({item['id'] for item in call('library.list')}) == 2
    # 多选插入走同一个原生拖放入口，导出只带选中的素材。
    batch = [item['id'] for item in call('library.list')]
    call('library.insert', {'ids': batch})
    assert len(json.loads(call('snapshot')['content'])['elements']) == 20
    assert len(json.loads(call('library.export', {'ids': batch[:1]}))['libraryItems']) == 1
    rejected = page.evaluate('async () => { try { await __canvasTest.request("library.remove",{ids:["unknown"]}) } catch(e) { return e.message } }')
    assert rejected and len(call('library.list')) == 2
    legacy = {'type': 'excalidrawlib', 'version': 1, 'library': [[{'id': 'legacy-shape', 'type': 'ellipse', 'versionNonce': 42, 'x': 0, 'y': 0, 'width': 100, 'height': 50}]]}
    call('library.import', {'content': json.dumps(legacy), 'published': True, 'name': 'Public legacy'})
    saved(3)
    assert any(item.get('status') == 'published' and item.get('name') == 'Public legacy 1' for item in call('library.list'))
    page.reload()
    page.wait_for_load_state('networkidle')
    ready()
    assert len(call('library.list')) == 3, 'library disappeared on reopen'
    page.locator('.excalidraw-container').press('Control+a')
    page.wait_for_function('async () => (await __canvasTest.request("state")).selected > 0')
    page.evaluate('__canvasTest.failSave = true')
    call('library.add')
    page.wait_for_function('async () => (await __canvasTest.request("state")).libraryError?.includes("disk full")')
    blocked = page.evaluate('async () => { try { await __canvasTest.request("library.add") } catch(e) { return e.message } }')
    assert blocked, 'mutation was allowed while the previous save had failed'
    page.evaluate('__canvasTest.failSave = false')
    call('library.retry')
    saved(4)
    assert call('state')['libraryError'] is None
    call('library.remove', {'ids': [item['id'] for item in call('library.list')]})
    saved(0)
    # 启动时遇到坏存储不能当成空库覆盖；修复数据后可直接重试载入。
    storage['shape-library'] = {'libraryItems': 'corrupt data'}
    page.reload()
    page.wait_for_load_state('networkidle')
    page.wait_for_function('async () => { try { return (await __canvasTest.request("state")).libraryError !== null } catch { return false } }')
    blocked = page.evaluate('async () => { try { await __canvasTest.request("library.add") } catch(e) { return e.message } }')
    assert blocked and storage['shape-library']['libraryItems'] == 'corrupt data'
    storage['shape-library'] = {'libraryItems': []}
    call('library.retry')
    assert call('state')['libraryError'] is None and call('library.list') == []
    assert not errors, errors
    browser.close()
print('PASS: native library selection + bound text, repeated + batch insert with fresh IDs, selected export, legacy public import, reopen persistence, save/load failure + retry, removal; no browser errors')
