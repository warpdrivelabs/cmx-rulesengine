import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API = 'http://127.0.0.1:8094';
const results = [];
const rec = (name, ok, detail='') => { results.push({name, ok, detail}); console.log(`  ${ok?'✅':'❌'} ${name}${detail?' — '+detail:''}`); };

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
page.on('dialog', d => d.accept());
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type()==='error') errs.push('console.error: '+m.text()); });

// 通用：挂载一个 native 页的三区
async function mountPage(mod, apiBase) {
  await page.evaluate(async ({apiBase}) => {
    window.openTab = (wn) => { window.__opened = window.__opened||[]; window.__opened.push(wn?.id||wn); return true; };
    document.body.innerHTML = '<div id="explorer"></div><div id="content"></div><div id="property"></div>';
    const m = await import(window.__modUrl);
    window.__m = m;
    if (m.configure) m.configure({ apiBase });
    for (const [id,view] of [['explorer','explorer'],['content','content'],['property','property']]) {
      const h = document.getElementById(id); h.renderRoot = h;
      if (m.default?.views?.[view]) await m.default.views[view]({ host: h, props: window.__props||{} });
    }
  }, {apiBase});
}

// ═══════════ 页1：design-workbench ═══════════
console.log('\n【前端页1】决策集设计工作台 design-workbench');
await page.goto('http://localhost:8099/', { waitUntil:'domcontentloaded' });
await page.evaluate(()=>{ window.__modUrl='/rule/design-workbench.js'; });
await mountPage();
await page.evaluate(async (api)=>{ window.__m.configure({apiBase:api}); }, API);
// 重新挂载让 apiBase 生效
await page.evaluate(async ()=>{
  for (const [id,view] of [['explorer','explorer'],['content','content'],['property','property']]) {
    const h=document.getElementById(id); h.renderRoot=h; await window.__m.default.views[view]({host:h});
  }
});
try {
  await page.waitForFunction(()=>document.querySelectorAll('#explorer .np-item').length>=1, {timeout:8000});
  const n = await page.evaluate(()=>document.querySelectorAll('#explorer .np-item').length);
  rec('explorer 决策集列表渲染', n>=1, `${n} 项`);
} catch(e){ rec('explorer 决策集列表渲染', false, 'timeout'); }

// 点第一个 → content/property
await page.evaluate(()=>document.querySelector('#explorer .np-item').click());
await page.waitForTimeout(900);
const p1sel = await page.evaluate(()=>({
  contentHd: document.querySelector('#content .np-hd')?.textContent.replace(/\s+/g,' ').trim()||'',
  hasTable: !!document.querySelector('#content .np-dt'),
  propKey: document.querySelector('#property .np-kv b')?.textContent||'',
  hasBadge: document.querySelectorAll('#property .np-badge').length,
}));
rec('选中决策→content 预览', p1sel.hasTable || /决策图/.test(p1sel.contentHd), p1sel.contentHd);
rec('选中决策→property 详情+分析徽章', !!p1sel.propKey && p1sel.hasBadge>=1, `key=${p1sel.propKey} badges=${p1sel.hasBadge}`);

// 新建
const newKey = 'qa_fe_' + (await page.evaluate(()=>document.querySelectorAll('#explorer .np-item').length));
await page.evaluate(()=>document.querySelector('#explorer [data-act="new"]').click());
await page.waitForTimeout(300);
const formShown = await page.evaluate(()=>!!document.querySelector('#explorer #nc-name'));
rec('点+新建→内联表单出现', formShown);
await page.evaluate((k)=>{ document.querySelector('#explorer #nc-name').value='QA前端新建'; document.querySelector('#explorer #nc-key').value=k; }, newKey);
await page.evaluate(()=>document.querySelector('#explorer [data-act="create-ok"]').click());
await page.waitForTimeout(1500);
const created = await page.evaluate(async ({api,k})=>{ const r=await fetch(api+'/api/rules/v1/definitions/'+k); return r.status; }, {api:API, k:newKey});
rec('新建→落库(后端200)', created===200, 'key='+newKey);
const openedDesigner = await page.evaluate(()=>Array.isArray(window.__opened)&&window.__opened.some(x=>String(x).includes('designer')));
rec('新建→自动打开设计器', openedDesigner);

// 删除刚建的
await page.evaluate((k)=>{ const b=document.querySelector(`#explorer [data-del="${k}"]`); b&&b.click(); }, newKey);
await page.waitForTimeout(1200);
const delStatus = await page.evaluate(async ({api,k})=>{ const r=await fetch(api+'/api/rules/v1/definitions/'+k); return r.status; }, {api:API, k:newKey});
rec('删除→后端404', delStatus===404);

rec('design-workbench 无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));

console.log('\n__RESULTS__'+JSON.stringify(results));
await page.screenshot({path:'/tmp/qa-fe-design.png'});
await browser.close();
