import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API='http://127.0.0.1:8094';
const results=[]; const rec=(n,ok,d='')=>{results.push(ok);console.log(`  ${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);};
const browser = await chromium.launch({ channel:'chrome' });
const page = await browser.newPage();
page.on('pageerror',e=>console.log('ERR',e));
await page.setViewportSize({width:340,height:760});
await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
// 固定高度容器模拟门户 explorer 面板
await page.evaluate(async ({api})=>{
  document.body.style.margin='0';
  document.body.innerHTML='<div id="explorer" style="height:760px;border:1px solid #ccc"></div>';
  const m=await import('/rule/design-workbench.js'); m.configure({apiBase:api});
  const h=document.getElementById('explorer'); h.renderRoot=h;
  await m.default.views.explorer({host:h,props:{}});
}, {api:API});
await page.waitForTimeout(2000);
await page.waitForFunction(()=>document.querySelectorAll('#explorer li[data-key]').length>=1,{timeout:8000}).catch(()=>{});
const m = await page.evaluate(()=>{
  const root=document.querySelector('#explorer .np-root');
  const list=document.querySelector('#explorer .np-list');
  const sb=document.querySelector('#explorer .np-searchbar');
  const input=document.querySelector('#explorer .np-search');
  const icon=document.querySelector('#explorer .np-iconbtn');
  const pager=document.querySelector('#explorer .np-pager');
  const rr=root.getBoundingClientRect(), lr=list.getBoundingClientRect(), ir=input.getBoundingClientRect(), br=icon?icon.getBoundingClientRect():null, pr=pager.getBoundingClientRect();
  return {
    rootH:Math.round(rr.height), listBottom:Math.round(lr.bottom), pagerTop:Math.round(pr.top), rootBottom:Math.round(rr.bottom),
    inputH:Math.round(ir.height), iconH:br?Math.round(br.height):0, iconW:br?Math.round(br.width):0,
    iconInSearchbar: !!(sb && icon && sb.contains(icon)),
    hasReloadInHd: !!document.querySelector('#explorer .np-hd [data-act="reload"]'),
  };
});
// 列表底部应接近 pager 顶部（列表拉伸填满，pager 在底），rootBottom 接近视口底
rec('列表拉伸到底部(list 底≈pager 顶，pager 贴底)', Math.abs(m.listBottom - m.pagerTop) < 20 && (m.rootBottom - m.pagerTop) < 60, `listBottom=${m.listBottom} pagerTop=${m.pagerTop} rootBottom=${m.rootBottom}`);
rec('刷新按钮在搜索框内(不在标题栏)', m.iconInSearchbar && !m.hasReloadInHd);
rec('刷新按钮正方形且与输入框等高', m.iconH===m.iconW && Math.abs(m.iconH - m.inputH) <= 2, `icon ${m.iconW}x${m.iconH} input h=${m.inputH}`);
await page.screenshot({path:'/tmp/qa-layout-dw.png'});
console.log('\n结果: '+results.filter(Boolean).length+'/'+results.length);
await browser.close();
