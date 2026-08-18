import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API='http://127.0.0.1:8094';
const results=[]; const rec=(n,ok,d='')=>{results.push(ok);console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);};
const browser = await chromium.launch({ channel:'chrome' });
const page = await browser.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e))); page.on('console',m=>{if(m.type()==='error'&&!/favicon|404/.test(m.text()))errs.push(m.text());});
await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
await page.evaluate(async ({api})=>{
  document.body.innerHTML='<div id="content"></div><div id="property"></div>';
  const m=await import('/rule/graph-designer.js'); m.configure({apiBase:api});
  for(const [id,v] of [['content','content'],['property','property']]){const h=document.getElementById(id);h.renderRoot=h;await m.default.views[v]({host:h,props:{key:'loan_decision',name:'贷款',version:1}});}
}, {api:API});
await page.waitForTimeout(2600);

// 1) 精确点击节点 → 选中
const nb = await page.evaluate(()=>{const sr=document.querySelector('#content cmx-decision-graph').shadowRoot;const n=[...sr.querySelectorAll('.dg-node')].find(x=>x.getAttribute('data-node')==='base');const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
await page.mouse.click(nb.x, nb.y);
await page.waitForTimeout(400);
let p = await page.evaluate(()=>({hd:document.querySelector('#property .g-hd')?.textContent.trim().slice(0,18),name:document.querySelector('#property [data-kind="node-name"]')?.value}));
rec('精确点节点 → property 显节点编辑器', /节点/.test(p.hd||'')&&!!p.name, `${p.hd} name=${p.name}`);

// 2) 微移点击(2px 手抖) → 仍选中
await page.mouse.move(nb.x, nb.y); await page.mouse.down(); await page.mouse.move(nb.x+2, nb.y+1); await page.mouse.up();
await page.waitForTimeout(400);
const micro = await page.evaluate(()=>!!document.querySelector('#property [data-kind="node-name"]'));
rec('微移(2px)点击 → 仍选中(容忍手抖)', micro);

// 3) 点边 → property 显边属性 + 删除按钮
const eb = await page.evaluate(()=>{const sr=document.querySelector('#content cmx-decision-graph').shadowRoot;const e=sr.querySelector('.dg-edge');const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
await page.mouse.click(eb.x, eb.y);
await page.waitForTimeout(400);
const edge = await page.evaluate(()=>({hd:document.querySelector('#property .g-hd')?.textContent.trim().slice(0,10),hasDel:!!document.querySelector('#property [data-act="del-edge"]'),body:(document.querySelector('#property').textContent.match(/从.*?到/)||[''])[0]}));
rec('点边 → property 显边属性(从/到+删除)', /边属性/.test(edge.hd||'')&&edge.hasDel, `${edge.hd} del=${edge.hasDel}`);

// 4) 删除边生效
const beforeEdges = await page.evaluate(()=>document.querySelector('#content cmx-decision-graph').getGraph().edges.length);
await page.evaluate(()=>document.querySelector('#property [data-act="del-edge"]').click());
await page.waitForTimeout(500);
const afterEdges = await page.evaluate(()=>document.querySelector('#content cmx-decision-graph').getGraph().edges.length);
rec('删除边生效(边数-1)', afterEdges===beforeEdges-1, `${beforeEdges}→${afterEdges}`);

rec('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await page.screenshot({path:'/tmp/verify-select.png'});
console.log('\n结果: '+results.filter(Boolean).length+'/'+results.length);
await browser.close();
