import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API='http://127.0.0.1:8094';
const results=[]; const rec=(n,ok,d='')=>{results.push(ok);console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);};
const benign=e=>/favicon|404/.test(e);
const browser = await chromium.launch({ channel:'chrome' });
const page = await browser.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e))); page.on('console',m=>{if(m.type()==='error'&&!benign(m.text()))errs.push(m.text());});
await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
await page.evaluate(async ({api})=>{
  document.body.innerHTML='<div id="explorer" style="display:none"></div><div id="content"></div><div id="property"></div>';
  const m=await import('/rule/design-workbench.js'); m.configure({apiBase:api});
  for(const [id,v] of [['explorer','explorer'],['content','content'],['property','property']]){const h=document.getElementById(id);h.renderRoot=h;await m.default.views[v]({host:h,props:{}});}
}, {api:API});
await page.waitForTimeout(2000);
await page.waitForFunction(()=>document.querySelectorAll('#explorer .np-item').length>=1,{timeout:8000}).catch(()=>{});
// 选 loan_decision 图
await page.evaluate(()=>{const el=[...document.querySelectorAll('#explorer [data-key]')].find(e=>e.getAttribute('data-key')==='loan_decision');el&&el.click();});
await page.waitForTimeout(2400);
// 确认预览组件渲染
const prev = await page.evaluate(()=>{const el=document.querySelector('#content cmx-decision-graph');const sr=el&&el.shadowRoot;return {hasEl:!!el, nodes:sr?sr.querySelectorAll('.dg-node').length:0, hasDataNode: sr?!!sr.querySelector('[data-node]'):false};});
rec('图态预览组件渲染(含 data-node 可点选)', prev.hasEl && prev.nodes===5 && prev.hasDataNode, JSON.stringify(prev));

// 点节点 base
const nb = await page.evaluate(()=>{const sr=document.querySelector('#content cmx-decision-graph').shadowRoot;const n=[...sr.querySelectorAll('.dg-node')].find(x=>x.getAttribute('data-node')==='base');const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
await page.mouse.click(nb.x, nb.y);
await page.waitForTimeout(500);
const afterNode = await page.evaluate(()=>{const p=document.querySelector('#property');const t=(p.textContent||'').replace(/\s+/g,' ');return {hasSel:/选中节点/.test(t), hasType:/命中策略|决策表/.test(t), snippet:(t.match(/选中节点.{0,40}/)||[''])[0]};});
rec('点节点 → property 显「选中节点」只读属性', afterNode.hasSel, afterNode.snippet);

// 点边
const eb = await page.evaluate(()=>{const sr=document.querySelector('#content cmx-decision-graph').shadowRoot;const e=sr.querySelector('.dg-edge-hit')||sr.querySelector('.dg-edge');const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
await page.mouse.click(eb.x, eb.y);
await page.waitForTimeout(500);
const afterEdge = await page.evaluate(()=>{const p=document.querySelector('#property');const t=(p.textContent||'').replace(/\s+/g,' ');return {hasSel:/选中边/.test(t), snippet:(t.match(/选中边.{0,40}/)||[''])[0]};});
rec('点边 → property 显「选中边」只读属性', afterEdge.hasSel, afterEdge.snippet);

// 只读态不可拖拽/无连接点
const ro = await page.evaluate(()=>{const sr=document.querySelector('#content cmx-decision-graph').shadowRoot;return {ports:sr.querySelectorAll('.dg-port').length};});
rec('只读态无连接点(不可连线)', ro.ports===0, 'ports='+ro.ports);

rec('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await page.screenshot({path:'/tmp/verify-preview-select.png'});
console.log('\n结果: '+results.filter(Boolean).length+'/'+results.length);
await browser.close();
