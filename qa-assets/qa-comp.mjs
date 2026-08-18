import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API = 'http://127.0.0.1:8094';
const results = [];
const rec = (n, ok, d='') => { results.push({n, ok}); console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`); };
const benign = e => /favicon/.test(e) || /Failed to load resource.*404/.test(e);
const browser = await chromium.launch({ channel: 'chrome' });

async function mountPage(page, modUrl, props) {
  await page.evaluate(async ({modUrl, api, props}) => {
    window.openTab = (wn)=>{ window.__opened=window.__opened||[]; window.__opened.push(wn?.workspace?.model?.native_page||wn?.id||wn); return true; };
    document.body.innerHTML='<div id="explorer"></div><div id="content"></div><div id="property"></div>';
    const m = await import(modUrl); window.__m=m;
    if (m.configure) m.configure({ apiBase: api });
    for (const [id,view] of [['explorer','explorer'],['content','content'],['property','property']]) {
      const h=document.getElementById(id); h.renderRoot=h;
      if (m.default?.views?.[view]) await m.default.views[view]({ host:h, props });
    }
  }, {modUrl, api:API, props});
  await page.waitForTimeout(2200); // 组件 fetch+blob import 需时间
}

// 先建一个测试图
const gkey = 'qa_comp_' + Math.floor(Date.now()/1000)%100000;

// ═══ A. design-workbench 图态预览用组件 ═══
console.log('\n【A. design-workbench 预览用 <cmx-decision-graph readonly>】');
{
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e=>errs.push('A:'+e)); page.on('console', m=>{ if(m.type()==='error'&&!benign(m.text())) errs.push('A:'+m.text()); });
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mountPage(page, '/rule/design-workbench.js', {});
  await page.waitForFunction(()=>document.querySelectorAll('#explorer .np-item').length>=1, {timeout:8000}).catch(()=>{});
  // 点 loan_decision（seed 图）
  await page.evaluate(()=>{ const el=[...document.querySelectorAll('#explorer [data-key]')].find(e=>e.getAttribute('data-key')==='loan_decision'); el&&el.click(); });
  await page.waitForTimeout(2200);
  const prev = await page.evaluate(()=>{
    const el = document.querySelector('#content cmx-decision-graph');
    const sr = el && el.shadowRoot;
    return { hasEl: !!el, readonly: el?.hasAttribute('readonly'), nodes: sr?sr.querySelectorAll('.dg-node').length:0, edges: sr?sr.querySelectorAll('.dg-edge').length:0, ports: sr?sr.querySelectorAll('.dg-port').length:0 };
  });
  rec('图态预览挂载 <cmx-decision-graph readonly>', prev.hasEl && prev.readonly, JSON.stringify(prev));
  rec('预览渲染 5 节点 4 边、只读无连接点', prev.nodes===5 && prev.edges===4 && prev.ports===0, `nodes=${prev.nodes} edges=${prev.edges} ports=${prev.ports}`);
  rec('design-workbench 无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
  await page.screenshot({path:'/tmp/qa-comp-preview.png'});
  await page.close();
}

// ═══ B. 新建决策图 → graph-designer 壳驱动组件 ═══
console.log('\n【B. graph-designer 壳 + 组件编辑】');
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  const errs = []; page.on('pageerror', e=>errs.push('B:'+e)); page.on('console', m=>{ if(m.type()==='error'&&!benign(m.text())) errs.push('B:'+m.text()); });
  // 直接建图（走 API）再打开设计器
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await page.evaluate(async ({api,k})=>{
    await fetch(api+'/api/rules/v1/definitions/draft', {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({key:k,name:'QA组件图',version:1,kind:'graph',
        nodes:[{id:'in',name:'输入',type:'input'},{id:'dt1',name:'决策表',type:'decisionTable',table:{hitPolicy:'U',inputs:[{id:'i1',label:'输入1',expression:'input1'}],outputs:[{id:'o1',name:'result',label:'结果'}],rules:[{id:'r1',inputEntries:['-'],outputEntries:['""']}]}},{id:'out',name:'输出',type:'output'}],
        edges:[{source:'in',target:'dt1'},{source:'dt1',target:'out'}]})});
  }, {api:API,k:gkey});
  await mountPage(page, '/rule/graph-designer.js', {key:gkey, name:'QA组件图', version:1});
  const init = await page.evaluate(()=>{
    const el = document.querySelector('#content cmx-decision-graph');
    const sr = el && el.shadowRoot;
    return { hasEl:!!el, nodes: sr?sr.querySelectorAll('.dg-node').length:0, edges: sr?sr.querySelectorAll('.dg-edge').length:0, ports: sr?sr.querySelectorAll('.dg-port').length:0, toolbar: !!document.querySelector('#content [data-act="save"]'), nlist: document.querySelectorAll('#explorer .g-nrow').length };
  });
  rec('设计器挂载可编辑组件（3节点2边+连接点）', init.hasEl && init.nodes===3 && init.ports>0, `nodes=${init.nodes} edges=${init.edges} ports=${init.ports}`);
  rec('壳工具栏 + explorer 节点列表', init.toolbar && init.nlist===3, `nlist=${init.nlist}`);

  // 组件内拖拽节点（pointer 到 dt1 节点）
  const dragged = await page.evaluate(async ()=>{
    const el = document.querySelector('#content cmx-decision-graph'); const sr = el.shadowRoot;
    const node = [...sr.querySelectorAll('.dg-node')].find(n=>n.getAttribute('data-node')==='dt1');
    const r = node.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const o=(x,y)=>({pointerId:1,bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse',isPrimary:true,button:0});
    node.dispatchEvent(new PointerEvent('pointerdown',o(cx,cy)));
    sr.querySelector('svg').dispatchEvent(new PointerEvent('pointermove',o(cx+120,cy+70)));
    sr.querySelector('svg').dispatchEvent(new PointerEvent('pointerup',o(cx+120,cy+70)));
    await new Promise(r=>setTimeout(r,200));
    return !!(el.getGraph()._layout && el.getGraph()._layout.dt1);
  });
  rec('组件内拖拽节点 → _layout 写入', dragged);

  // 加节点（经壳按钮 → 组件 addNode）
  await page.evaluate(()=>{ const b=[...document.querySelectorAll('#content [data-act="add-node"]')].find(x=>x.getAttribute('data-nodetype')==='expression'); b.click(); });
  await page.waitForTimeout(500);
  const afterAdd = await page.evaluate(()=>document.querySelector('#content cmx-decision-graph').shadowRoot.querySelectorAll('.dg-node').length);
  rec('壳加节点 → 组件节点+1', afterAdd===4, `3→${afterAdd}`);

  // 点决策表节点 → property 出注入的网格
  await page.evaluate(()=>{ const el=[...document.querySelectorAll('#explorer .g-nrow')].find(e=>e.getAttribute('data-node')==='dt1'); el&&el.click(); });
  await page.waitForTimeout(500);
  const hasGrid = await page.evaluate(()=>!!document.querySelector('#property .g-tbl, #property [data-act="tbl-add-rule"]'));
  rec('点决策表节点 → property 注入网格', hasGrid);
  // 加规则行
  await page.evaluate(()=>{ const b=document.querySelector('#property [data-act="tbl-add-rule"]'); b&&b.click(); });
  await page.waitForTimeout(400);
  const rows = await page.evaluate(()=>document.querySelectorAll('#property .g-tbl tbody tr').length);
  rec('决策表节点加规则行', rows>=2, 'rows='+rows);

  // 保存草稿（壳 getGraph 取模型 POST）
  await page.evaluate(()=>{ document.querySelector('#content [data-act="save"]').click(); });
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(async ({api,k})=>{ const r=await fetch(api+'/api/rules/v1/definitions/'+k); const j=await r.json(); return {nodes:j.data.nodes.length, kind:j.data.kind, hasLayout: !!j.data._layout}; }, {api:API,k:gkey});
  rec('保存 → 后端 nodes+1、kind=graph、_layout 已剥离', saved.nodes===4 && saved.kind==='graph' && !saved.hasLayout, JSON.stringify(saved));

  rec('graph-designer 无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
  await page.screenshot({path:'/tmp/qa-comp-designer.png'});
  await page.close();
}

console.log('\n结果: '+results.filter(r=>r.ok).length+'/'+results.length);
console.log('__GKEY__'+gkey);
await browser.close();
