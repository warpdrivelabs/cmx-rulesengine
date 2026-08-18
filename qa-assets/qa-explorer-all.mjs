import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API='http://127.0.0.1:8094';
const results=[]; const rec=(n,ok,d='')=>{results.push(ok);console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);};
const browser = await chromium.launch({ channel:'chrome' });

// cfg: {mod, searchId, reloadAct, prevAct, clearAct}
async function testExplorer(label, cfg){
  console.log('\n【'+label+'】');
  const page=await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(String(e))); page.on('console',m=>{if(m.type()==='error'&&!/favicon|404/.test(m.text()))errs.push(m.text());});
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await page.evaluate(async ({api,mod})=>{
    document.body.innerHTML='<div id="explorer"></div>';
    const m=await import(mod); m.configure&&m.configure({apiBase:api});
    const h=document.getElementById('explorer'); h.renderRoot=h;
    await m.default.views.explorer({host:h,props:{}});
  }, {api:API,mod:cfg.mod});
  await page.waitForTimeout(1800);
  await page.waitForFunction(()=>document.querySelectorAll('#explorer li[data-key]').length>=1,{timeout:8000}).catch(()=>{});
  const init = await page.evaluate((sid)=>({items:document.querySelectorAll('#explorer li[data-key]').length, hasSearch:!!document.querySelector('#'+sid), hasPager:!!document.querySelector('[data-act$="prev"],[data-act$="next"]')}), cfg.searchId);
  rec('搜索框+分页条+每页≤12', init.items<=12 && init.hasSearch && init.hasPager, `${init.items}项 search=${init.hasSearch} pager=${init.hasPager}`);

  // 翻页
  const p1 = await page.evaluate(()=>document.querySelector('#explorer li[data-key]')?.getAttribute('data-key'));
  await page.evaluate((a)=>document.querySelector('[data-act="'+a+'"]').click(), cfg.nextAct);
  await page.waitForTimeout(300);
  const p2first = await page.evaluate(()=>document.querySelector('#explorer li[data-key]')?.getAttribute('data-key'));
  rec('翻下一页内容变', p2first!==p1, `${p1}→${p2first}`);

  // 搜索
  await page.evaluate((sid)=>{const i=document.querySelector('#'+sid); i.value='qa_hp'; i.dispatchEvent(new Event('input',{bubbles:true}));}, cfg.searchId);
  await page.waitForTimeout(300);
  const s = await page.evaluate(()=>{const ks=[...document.querySelectorAll('#explorer li[data-key]')].map(l=>l.getAttribute('data-key'));return {n:ks.length, all:ks.every(k=>/qa_hp/i.test(k))};});
  rec('搜索"qa_hp"只剩匹配', s.n>=1 && s.all, `${s.n}项 all=${s.all}`);

  // 清空
  await page.evaluate((a)=>document.querySelector('[data-act="'+a+'"]')?.click(), cfg.clearAct);
  await page.waitForTimeout(300);
  const c = await page.evaluate((sid)=>({v:document.querySelector('#'+sid)?.value, n:document.querySelectorAll('#explorer li[data-key]').length}), cfg.searchId);
  rec('清空搜索恢复', c.v==='' && c.n<=12, `v="${c.v}" n=${c.n}`);

  // 刷新
  const rl = await page.evaluate((a)=>{const b=document.querySelector('[data-act="'+a+'"]'); if(b){b.click();return true;} return false;}, cfg.reloadAct);
  rec('刷新按钮可点', rl);
  rec('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
  await page.close();
}

await testExplorer('sim-workbench', {mod:'/rule/sim-workbench.js', searchId:'np-search', reloadAct:'reload', nextAct:'page-next', clearAct:'search-clear'});
await testExplorer('logs', {mod:'/rule/logs.js', searchId:'rl-search', reloadAct:'list-reload', nextAct:'list-next', clearAct:'list-search-clear'});
console.log('\n结果: '+results.filter(Boolean).length+'/'+results.length);
await browser.close();
