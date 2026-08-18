import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const results = [];
const rec = (n, ok, d='') => { results.push({n, ok}); console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`); };
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type()==='error') errs.push('cerr:'+m.text()); });
await page.goto('http://127.0.0.1:8097/demo/index.html', { waitUntil:'networkidle' });
await page.waitForTimeout(600);

// 1) 组件注册 + 渲染
const reg = await page.evaluate(() => !!customElements.get('cmx-decision-graph'));
rec('自定义元素已注册', reg);
const svg0 = await page.evaluate(() => {
  const g = document.getElementById('g');
  const sr = g.shadowRoot;
  return { nodes: sr.querySelectorAll('.dg-node').length, edges: sr.querySelectorAll('.dg-edge').length, ver: document.getElementById('ver').textContent };
});
rec('初始渲染 SVG（5 节点 4 边）', svg0.nodes===5 && svg0.edges===4, `nodes=${svg0.nodes} edges=${svg0.edges} ${svg0.ver}`);

// 2) getGraph 往返
const g0 = await page.evaluate(() => document.getElementById('g').getGraph());
rec('getGraph 返回图 def', g0.kind==='graph' && g0.nodes.length===5, 'nodes='+g0.nodes.length);

// 3) 拖拽节点：pointer down/move/up 在 base 节点上
const dragged = await page.evaluate(async () => {
  const g = document.getElementById('g');
  const sr = g.shadowRoot;
  const svg = sr.querySelector('svg');
  const node = [...sr.querySelectorAll('.dg-node')].find(n => n.getAttribute('data-node')==='base');
  const rect = node.getBoundingClientRect();
  const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
  const opts = (x,y,id=1) => ({ pointerId:id, bubbles:true, cancelable:true, clientX:x, clientY:y, pointerType:'mouse', isPrimary:true });
  node.dispatchEvent(new PointerEvent('pointerdown', opts(cx, cy)));
  svg.dispatchEvent(new PointerEvent('pointermove', opts(cx+120, cy+80)));
  svg.dispatchEvent(new PointerEvent('pointermove', opts(cx+160, cy+100)));
  svg.dispatchEvent(new PointerEvent('pointerup', opts(cx+160, cy+100)));
  await new Promise(r=>setTimeout(r,200));
  const def = g.getGraph();
  return { hasLayout: !!(def._layout && def._layout.base), pos: def._layout && def._layout.base };
});
rec('拖拽节点 → 坐标提示写入 _layout', dragged.hasLayout, JSON.stringify(dragged.pos));

await page.evaluate(() => document.getElementById('g').autoLayout()); // 重排回自动布局，隔离前面拖拽的位移
await page.waitForTimeout(200);
// 4) 拉线连边：从 base 的连接点拖到 out（当前无 base→out 边? 实际 base→risk 已有；连 in→calc 测新边）
const connected = await page.evaluate(async () => {
  const g = document.getElementById('g');
  const sr = g.shadowRoot;
  const svg = sr.querySelector('svg');
  const before = g.getGraph().edges.length;
  // 从 'in' 节点的连接点(port) 拉到 'calc' 节点
  const inNode = [...sr.querySelectorAll('.dg-node')].find(n => n.getAttribute('data-node')==='in');
  const calcNode = [...sr.querySelectorAll('.dg-node')].find(n => n.getAttribute('data-node')==='calc');
  const port = inNode.querySelector('.dg-port');
  const pr = port.getBoundingClientRect();
  const cr = calcNode.getBoundingClientRect();
  const opts = (x,y) => ({ pointerId:2, bubbles:true, cancelable:true, clientX:x, clientY:y, pointerType:'mouse', isPrimary:true });
  port.dispatchEvent(new PointerEvent('pointerdown', opts(pr.left+pr.width/2, pr.top+pr.height/2)));
  svg.dispatchEvent(new PointerEvent('pointermove', opts(cr.left+10, cr.top+cr.height/2)));
  svg.dispatchEvent(new PointerEvent('pointermove', opts(cr.left+cr.width/2, cr.top+cr.height/2)));
  svg.dispatchEvent(new PointerEvent('pointerup', opts(cr.left+cr.width/2, cr.top+cr.height/2)));
  await new Promise(r=>setTimeout(r,200));
  const after = g.getGraph().edges;
  return { before, after: after.length, hasNew: after.some(e=>e.source==='in'&&e.target==='calc') };
});
rec('拉线连边 in→calc（边数+1）', connected.after===connected.before+1 && connected.hasNew, `${connected.before}→${connected.after}`);

// 5) 成环被拒：拉 out→in（会成环）
const cycleRejected = await page.evaluate(async () => {
  const g = document.getElementById('g');
  const sr = g.shadowRoot;
  const svg = sr.querySelector('svg');
  const before = g.getGraph().edges.length;
  let rejected = false;
  g.addEventListener('connect-rejected', () => { rejected = true; }, { once:true });
  const outNode = [...sr.querySelectorAll('.dg-node')].find(n => n.getAttribute('data-node')==='out');
  const inNode = [...sr.querySelectorAll('.dg-node')].find(n => n.getAttribute('data-node')==='in');
  const port = outNode.querySelector('.dg-port');
  const pr = port.getBoundingClientRect();
  const ir = inNode.getBoundingClientRect();
  const opts = (x,y) => ({ pointerId:3, bubbles:true, cancelable:true, clientX:x, clientY:y, pointerType:'mouse', isPrimary:true });
  port.dispatchEvent(new PointerEvent('pointerdown', opts(pr.left+pr.width/2, pr.top+pr.height/2)));
  svg.dispatchEvent(new PointerEvent('pointermove', opts(ir.left+ir.width/2, ir.top+ir.height/2)));
  svg.dispatchEvent(new PointerEvent('pointerup', opts(ir.left+ir.width/2, ir.top+ir.height/2)));
  await new Promise(r=>setTimeout(r,200));
  return { before, after: g.getGraph().edges.length, rejected };
});
rec('成环连线被拒（边数不变+connect-rejected）', cycleRejected.after===cycleRejected.before && cycleRejected.rejected, `${cycleRejected.before}→${cycleRejected.after} rejected=${cycleRejected.rejected}`);

// 6) 只读模式无交互装饰
const roCheck = await page.evaluate(async () => {
  const g = document.getElementById('g');
  g.setAttribute('readonly','');
  await new Promise(r=>setTimeout(r,150));
  const sr = g.shadowRoot;
  return { ports: sr.querySelectorAll('.dg-port').length, nodes: sr.querySelectorAll('.dg-node').length };
});
rec('只读模式：无连接点、仍渲染节点', roCheck.ports===0 && roCheck.nodes>=5, `ports=${roCheck.ports} nodes=${roCheck.nodes}`);

rec('无 JS 错误(除favicon)', errs.filter(e=>!/favicon|404/.test(e)).length===0, errs.slice(0,2).join(' | '));
await page.evaluate(() => document.getElementById('g').removeAttribute('readonly'));
await page.waitForTimeout(200);
await page.screenshot({ path:'/tmp/dg-demo.png' });
console.log('\n结果: '+results.filter(r=>r.ok).length+'/'+results.length);
await browser.close();
