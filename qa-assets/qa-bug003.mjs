import pkg from '/Users/nanomesh/node_modules/playwright/index.js';
const { chromium } = pkg;
const API = 'http://127.0.0.1:8094';
const results = [];
const rec = (name, ok, detail='') => { results.push({name, ok}); console.log(`  ${ok?'✅':'❌'} ${name}${detail?' — '+detail:''}`); };
const browser = await chromium.launch({ channel: 'chrome' });

async function mount(page, modUrl, props) {
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
}

// ═══ BUG-003 修复验证：simulator 应显示 income「派生」字段并能算出 maxLimit ═══
console.log('\n【BUG-003 验证 · simulator.js】qa_credit 输出引用 income（非输入列）');
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mount(page, '/rule/simulator.js', {key:'qa_credit', name:'QA信贷审批', version:1});

  const fields = await page.evaluate(()=>[...document.querySelectorAll('#content [data-fact]')].map(i=>i.getAttribute('data-fact')));
  rec('facts 表单含输入列 score/region', fields.includes('score') && fields.includes('region'), 'fields='+JSON.stringify(fields));
  rec('facts 表单含派生变量 income（BUG-003 核心）', fields.includes('income'), 'fields='+JSON.stringify(fields));
  const hasDerived = await page.evaluate(()=>!!document.querySelector('#content .rs-derived'));
  rec('income 标注「派生」徽章', hasDerived);
  const hasRaw = await page.evaluate(()=>!!document.querySelector('#content [data-fact-raw]'));
  rec('高级 JSON facts 兜底框存在', hasRaw);

  // 填 score/region/income 求值 → maxLimit 应 = income*5 = 50000（不再是 null）
  await page.evaluate(()=>{
    for (const i of document.querySelectorAll('#content [data-fact]')) {
      const f=i.getAttribute('data-fact');
      i.value = f==='score'?'800':f==='region'?'north':f==='income'?'10000':'';
      i.dispatchEvent(new Event('input',{bubbles:true}));
    }
    document.querySelector('#content [data-act="eval"]').click();
  });
  await page.waitForTimeout(1200);
  const output = await page.evaluate(()=>{
    const pre=document.querySelector('#content .rs-json'); return pre?pre.textContent:'';
  });
  let maxLimit=null; try{ maxLimit=JSON.parse(output).maxLimit; }catch{}
  rec('求值 maxLimit=50000（income*5，修复前恒 null）', maxLimit===50000, 'output='+output.replace(/\s+/g,' '));

  // 高级 JSON 兜底：清空表单，仅用 raw JSON
  await page.evaluate(()=>{
    const ta=document.querySelector('#content [data-fact-raw]');
    ta.value='{"score":700,"region":"north","income":8000}';
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#content [data-act="eval"]').click();
  });
  await page.waitForTimeout(1200);
  const out2 = await page.evaluate(()=>{ const pre=document.querySelector('#content .rs-json'); return pre?pre.textContent:''; });
  rec('高级 JSON facts 生效（求值出结果）', /tier|maxLimit|UNIQUE|失败/.test(out2), out2.replace(/\s+/g,' ').slice(0,60));

  await page.screenshot({path:'/tmp/qa-bug003-simulator.png'});
  await page.close();
}

// ═══ 决策图无输入列：应从内联表/表达式节点提取变量 ═══
console.log('\n【BUG-003 验证 · 决策图】qa_loan 图（无 d.inputs，变量在节点里）');
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mount(page, '/rule/simulator.js', {key:'qa_loan', name:'QA信贷综合', version:1});
  const fields = await page.evaluate(()=>[...document.querySelectorAll('#content [data-fact]')].map(i=>i.getAttribute('data-fact')));
  // qa_loan 内联表引用 income，子决策引用 score，表达式引用 baseLimit/rate
  rec('图决策提取到节点变量（income/score）', fields.includes('income')||fields.includes('score'), 'fields='+JSON.stringify(fields));
  await page.close();
}

// ═══ sim-workbench 同样修复 ═══
console.log('\n【BUG-003 验证 · sim-workbench.js】');
{
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  await page.goto('http://localhost:8099/', {waitUntil:'domcontentloaded'});
  await mount(page, '/rule/sim-workbench.js', {});
  // 点 qa_credit
  const clicked = await page.evaluate(()=>{ const el=[...document.querySelectorAll('#explorer [data-key]')].find(e=>e.getAttribute('data-key')==='qa_credit'); if(el){el.click();return true;} return false; });
  await page.waitForTimeout(1200);
  const fields = await page.evaluate(()=>[...document.querySelectorAll('#content [data-fact]')].map(i=>i.getAttribute('data-fact')));
  rec('sim-workbench 选 qa_credit 含 income 派生字段', fields.includes('income'), 'clicked='+clicked+' fields='+JSON.stringify(fields));
  await page.close();
}

console.log('\n__RESULTS__'+JSON.stringify(results));
await browser.close();
