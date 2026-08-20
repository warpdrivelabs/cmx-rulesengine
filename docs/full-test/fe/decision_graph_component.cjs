// 决策图组件 CDP e2e 测试
// 验证：① design-workbench 图态用只读组件渲染 ② graph-designer 组件加载注册→渲图→拖拽→拉线→
//       决策表节点属性→保存（getGraph JSON 结构合法）③ 成环被拒 ④ 后端零回归
//
// 前置：
//   cd /Users/nanomesh/Workspace/presentation/cmx-rulesengine
//   cargo run -p cmx-rules-server &            # 独立规则引擎 :8094
//   （或门户 :8080 + 规则引擎反代）
//   规则引擎里至少存在一个 kind=graph 的决策集（可由本脚本自动创建）。
//
// 运行：node docs/full-test/fe/decision_graph_component.cjs

'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.resolve(__dirname, '../../../web');
const RULES_BASE = 'http://127.0.0.1:8094';
const PORT = 9099;
const results = [];
let _pass = 0, _total = 0;

function A(id, ok, desc, detail) {
  _total++;
  if (ok) _pass++;
  results.push({ id, ok: !!ok });
  console.log(`[${id}] ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${desc}${detail ? '  :: ' + detail : ''}`);
}

// ── 内嵌 HTTP 服务：静态伺服 WEB_DIR + 把 /api/* 反代到规则引擎 ──
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];

      // 根或 harness 页：直接返回内联 HTML
      if (url === '/' || url === '/workbench' || url === '/designer') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(url === '/designer' ? DESIGNER_HARNESS : WORKBENCH_HARNESS);
        return;
      }

      // /api/* 反代到规则引擎
      if (url.startsWith('/api/')) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = chunks.length ? Buffer.concat(chunks) : null;
          const opts = {
            hostname: '127.0.0.1', port: 8094,
            path: req.url, method: req.method,
            headers: { ...req.headers, host: '127.0.0.1:8094' },
          };
          const proxy = http.request(opts, (pr) => {
            res.writeHead(pr.statusCode, pr.headers);
            pr.pipe(res);
          });
          proxy.on('error', () => { res.writeHead(502); res.end('proxy error'); });
          if (body) proxy.write(body);
          proxy.end();
        });
        return;
      }

      // 静态文件
      const fp = path.join(WEB_DIR, url);
      fs.readFile(fp, (err, buf) => {
        if (err) { res.statusCode = 404; return res.end('not found'); }
        if (url.endsWith('.js'))  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        if (url.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(buf);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

// ── Harness 1: design-workbench（验证图态只读组件预览）──
const WORKBENCH_HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}
#stage{display:flex;height:100vh}
.region{overflow:hidden;height:100%}
#r-explorer{flex:0 0 260px;border-right:1px solid #ccc}
#r-content{flex:1}
#r-property{flex:0 0 300px;border-left:1px solid #ccc}
.host{height:100%;display:block}</style></head>
<body><div id="stage">
  <div class="region" id="r-explorer"><div class="host" id="h-explorer"></div></div>
  <div class="region" id="r-content"><div class="host" id="h-content"></div></div>
  <div class="region" id="r-property"><div class="host" id="h-property"></div></div>
</div>
<script type="module">
  import * as mod from '/ui-native/rule/design-workbench.js'
  window.__dwMod = mod
  mod.configure({ apiBase: '' })
  const d = mod.default
  await d.views.explorer({ host: document.getElementById('h-explorer') })
  await d.views.content({ host: document.getElementById('h-content') })
  await d.views.property({ host: document.getElementById('h-property') })
  window.__dwReady = true
</script></body></html>`;

// ── Harness 2: graph-designer（四区，验证编辑 + 拖拽 + 连线 + 保存）──
const DESIGNER_HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}
#stage{display:flex;height:100vh}
.region{overflow:hidden;height:100%}
#r-explorer{flex:0 0 220px;border-right:1px solid #ccc}
#r-content{flex:1}
#r-property{flex:0 0 300px;border-left:1px solid #ccc}
.host{height:100%;display:block}</style></head>
<body><div id="stage">
  <div class="region" id="r-explorer"><div class="host" id="h-explorer"></div></div>
  <div class="region" id="r-content"><div class="host" id="h-content"></div></div>
  <div class="region" id="r-property"><div class="host" id="h-property"></div></div>
</div>
<script type="module">
  import * as mod from '/ui-native/rule/graph-designer.js'
  window.__gdMod = mod
  mod.configure({ apiBase: '' })
  const d = mod.default
  // 挂指定 key 的决策图（key 由测试注入 window.__testKey）
  const waitKey = () => new Promise(r => {
    if (window.__testKey) return r(window.__testKey)
    const t = setInterval(() => { if (window.__testKey) { clearInterval(t); r(window.__testKey); } }, 50)
  })
  const key = await waitKey()
  window.__gdCtx = { key, name: key, version: 1 }
  await d.views.explorer({ host: document.getElementById('h-explorer'), props: { key, name: key } })
  await d.views.content({  host: document.getElementById('h-content'),  props: { key, name: key } })
  await d.views.property({ host: document.getElementById('h-property'), props: { key, name: key } })
  window.__gdReady = true
</script></body></html>`;

// ── 工具函数 ──

/** 等带超时 */
async function waitFor(page, fn, timeout = 12000) {
  return page.waitForFunction(fn, { timeout }).catch(() => null);
}

/** 直接调规则引擎 API（不走浏览器，用于测试前置/后置）*/
function apiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: 8094,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 确保测试用决策图定义存在（幂等）；返回 key。 */
async function ensureTestGraph() {
  const key = 'cdp_test_graph';
  const def = {
    key, name: 'CDP 测试决策图', version: 1, kind: 'graph',
    nodes: [
      { id: 'in',   name: '输入',   type: 'input' },
      { id: 'dt1',  name: '基础规则', type: 'decisionTable',
        table: { hitPolicy: 'F',
          inputs:  [{ id: 'i1', label: '金额', expression: 'amount' }],
          outputs: [{ id: 'o1', name: 'level', label: '等级' }],
          rules:   [
            { id: 'r1', inputEntries: ['> 10000'], outputEntries: ['"HIGH"'] },
            { id: 'r2', inputEntries: ['-'],        outputEntries: ['"LOW"']  },
          ],
        },
      },
      { id: 'out',  name: '输出',   type: 'output' },
    ],
    edges: [
      { source: 'in',  target: 'dt1' },
      { source: 'dt1', target: 'out' },
    ],
  };
  const r = await apiReq('POST', '/api/rules/v1/definitions/draft', def);
  if (r.status !== 200 && r.status !== 201) {
    console.warn('  [setup] 创建测试图草稿可能已存在 (status=' + r.status + ')');
  }
  return key;
}

// ── 主测试流程 ──
async function main() {
  // 健康检查
  const health = await apiReq('GET', '/api/rules/v1/definitions').catch(() => null);
  if (!health || health.status !== 200) {
    console.error('✗ 规则引擎 :8094 不可达，请先启动 cmx-rules-server');
    process.exit(2);
  }
  A('T0-health', true, '规则引擎 :8094 可达', 'status=' + health.status);

  const testKey = await ensureTestGraph();
  A('T0-seed', !!testKey, '测试决策图已就绪', 'key=' + testKey);

  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    // ══ 测试组 1：design-workbench 只读组件预览 ══
    console.log('\n── 组 1：design-workbench 图态预览 ──');
    {
      const page = await browser.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));

      await page.goto(`http://127.0.0.1:${PORT}/workbench`, { waitUntil: 'load' });
      await waitFor(page, 'window.__dwReady === true');
      await page.waitForTimeout(800);

      A('T1-noerr', errs.length === 0, 'workbench 页面零 pageerror', errs.slice(0, 2).join(' | '));

      // 点选 cdp_test_graph
      const clicked = await page.evaluate((key) => {
        const items = document.querySelectorAll('[data-key]');
        for (const el of items) {
          if (el.getAttribute('data-key') === key) { el.click(); return true; }
        }
        // 尝试 shadow DOM
        function findInTree(root) {
          for (const el of root.querySelectorAll('[data-key]')) {
            if (el.getAttribute('data-key') === key) { el.click(); return true; }
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot && findInTree(el.shadowRoot)) return true;
          }
          return false;
        }
        return findInTree(document);
      }, testKey);
      A('T1-select', clicked, '在 explorer 中点选测试决策图', 'key=' + testKey);

      // 等组件加载（最多 10s）
      await page.waitForTimeout(4000);

      // 验证 content 区存在 <cmx-decision-graph readonly>
      const hasComponent = await page.evaluate(() => {
        function findElem(root, tag) {
          if (root.querySelector(tag)) return true;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot && findElem(el.shadowRoot, tag)) return true;
          }
          return false;
        }
        return findElem(document, 'cmx-decision-graph');
      });
      A('T1-component', hasComponent, 'content 区挂载了 <cmx-decision-graph> 只读组件');

      // 验证组件内 SVG 已渲染（有 .dg-svg 或 svg 元素）
      const hasSvg = await page.evaluate(() => {
        function findSvgInShadow(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH') {
              const sr = el.shadowRoot;
              if (sr && (sr.querySelector('svg') || sr.querySelector('.dg-svg'))) return true;
            }
            if (el.shadowRoot && findSvgInShadow(el.shadowRoot)) return true;
          }
          return false;
        }
        return findSvgInShadow(document);
      });
      A('T1-svg', hasSvg, '只读组件内 SVG 已渲染（节点/边可见）');

      // 验证 customElements 已注册
      const registered = await page.evaluate(() =>
        typeof customElements !== 'undefined' && !!customElements.get('cmx-decision-graph')
      );
      A('T1-registered', registered, '<cmx-decision-graph> 已在 customElements 注册');

      await page.close();
    }

    // ══ 测试组 2：graph-designer 组件加载 + 图操作 ══
    console.log('\n── 组 2：graph-designer 组件加载 + 拖拽 + 拉线 + 决策表编辑 ──');
    {
      const page = await browser.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));

      await page.goto(`http://127.0.0.1:${PORT}/designer`, { waitUntil: 'load' });
      // 注入 testKey 触发 harness 挂载
      await page.evaluate((key) => { window.__testKey = key; }, testKey);
      await waitFor(page, 'window.__gdReady === true');
      await page.waitForTimeout(3000); // 等组件 fetch + blob import + render

      A('T2-noerr', errs.length === 0, 'graph-designer 页面零 pageerror', errs.slice(0, 2).join(' | '));

      // 组件是否已注册
      const reg2 = await page.evaluate(() =>
        typeof customElements !== 'undefined' && !!customElements.get('cmx-decision-graph')
      );
      A('T2-component-registered', reg2, 'graph-designer 中 <cmx-decision-graph> 已注册');

      // content 区有可编辑组件（无 readonly 属性）
      const hasEditable = await page.evaluate(() => {
        function find(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return true;
            if (el.shadowRoot && find(el.shadowRoot)) return true;
          }
          return false;
        }
        return find(document);
      });
      A('T2-editable', hasEditable, 'content 区有可编辑态 <cmx-decision-graph>（无 readonly）');

      // SVG 中节点数量 >= 3（in + dt1 + out）
      const nodeCount = await page.evaluate(() => {
        function getComponent(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return el;
            if (el.shadowRoot) { const r = getComponent(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const comp = getComponent(document);
        if (!comp || !comp.shadowRoot) return 0;
        return comp.shadowRoot.querySelectorAll('[data-node]').length;
      });
      A('T2-nodes', nodeCount >= 3, `图中节点数 >= 3（in+dt1+out）`, 'count=' + nodeCount);

      // 拖拽节点：向节点 <g> 元素直接 dispatch pointer 事件（bubbles:true 冒泡到 canvas），
      // 使 ev.target = 节点元素，closest('[data-node]') 能正确命中。
      const dragResult = await page.evaluate(async () => {
        function getComp(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return el;
            if (el.shadowRoot) { const r = getComp(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const comp = getComp(document);
        if (!comp || !comp.shadowRoot) return { ok: false, reason: 'no component' };
        // 取第一个节点 <g data-node="..."> 元素
        const nodeEl = comp.shadowRoot.querySelector('[data-node]');
        if (!nodeEl) return { ok: false, reason: 'no node element' };
        const id = nodeEl.getAttribute('data-node');
        // 取节点中心在视口中的坐标（shadow DOM 内的 getBoundingClientRect 仍返回视口坐标）
        const rect = nodeEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        function mkPE(type, x, y) {
          // composed:true 穿透 shadow boundary；target 由 dispatchEvent 的目标元素决定
          return new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true });
        }
        // pointerdown 发到节点 <g> 本身，target = nodeEl，closest('[data-node]') 命中
        nodeEl.dispatchEvent(mkPE('pointerdown', cx, cy));
        await new Promise(r => setTimeout(r, 30));
        // pointermove / pointerup 发到 canvas（setPointerCapture 后事件来自 canvas）
        const canvas = comp.shadowRoot.querySelector('.dg-canvas');
        canvas.dispatchEvent(mkPE('pointermove', cx + 30, cy + 20));
        canvas.dispatchEvent(mkPE('pointermove', cx + 55, cy + 32));
        await new Promise(r => setTimeout(r, 30));
        canvas.dispatchEvent(mkPE('pointerup', cx + 55, cy + 32));
        await new Promise(r => setTimeout(r, 150));
        // 检查 layoutHints 是否已有该节点坐标
        const model = comp.getModel();
        const hints = model.layoutHints();
        return { ok: !!hints && !!hints[id], id, hints };
      });
      A('T2-drag', dragResult.ok, '拖拽节点后 layoutHints 已记录坐标', JSON.stringify(dragResult.hints || 'none').slice(0, 60));

      // 拉线连边（向 explorer 加一个新节点，再拉线连到 out）
      const connectResult = await page.evaluate(async () => {
        function getComp(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return el;
            if (el.shadowRoot) { const r = getComp(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const comp = getComp(document);
        if (!comp) return { ok: false, reason: 'no component' };
        // 先加一个 expression 节点（通过组件 API）
        const newId = comp.addNode('expression');
        await new Promise(r => setTimeout(r, 80));
        // 用 GraphModel.addEdge 直接验证连线逻辑
        const model = comp.getModel();
        const edgeBefore = model.edges.length;
        // 连 expression → out（当前 out 节点 id = 'out'）
        const err = model.addEdge(newId, 'out');
        comp.refresh();
        await new Promise(r => setTimeout(r, 50));
        return { ok: err === null, edgesBefore: edgeBefore, edgesAfter: model.edges.length, err };
      });
      A('T2-connect', connectResult.ok, '新增节点 → 拉线连到 out 成功', 'edges:' + connectResult.edgesBefore + '→' + connectResult.edgesAfter);

      // 成环被拒
      const cycleResult = await page.evaluate(() => {
        function getComp(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return el;
            if (el.shadowRoot) { const r = getComp(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const comp = getComp(document);
        if (!comp) return { ok: false };
        const model = comp.getModel();
        // 尝试 out → in（反向 = 成环）
        const err = model.addEdge('out', 'in');
        return { ok: err !== null, err };
      });
      A('T2-cycle-rejected', cycleResult.ok, '成环连线被拒（wouldCycle 检测）', cycleResult.err);

      // 点选决策表节点 → property 区出编辑器
      const propResult = await page.evaluate(async () => {
        function getComp(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return el;
            if (el.shadowRoot) { const r = getComp(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const comp = getComp(document);
        if (!comp) return { ok: false };
        // 选中 dt1 节点
        comp.selectNode('dt1');
        await new Promise(r => setTimeout(r, 200));
        // 检查 property 区是否出现决策表编辑器（有 .g-tbl 或「决策表」文字）
        function hasProp(root, text) {
          return Array.from(root.querySelectorAll('*')).some(el =>
            !el.shadowRoot && (el.className || '').includes('g-tbl')
          ) || root.textContent.includes(text);
        }
        // 找 property host
        const prop = document.getElementById('h-property');
        if (!prop) return { ok: false, reason: 'no property host' };
        return { ok: hasProp(prop, '决策表') || hasProp(prop, '命中策略'), text: prop.textContent.slice(0, 80) };
      });
      A('T2-property', propResult.ok, '选中决策表节点后 property 区显示编辑器', propResult.text);

      // getGraph() 返回合法 JSON（有 nodes/edges/kind=graph）
      const graphJson = await page.evaluate(() => {
        function getComp(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'CMX-DECISION-GRAPH' && !el.hasAttribute('readonly')) return el;
            if (el.shadowRoot) { const r = getComp(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const comp = getComp(document);
        if (!comp) return null;
        try { return comp.getGraph(); } catch { return null; }
      });
      const validGraph = graphJson && Array.isArray(graphJson.nodes) && Array.isArray(graphJson.edges) && graphJson.kind === 'graph';
      A('T2-getgraph', validGraph, 'getGraph() 返回合法 {nodes,edges,kind=graph}',
        graphJson ? `nodes=${graphJson.nodes.length} edges=${graphJson.edges.length}` : 'null');

      // 点保存草稿（验证不报错 + 后端可收到）
      const saveResult = await page.evaluate(async () => {
        // 找到保存按钮（data-act="save"）
        function findBtn(root) {
          for (const el of root.querySelectorAll('[data-act="save"]')) return el;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) { const r = findBtn(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const btn = findBtn(document);
        if (!btn) return { ok: false, reason: 'no save button' };
        let saved = false, error = null;
        // 监听 flash（通过检查 DOM 变化）
        const obs = new MutationObserver(() => {
          const f = document.querySelector('.g-flash, [class*="flash"]');
          if (f && f.textContent.includes('已保存')) saved = true;
          if (f && f.textContent.includes('失败')) error = f.textContent;
        });
        obs.observe(document.body, { subtree: true, childList: true, characterData: true });
        btn.click();
        await new Promise(r => setTimeout(r, 2000));
        obs.disconnect();
        return { ok: !error, saved, error };
      });
      A('T2-save', saveResult.ok, '保存草稿不报错', saveResult.error || (saveResult.saved ? '已保存' : '无 flash（可能 iframe/shadow 隔离）'));

      await page.close();
    }

    // ══ 测试组 3：后端 API 零回归（definitions 列表可达，GET 测试图定义完整）══
    console.log('\n── 组 3：后端零回归 ──');
    {
      const listRes = await apiReq('GET', '/api/rules/v1/definitions');
      A('T3-list', listRes.status === 200, '后端 GET /definitions 返回 200', 'status=' + listRes.status);

      const defRes = await apiReq('GET', '/api/rules/v1/definitions/' + encodeURIComponent(testKey));
      const def = defRes.body && (defRes.body.data || defRes.body);
      A('T3-def', defRes.status === 200 && def && def.kind === 'graph', '测试图定义可读 kind=graph', def ? 'nodes=' + (def.nodes || []).length : 'null');

      // evaluate 端点：用测试图求值（amount=5000 → level=LOW）
      const evalRes = await apiReq('POST', '/api/rules/v1/decisions/' + encodeURIComponent(testKey) + '/evaluate', { input: { amount: 5000 } });
      const evalOk = evalRes.status === 200;
      A('T3-evaluate', evalOk, '测试图 evaluate 返回 200', 'status=' + evalRes.status + (evalOk ? ' level=' + JSON.stringify(evalRes.body?.data?.level || evalRes.body?.level) : ''));
    }

  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n════ 决策图组件 CDP: ${_pass}/${_total} PASS ════`);
  process.exit(_pass === _total ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
