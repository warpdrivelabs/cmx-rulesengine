import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API = 'http://127.0.0.1:8094';
const results = [];
const rec = (name, ok, detail='') => { results.push({name, ok}); console.log(`  ${ok?'✅':'❌'} ${name}${detail?' — '+detail:''}`); };
const browser = await chromium.launch({ channel: 'chrome' });
const errs = [];

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
  await page.waitForTimeout(1500);
}

// ═══════════ A. design-workbench: 新建选类型 → 决策图 ═══════════
console.log('\n【A. 新建决策图流程 · design-workbench】');
const gkey = 'qa_graph_' + Math.floor(Date.now()/1000)%100000;
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  page.on('pageerror', e=>errs.push('A:'+e));
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mountPage(page, '/rule/design-workbench.js', {});
  await page.waitForFunction(()=>document.querySelectorAll('#explorer .np-item').length>=1, {timeout:8000}).catch(()=>{});
  // 点新建
  await page.evaluate(()=>document.querySelector('#explorer [data-act="new"]').click());
  await page.waitForTimeout(300);
  const hasSeg = await page.evaluate(()=>document.querySelectorAll('#explorer input[name="nc-kind"]').length===2);
  rec('新建表单含类型选择（决策表/决策图）', hasSeg);
  // 选决策图 + 填名
  await page.evaluate((k)=>{
    document.querySelector('#explorer input[name="nc-kind"][value="graph"]').click();
    document.querySelector('#explorer #nc-name').value='QA图测试';
    document.querySelector('#explorer #nc-key').value=k;
  }, gkey);
  await page.evaluate(()=>document.querySelector('#explorer [data-act="create-ok"]').click());
  await page.waitForTimeout(1600);
  // 落库 kind=graph
  const kind = await page.evaluate(async ({api,k})=>{ const r=await fetch(api+'/api/rules/v1/definitions/'+k); if(!r.ok)return 'HTTP'+r.status; const j=await r.json(); return j.data.kind; }, {api:API,k:gkey});
  rec('新建决策图落库 kind=graph', kind==='graph', 'kind='+kind);
  const opened = await page.evaluate(()=>window.__opened||[]);
  rec('新建后自动打开 graph-designer', opened.some(x=>String(x).includes('graph-designer')), 'opened='+JSON.stringify(opened));
  await page.close();
}

// ═══════════ B. 图态 SVG 预览（design-workbench content）═══════════
console.log('\n【B. 图态 SVG 可视化预览】');
{
  const page = await browser.newPage();
  page.on('pageerror', e=>errs.push('B:'+e));
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mountPage(page, '/rule/design-workbench.js', {});
  await page.waitForFunction(()=>document.querySelectorAll('#explorer .np-item').length>=1, {timeout:8000}).catch(()=>{});
  // 点 loan_decision（seed 图）
  const clicked = await page.evaluate(()=>{ const el=[...document.querySelectorAll('#explorer [data-key]')].find(e=>e.getAttribute('data-key')==='loan_decision'); if(el){el.click();return true;} return false; });
  await page.waitForTimeout(1200);
  const svg = await page.evaluate(()=>({
    hasSvg: !!document.querySelector('#content .np-svg'),
    nodeCount: document.querySelectorAll('#content .np-node').length,
    edgeCount: document.querySelectorAll('#content .np-edge').length,
    hasArrow: !!document.querySelector('#content marker'),
  }));
  rec('图态渲染 SVG（非扁平表）', svg.hasSvg && svg.nodeCount>=1, 'clicked='+clicked+' nodes='+svg.nodeCount+' edges='+svg.edgeCount);
  rec('SVG 含节点+箭头', svg.nodeCount>=3 && svg.edgeCount>=1 && svg.hasArrow, `nodes=${svg.nodeCount} edges=${svg.edgeCount} arrow=${svg.hasArrow}`);
  await page.screenshot({path:'/tmp/qa-graph-preview.png'});
  await page.close();
}

// ═══════════ C. graph-designer 编辑器全流程 ═══════════
console.log('\n【C. 决策图设计器 graph-designer】');
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  page.on('pageerror', e=>errs.push('C:'+e));
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mountPage(page, '/rule/graph-designer.js', {key:gkey, name:'QA图测试', version:1});
  // 初始 SVG 渲染（input→dt1→output 3 节点 2 边）
  const init = await page.evaluate(()=>({
    svg: !!document.querySelector('#content .g-svg'),
    nodes: document.querySelectorAll('#content .g-node').length,
    edges: document.querySelectorAll('#content .g-edge').length,
    toolbar: !!document.querySelector('#content [data-act="save"]'),
    nlist: document.querySelectorAll('#explorer .g-nrow').length,
  }));
  rec('设计器 content 渲染 SVG 画布', init.svg && init.nodes>=3, `nodes=${init.nodes} edges=${init.edges}`);
  rec('工具栏 + explorer 节点列表', init.toolbar && init.nlist>=3, `nlist=${init.nlist}`);

  // 加一个 expression 节点
  await page.evaluate(()=>{ const b=[...document.querySelectorAll('#content [data-act="add-node"]')].find(x=>x.getAttribute('data-nodetype')==='expression'); b.click(); });
  await page.waitForTimeout(600);
  const afterAdd = await page.evaluate(()=>document.querySelectorAll('#content .g-node').length);
  rec('加表达式节点 → 节点+1', afterAdd===init.nodes+1, `${init.nodes}→${afterAdd}`);
  // property 应显示 mapping 编辑器（新节点被选中）
  const hasMapEditor = await page.evaluate(()=>!!document.querySelector('#property [data-kind="map-expr"], #property [data-act="add-mapping"]'));
  rec('选中表达式节点→property 映射编辑器', hasMapEditor);

  // 连线：进入连线模式，把新节点连到 out（先点 dt1... 实际连 in→新节点→out 已有，改测连线 UX 存在）
  await page.evaluate(()=>document.querySelector('#content [data-act="toggle-connect"]').click());
  await page.waitForTimeout(300);
  const connectMode = await page.evaluate(()=>document.querySelector('#content [data-act="toggle-connect"]').classList.contains('active'));
  rec('连线模式可切换', connectMode);
  await page.evaluate(()=>document.querySelector('#content [data-act="toggle-connect"]').click()); // 退出
  await page.waitForTimeout(200);

  // 编辑决策表节点：点 explorer 里的 dt1
  await page.evaluate(()=>{ const el=[...document.querySelectorAll('#explorer .g-nrow')].find(e=>e.getAttribute('data-node')==='dt1'); el&&el.click(); });
  await page.waitForTimeout(600);
  const hasTbl = await page.evaluate(()=>!!document.querySelector('#property .g-tbl, #property [data-act="tbl-add-rule"]'));
  rec('选中决策表节点→property 内嵌网格', hasTbl);
  // 加规则行
  await page.evaluate(()=>{ const b=document.querySelector('#property [data-act="tbl-add-rule"]'); b&&b.click(); });
  await page.waitForTimeout(400);
  const rowAdded = await page.evaluate(()=>document.querySelectorAll('#property .g-tbl tbody tr').length);
  rec('决策表节点加规则行', rowAdded>=2, 'rows='+rowAdded);

  // 保存草稿
  await page.evaluate(()=>{ const b=[...document.querySelectorAll('#content [data-act="save"]')][0]; b.click(); });
  await page.waitForTimeout(1200);
  // 后端确认 nodes 增加
  const saved = await page.evaluate(async ({api,k})=>{ const r=await fetch(api+'/api/rules/v1/definitions/'+k); const j=await r.json(); return {nodes:j.data.nodes.length, kind:j.data.kind}; }, {api:API,k:gkey});
  rec('保存草稿→后端 nodes 增加', saved.nodes>=4 && saved.kind==='graph', 'nodes='+saved.nodes);

  // 分析徽章
  const badge = await page.evaluate(()=>document.querySelectorAll('#property .g-badge').length);
  rec('property 图级分析徽章', badge>=1, 'badges='+badge);
  await page.screenshot({path:'/tmp/qa-graph-designer.png'});
  await page.close();
}

// ═══════════ D. 决策表新建不回归 ═══════════
console.log('\n【D. 决策表新建回归】');
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  page.on('pageerror', e=>errs.push('D:'+e));
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mountPage(page, '/rule/design-workbench.js', {});
  await page.waitForFunction(()=>document.querySelectorAll('#explorer .np-item').length>=1, {timeout:8000}).catch(()=>{});
  const tkey='qa_tbl_'+Math.floor(Date.now()/1000)%100000;
  await page.evaluate(()=>document.querySelector('#explorer [data-act="new"]').click());
  await page.waitForTimeout(300);
  await page.evaluate((k)=>{ document.querySelector('#explorer #nc-name').value='QA表回归'; document.querySelector('#explorer #nc-key').value=k; }, tkey); // 默认决策表
  await page.evaluate(()=>document.querySelector('#explorer [data-act="create-ok"]').click());
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async ({api,k})=>{ const rr=await fetch(api+'/api/rules/v1/definitions/'+k); const j=await rr.json(); return j.data.kind; }, {api:API,k:tkey});
  const opened = await page.evaluate(()=>window.__opened||[]);
  rec('决策表新建 kind=decisionTable + 开表设计器', r==='decisionTable' && opened.some(x=>String(x).includes('portal.rules.designer')), 'kind='+r+' opened='+JSON.stringify(opened));
  // 清理
  await page.evaluate(async ({api,k})=>{ await fetch(api+'/api/rules/v1/definitions/'+k,{method:'DELETE'}); }, {api:API,k:tkey});
  await page.close();
}

rec('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('\n结果: '+results.filter(r=>r.ok).length+'/'+results.length+' 通过');
console.log('__GKEY__'+gkey);
await browser.close();
