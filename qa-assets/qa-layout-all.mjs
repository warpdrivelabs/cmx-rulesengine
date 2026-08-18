import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API='http://127.0.0.1:8094';
const results=[]; const rec=(n,ok,d='')=>{results.push(ok);console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);};
const browser = await chromium.launch({ channel:'chrome' });

async function test(label, cfg){
  console.log('\n【'+label+'】');
  const page=await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(String(e))); page.on('console',m=>{if(m.type()==='error'&&!/favicon|404/.test(m.text()))errs.push(m.text());});
  await page.setViewportSize({width:340,height:760});
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await page.evaluate(async ({api,mod})=>{
    document.body.style.margin='0';
    document.body.innerHTML='<div id="explorer" style="height:760px"></div>';
    const m=await import(mod); m.configure&&m.configure({apiBase:api});
    const h=document.getElementById('explorer'); h.renderRoot=h;
    await m.default.views.explorer({host:h,props:{}});
  }, {api:API,mod:cfg.mod});
  await page.waitForTimeout(1800);
  await page.waitForFunction(()=>document.querySelectorAll('#explorer li[data-key]').length>=1,{timeout:8000}).catch(()=>{});
  const m = await page.evaluate((cfg)=>{
    const list=document.querySelector('#explorer .'+cfg.listCls);
    const input=document.querySelector('#explorer .'+cfg.searchCls);
    const icon=document.querySelector('#explorer .'+cfg.iconCls);
    const sb=document.querySelector('#explorer .'+cfg.sbCls);
    const pager=document.querySelector('#explorer .'+cfg.pagerCls);
    const lr=list.getBoundingClientRect(), ir=input.getBoundingClientRect(), br=icon?icon.getBoundingClientRect():null, pr=pager.getBoundingClientRect();
    return { listBottom:Math.round(lr.bottom), pagerTop:Math.round(pr.top),
      inputH:Math.round(ir.height), iconH:br?Math.round(br.height):0, iconW:br?Math.round(br.width):0,
      iconInSb: !!(sb&&icon&&sb.contains(icon)), hdHasReload: !!document.querySelector('#explorer .'+cfg.hdCls+' button[data-act$="reload"]') };
  }, cfg);
  rec('列表拉伸到底(list底≈pager顶)', Math.abs(m.listBottom - m.pagerTop) < 22, `listBottom=${m.listBottom} pagerTop=${m.pagerTop}`);
  rec('刷新在搜索框内非标题栏', m.iconInSb && !m.hdHasReload);
  rec('刷新正方形且与输入等高', m.iconH===m.iconW && Math.abs(m.iconH-m.inputH)<=2, `icon ${m.iconW}x${m.iconH} input ${m.inputH}`);
  rec('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
  await page.screenshot({path:`/tmp/qa-layout-${label}.png`});
  await page.close();
}
await test('sim-workbench', {mod:'/rule/sim-workbench.js', listCls:'np-list', searchCls:'np-search', iconCls:'np-iconbtn', sbCls:'np-searchbar', pagerCls:'np-pager', hdCls:'np-hd'});
await test('logs', {mod:'/rule/logs.js', listCls:'rl-list', searchCls:'rl-search', iconCls:'rl-iconbtn', sbCls:'rl-searchbar', pagerCls:'rl-pager', hdCls:'rl-hd'});
console.log('\n结果: '+results.filter(Boolean).length+'/'+results.length);
await browser.close();
