import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API = 'http://127.0.0.1:8094';
const results = [];
const rec = (name, ok, detail='') => { results.push({name, ok, detail}); console.log(`  ${ok?'✅':'❌'} ${name}${detail?' — '+detail:''}`); };
const benign = e => /favicon\.ico/.test(e) || /Failed to load resource.*404/.test(e);

const browser = await chromium.launch({ channel: 'chrome' });

// 通用挂载：多实例页需要 props（key@@version）
async function testPage(modUrl, props, label, checks) {
  const page = await browser.newPage();
  page.on('dialog', d => d.accept());
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type()==='error' && !benign(m.text())) errs.push('cerr:'+m.text()); });
  await page.goto('http://localhost:8099/', { waitUntil:'domcontentloaded' });
  await page.evaluate(async ({modUrl, api, props}) => {
    window.openTab = (wn)=>{ window.__opened=window.__opened||[]; window.__opened.push(wn?.id||wn); return true; };
    document.body.innerHTML='<div id="explorer"></div><div id="content"></div><div id="property"></div>';
    const m = await import(modUrl); window.__m=m;
    if (m.configure) m.configure({ apiBase: api });
    for (const [id,view] of [['explorer','explorer'],['content','content'],['property','property']]) {
      const h=document.getElementById(id); h.renderRoot=h;
      if (m.default?.views?.[view]) await m.default.views[view]({ host:h, props });
    }
  }, {modUrl, api:API, props});
  await page.waitForTimeout(1500);
  await checks(page, errs);
  rec(`${label} 无 JS 错误`, errs.length===0, errs.slice(0,2).join(' | '));
  await page.screenshot({path:`/tmp/qa-fe-${label}.png`});
  await page.close();
}

// ═══════════ 页2：designer（决策表设计器，多实例）═══════════
console.log('\n【前端页2】决策表设计器 designer');
await testPage('/rule/designer.js', {key:'qa_credit', name:'QA信贷审批', version:1}, 'designer', async (page, errs)=>{
  const st = await page.evaluate(()=>({
    grid: document.querySelectorAll('#content table tr, #content .rd-grid, #content [class*=grid] tr').length,
    hasHitPolicy: !!document.querySelector('#content [data-act="hitpolicy"], #content select'),
    contentText: (document.querySelector('#content')?.textContent||'').replace(/\s+/g,' ').slice(0,80),
    explorerText: (document.querySelector('#explorer')?.textContent||'').replace(/\s+/g,' ').slice(0,60),
    propText: (document.querySelector('#property')?.textContent||'').replace(/\s+/g,' ').slice(0,60),
  }));
  rec('designer content 渲染网格', st.grid>=1 || /命中|规则|输入|输出/.test(st.contentText), `rows=${st.grid} "${st.contentText}"`);
  rec('designer 命中策略选择器', st.hasHitPolicy);
  rec('designer explorer 字段/函数区', st.explorerText.length>0, st.explorerText);
  rec('designer property 分析区', st.propText.length>0, st.propText);
  // 交互：改命中策略触发重分析
  const changed = await page.evaluate(()=>{
    const sel=document.querySelector('#content select[data-act="hitpolicy"], #content select');
    if(!sel) return false; sel.value='F'; sel.dispatchEvent(new Event('change',{bubbles:true})); return true;
  });
  rec('designer 改命中策略交互', changed);
});

// ═══════════ 页3：simulator（仿真台，多实例）═══════════
console.log('\n【前端页3】决策仿真台 simulator');
await testPage('/rule/simulator.js', {key:'qa_credit', name:'QA信贷审批', version:1}, 'simulator', async (page, errs)=>{
  const st = await page.evaluate(()=>({
    hasFactInput: document.querySelectorAll('#content input, #content textarea, #content [data-fact]').length,
    hasEvalBtn: !!document.querySelector('#content [data-act="eval"], #content button'),
    explorerText:(document.querySelector('#explorer')?.textContent||'').replace(/\s+/g,' ').slice(0,60),
  }));
  rec('simulator facts 输入区', st.hasFactInput>=1, `inputs=${st.hasFactInput}`);
  rec('simulator 求值按钮', st.hasEvalBtn);
  rec('simulator explorer 用例集', st.explorerText.length>0, st.explorerText);
  // 交互：填 facts + 求值
  const evalOk = await page.evaluate(async ()=>{
    // 找 facts 输入并填
    const ins=[...document.querySelectorAll('#content [data-fact]')];
    for(const i of ins){ const f=i.getAttribute('data-fact'); if(f==='score')i.value='800'; else if(f==='region')i.value='north'; else if(f==='income')i.value='10000'; else i.value='1'; i.dispatchEvent(new Event('input',{bubbles:true})); }
    const btn=document.querySelector('#content [data-act="eval"]'); if(btn) btn.click();
    return ins.length;
  });
  await page.waitForTimeout(1200);
  const afterEval = await page.evaluate(()=>(document.querySelector('#content')?.textContent||'').replace(/\s+/g,' '));
  rec('simulator 求值交互出输出', /tier|A|输出|命中|maxLimit/.test(afterEval), afterEval.slice(0,80));
});

// ═══════════ 页4：sim-workbench（应用工作台）═══════════
console.log('\n【前端页4】决策应用工作台 sim-workbench');
await testPage('/rule/sim-workbench.js', {}, 'sim-workbench', async (page, errs)=>{
  const st = await page.evaluate(()=>({
    explorerItems: document.querySelectorAll('#explorer .np-item, #explorer li, #explorer [data-key]').length,
    explorerText:(document.querySelector('#explorer')?.textContent||'').replace(/\s+/g,' ').slice(0,60),
    contentText:(document.querySelector('#content')?.textContent||'').replace(/\s+/g,' ').slice(0,60),
  }));
  rec('sim-workbench explorer 决策集列表', st.explorerItems>=1 || st.explorerText.length>0, `items=${st.explorerItems}`);
  rec('sim-workbench content 渲染', st.contentText.length>0, st.contentText);
});

// ═══════════ 页5：logs（审计中心）═══════════
console.log('\n【前端页5】决策审计中心 logs');
await testPage('/rule/logs.js', {}, 'logs', async (page, errs)=>{
  const st = await page.evaluate(()=>({
    explorerItems: document.querySelectorAll('#explorer .np-item, #explorer li, #explorer [data-key]').length,
    explorerText:(document.querySelector('#explorer')?.textContent||'').replace(/\s+/g,' ').slice(0,60),
  }));
  rec('logs explorer 决策集列表', st.explorerItems>=1 || st.explorerText.length>0, `items=${st.explorerItems}`);
  // 点一个有日志的决策（qa_risk）→ content 日志列表
  const clicked = await page.evaluate(()=>{
    const el=[...document.querySelectorAll('#explorer [data-key]')].find(e=>/qa_risk|credit|risk/.test(e.getAttribute('data-key')||''));
    if(el){el.click();return el.getAttribute('data-key');} return null;
  });
  await page.waitForTimeout(1200);
  const logText = await page.evaluate(()=>(document.querySelector('#content')?.textContent||'').replace(/\s+/g,' '));
  rec('logs 点决策→日志列表', clicked!==null, 'clicked='+clicked);
  // 点一条日志 → property trace
  const logClicked = await page.evaluate(()=>{
    const el=document.querySelector('#content [data-log]'); if(el){el.click();return true;} return false;
  });
  await page.waitForTimeout(900);
  const propText = await page.evaluate(()=>(document.querySelector('#property')?.textContent||'').replace(/\s+/g,' '));
  rec('logs 点日志→property trace 归因', logClicked && propText.length>0, propText.slice(0,60));
});

console.log('\n__RESULTS__'+JSON.stringify(results));
await browser.close();
