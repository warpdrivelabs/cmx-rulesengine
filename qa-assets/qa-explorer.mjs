import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API='http://127.0.0.1:8094';
const results=[]; const rec=(n,ok,d='')=>{results.push(ok);console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);};
const browser = await chromium.launch({ channel:'chrome' });

async function mountExplorer(page, mod){
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await page.evaluate(async ({api,mod})=>{
    document.body.innerHTML='<div id="explorer"></div>';
    const m=await import(mod); m.configure&&m.configure({apiBase:api});
    const h=document.getElementById('explorer'); h.renderRoot=h;
    await m.default.views.explorer({host:h,props:{}});
  }, {api:API,mod});
  await page.waitForTimeout(1800);
}
const itemSel=(pfx)=>`.${pfx}-item, .${pfx}-list li[data-key], #explorer li[data-key]`;

// ═══ design-workbench ═══
console.log('\n【design-workbench explorer】');
{
  const page=await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(String(e))); page.on('console',m=>{if(m.type()==='error'&&!/favicon|404/.test(m.text()))errs.push(m.text());});
  await mountExplorer(page,'/rule/design-workbench.js');
  await page.waitForFunction(()=>document.querySelectorAll('#explorer li[data-key]').length>=1,{timeout:8000}).catch(()=>{});
  const total = await page.evaluate(()=>({items:document.querySelectorAll('#explorer li[data-key]').length, hasSearch:!!document.querySelector('#np-search'), hasPager:!!document.querySelector('.np-pager button')}));
  rec('列表渲染+搜索框+分页条', total.items<=12 && total.hasSearch && total.hasPager, `页内${total.items}项 search=${total.hasSearch} pager=${total.hasPager}`);
  rec('分页：每页≤12', total.items<=12, `${total.items}`);

  // 翻页
  const p1first = await page.evaluate(()=>document.querySelector('#explorer li[data-key]')?.getAttribute('data-key'));
  await page.evaluate(()=>document.querySelector('[data-act="page-next"]').click());
  await page.waitForTimeout(300);
  const p2 = await page.evaluate(()=>({first:document.querySelector('#explorer li[data-key]')?.getAttribute('data-key'), info:document.querySelector('.np-pageinfo')?.textContent.trim()}));
  rec('翻到第2页(内容变、页码2/N)', p2.first!==p1first && /^2 \//.test(p2.info||''), `info=${p2.info} first=${p2.first}`);

  // 搜索
  await page.evaluate(()=>{const i=document.querySelector('#np-search'); i.value='loan'; i.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForTimeout(300);
  const searched = await page.evaluate(()=>{const items=[...document.querySelectorAll('#explorer li[data-key]')].map(l=>l.getAttribute('data-key'));return {count:items.length, allMatch:items.every(k=>/loan/i.test(k))};});
  rec('搜索"loan"→只剩匹配项', searched.count>=1 && searched.allMatch, `${searched.count}项 allMatch=${searched.allMatch}`);

  // 清空搜索
  await page.evaluate(()=>document.querySelector('[data-act="search-clear"]')?.click());
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(()=>({val:document.querySelector('#np-search')?.value, items:document.querySelectorAll('#explorer li[data-key]').length}));
  rec('清空搜索→恢复分页首页', cleared.val==='' && cleared.items<=12, `val="${cleared.val}" items=${cleared.items}`);

  // 刷新按钮存在可点
  const reloadOk = await page.evaluate(()=>{const b=document.querySelector('[data-act="reload"]'); if(b){b.click();return true;} return false;});
  rec('刷新按钮可点', reloadOk);

  rec('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
  await page.screenshot({path:'/tmp/qa-explorer-dw.png'});
  await page.close();
}
console.log('\n结果: '+results.filter(Boolean).length+'/'+results.length);
await browser.close();
