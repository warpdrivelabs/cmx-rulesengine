// 规则集「按分类分组」CDP e2e：三页（设计/仿真/日志）决策集列表按分类分组折叠 + 设计台分类管理/新建选类/改类。
// 前置：cargo run -p cmx-rule-server（:8094）。运行：node docs/full-test/fe/category_grouping.cjs
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.resolve(__dirname, '../../../web');
const KEY = 'cmx_sk_dev_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const PORT = 9096;
const results = [];
const A = (id, ok, desc, detail) => { results.push({ id, ok: !!ok }); console.log(`[${id}] ${ok ? 'PASS' : 'FAIL'}  ${desc}${detail ? '  :: ' + detail : ''}`); };

// 内嵌服务：静态 web/ + /api/* 反代 :8094（注入 X-API-Key，auth 开关无关）。
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      const pageOf = { '/dw': 'design-workbench', '/sw': 'sim-workbench', '/logs': 'logs' }[url];
      if (pageOf) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(harness(pageOf)); return; }
      if (url.startsWith('/api/')) {
        const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
          const body = chunks.length ? Buffer.concat(chunks) : null;
          const p = http.request({ hostname: '127.0.0.1', port: 8094, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:8094', 'X-API-Key': KEY } }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
          p.on('error', () => { res.writeHead(502); res.end('proxy error'); }); if (body) p.write(body); p.end();
        }); return;
      }
      const fp = path.join(WEB_DIR, url);
      fs.readFile(fp, (err, buf) => { if (err) { res.statusCode = 404; return res.end('nf'); } if (url.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(buf); });
    });
    srv.listen(PORT, () => resolve(srv));
  });
}
const harness = (mod) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#stage{display:flex;height:100vh}.region{overflow:hidden;height:100%}#r-explorer{flex:0 0 280px;border-right:1px solid #ccc}#r-content{flex:1}#r-property{flex:0 0 320px;border-left:1px solid #ccc}.host{height:100%;display:block}</style></head>
<body><div id="stage"><div class="region" id="r-explorer"><div class="host" id="h-explorer"></div></div><div class="region" id="r-content"><div class="host" id="h-content"></div></div><div class="region" id="r-property"><div class="host" id="h-property"></div></div></div>
<script type="module">
  import * as mod from '/ui-native/rule/${mod}.js'
  window.__mod = mod; mod.configure({ apiBase: '' })
  const d = mod.default
  await d.views.explorer({ host: document.getElementById('h-explorer') })
  await d.views.content({ host: document.getElementById('h-content') })
  await d.views.property({ host: document.getElementById('h-property') })
  window.__ready = true
</script></body></html>`;

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: 8094, path: p, method, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch { resolve(null); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const dtSkeleton = (key, name, cat) => ({ key, name, version: 1, categoryCode: cat, kind: 'decisionTable', hitPolicy: 'U', inputs: [{ id: 'i1', label: '输入1', expression: 'input1' }], outputs: [{ id: 'o1', name: 'result', label: '结果' }], rules: [{ id: 'r1', inputEntries: ['-'], outputEntries: ['"ok"'] }] });

(async () => {
  // ── 种子：3 分类 + 3 带分类决策集（幂等 upsert）──
  await api('POST', '/api/rules/v1/categories', { code: 'credit', name: '授信', ord: 1 });
  await api('POST', '/api/rules/v1/categories', { code: 'risk', name: '风控', ord: 2 });
  await api('POST', '/api/rules/v1/categories', { code: 'pricing', name: '定价', ord: 3 });
  await api('POST', '/api/rules/v1/definitions/draft', dtSkeleton('cat_demo_credit', '授信审批(分类demo)', 'credit'));
  await api('POST', '/api/rules/v1/definitions/draft', dtSkeleton('cat_demo_risk', '反欺诈(分类demo)', 'risk'));
  await api('POST', '/api/rules/v1/definitions/draft', dtSkeleton('cat_demo_price', '定价规则(分类demo)', 'pricing'));

  const srv = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const q = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const txt = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map(e => (e.textContent || '').trim()), sel);

  // ═══ 设计工作台 ═══
  await page.goto(`http://127.0.0.1:${PORT}/dw`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__ready===true', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction('document.querySelectorAll(".np-grp").length>0', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);

  const grpNames = await txt('.np-grp .np-grp-nm');
  A('DW-groups', (await q('.np-grp')) >= 4, '设计台按分类分组（≥4 组：授信/风控/定价/未分类）', `groups=${JSON.stringify(grpNames)}`);
  A('DW-uncat-last', grpNames[grpNames.length - 1] === '未分类', '未分类置底', `last=${grpNames[grpNames.length - 1]}`);
  A('DW-counts', (await q('.np-grp .np-grp-hd .np-sub')) >= 4, '每组标题带数量芯片', `chips=${await q('.np-grp .np-grp-hd .np-sub')}`);
  // 授信组内含 cat_demo_credit
  const creditItems = await page.evaluate(() => { const g = [...document.querySelectorAll('.np-grp')].find(d => d.querySelector('.np-grp-nm')?.textContent.trim() === '授信'); return g ? [...g.querySelectorAll('.np-item .np-nm')].map(e => e.textContent.trim()) : []; });
  A('DW-group-content', creditItems.some(t => t.includes('授信审批')), '授信组内含「授信审批(分类demo)」', creditItems.join(','));

  // 搜索命中自动展开
  await page.evaluate(() => { const i = document.querySelector('#np-search'); i.value = '反欺诈'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(400);
  const openAfterSearch = await page.evaluate(() => { const g = [...document.querySelectorAll('.np-grp')].find(d => d.querySelector('.np-grp-nm')?.textContent.trim() === '风控'); return g ? g.open : false; });
  A('DW-search-expand', openAfterSearch && (await q('.np-item')) >= 1, '搜索命中→风控组自动展开且只剩命中项', `open=${openAfterSearch} items=${await q('.np-item')}`);
  await page.evaluate(() => { const b = document.querySelector('[data-act="search-clear"]'); if (b) b.click(); });
  await page.waitForTimeout(300);

  // 分类管理面板
  await page.evaluate(() => document.querySelector('[data-act="cat-manage"]').click());
  await page.waitForTimeout(300);
  A('DW-catmgr-open', (await q('.np-catmgr')) === 1 && (await q('.np-catrow')) >= 3, '⚙ 打开分类管理面板（列出≥3分类）', `rows=${await q('.np-catrow')}`);
  // 新增分类
  await page.evaluate(() => { document.querySelector('#cat-new-code').value = 'compliance'; document.querySelector('#cat-new-name').value = '合规'; document.querySelector('[data-act="cat-add"]').click(); });
  await page.waitForTimeout(800);
  const catsNow = await txt('.np-catrow .np-cat-code');
  A('DW-cat-add', catsNow.includes('compliance'), '新增分类「合规」入库并显示', catsNow.join(','));
  await page.evaluate(() => document.querySelector('[data-act="cat-manage"]').click()); // 收起
  await page.waitForTimeout(200);

  // 新建表单含分类下拉
  await page.evaluate(() => document.querySelector('[data-act="new"]').click());
  await page.waitForTimeout(300);
  const ncCatOpts = await page.evaluate(() => { const s = document.querySelector('#nc-cat'); return s ? [...s.options].map(o => o.textContent.trim()) : []; });
  A('DW-create-select', ncCatOpts.includes('未分类') && ncCatOpts.includes('授信'), '新建表单有分类下拉（未分类+已有分类）', ncCatOpts.join(','));
  await page.evaluate(() => document.querySelector('[data-act="create-cancel"]').click());
  await page.waitForTimeout(200);

  // property 改分类：选中 cat_demo_price（定价）→ 改成 风控 → 跨组
  await page.evaluate(() => { const it = [...document.querySelectorAll('.np-item[data-key]')].find(e => e.getAttribute('data-key') === 'cat_demo_price'); if (it) it.click(); });
  await page.waitForTimeout(1200);
  const hasCatSel = await page.evaluate(() => { const s = document.querySelector('#np-cat-sel'); return s ? s.value : null; });
  A('DW-prop-select', hasCatSel === 'pricing', 'property 分类下拉回显当前分类=pricing', `val=${hasCatSel}`);
  await page.evaluate(() => { const s = document.querySelector('#np-cat-sel'); s.value = 'risk'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(1200);
  const priceInRisk = await page.evaluate(() => { const g = [...document.querySelectorAll('.np-grp')].find(d => d.querySelector('.np-grp-nm')?.textContent.trim() === '风控'); return g ? [...g.querySelectorAll('.np-item')].map(e => e.getAttribute('data-key')).includes('cat_demo_price') : false; });
  A('DW-recategorize', priceInRisk, 'property 改分类→cat_demo_price 移入风控组', `inRisk=${priceInRisk}`);
  // 复原（回定价，保持数据整洁）
  await page.evaluate(() => { const it = [...document.querySelectorAll('.np-item[data-key]')].find(e => e.getAttribute('data-key') === 'cat_demo_price'); if (it) it.click(); });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const s = document.querySelector('#np-cat-sel'); if (s) { s.value = 'pricing'; s.dispatchEvent(new Event('change', { bubbles: true })); } });
  await page.waitForTimeout(800);

  // ═══ 仿真台 ═══
  await page.goto(`http://127.0.0.1:${PORT}/sw`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('document.querySelectorAll(".np-grp").length>0', { timeout: 8000 }).catch(() => {});
  const swNames = await txt('.np-grp .np-grp-nm');
  A('SW-groups', (await q('.np-grp')) >= 4 && swNames[swNames.length - 1] === '未分类', '仿真台按分类分组折叠（未分类置底）', JSON.stringify(swNames));

  // ═══ 日志 ═══
  await page.goto(`http://127.0.0.1:${PORT}/logs`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('document.querySelectorAll(".rl-grp").length>0', { timeout: 8000 }).catch(() => {});
  const lgNames = await txt('.rl-grp .rl-grp-nm');
  A('LOGS-groups', (await q('.rl-grp')) >= 4 && lgNames[lgNames.length - 1] === '未分类', '日志页按分类分组折叠（未分类置底）', JSON.stringify(lgNames));

  A('T-noerr', errors.length === 0, '全程无 pageerror', errors.slice(0, 3).join(' | ').slice(0, 200));

  await browser.close(); srv.close();
  const pass = results.filter(r => r.ok).length;
  console.log(`\n==== 规则集分类分组: ${pass}/${results.length} ====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
