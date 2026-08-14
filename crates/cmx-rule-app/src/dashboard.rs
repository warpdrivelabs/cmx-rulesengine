//! 决策引擎监控大盘（自包含单页 HTML，编进二进制，轮询 /api/rules/v1/stats）。
//!
//! 对标 cmx-flow-app::dashboard，但指标是决策域（决策集/求值次数/成功率/失败）。R5 前端工作台
//! 落地后此大盘保留为运维总览。

use axum::response::Html;

/// GET / —— 监控大盘。
pub async fn dashboard() -> Html<&'static str> {
    Html(DASHBOARD_HTML)
}

const DASHBOARD_HTML: &str = r#"<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cmx-rulesengine · 决策引擎监控</title>
<style>
:root{--bg:#0b1020;--card:#151b2e;--fg:#e6ebf5;--mut:#8b97b3;--acc:#00e6aa;--acc2:#3a8cff;}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;
background:linear-gradient(160deg,#070a15,#0b1020 40%,#0e1428);color:var(--fg);min-height:100vh}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
.hd{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.logo{width:42px;height:42px;border-radius:11px;background:linear-gradient(135deg,var(--acc),var(--acc2));
display:grid;place-items:center;font-weight:800;color:#04121a;font-size:20px}
h1{font-size:20px;margin:0;font-weight:700}.sub{color:var(--mut);font-size:13px;margin:2px 0 26px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.card{background:var(--card);border:1px solid #212a44;border-radius:16px;padding:22px 20px;position:relative;overflow:hidden}
.card::before{content:"";position:absolute;inset:0 auto auto 0;width:100%;height:3px;
background:linear-gradient(90deg,var(--acc),var(--acc2))}
.k{color:var(--mut);font-size:13px;margin-bottom:10px}
.v{font-size:34px;font-weight:800;letter-spacing:-.5px}
.v small{font-size:15px;color:var(--mut);font-weight:600}
.ok{color:var(--acc)}.bad{color:#ff6b6b}
.foot{margin-top:28px;color:var(--mut);font-size:12px;text-align:center}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--acc);margin-right:6px;
box-shadow:0 0 8px var(--acc);animation:p 1.6s infinite}@keyframes p{50%{opacity:.35}}
</style></head><body><div class="wrap">
<div class="hd"><div class="logo">R</div><div>
<h1>cmx-rulesengine · 决策引擎</h1>
<div class="sub"><span class="dot"></span>对标 GoRules ZEN / DMN · 一芯多壳 · metaKind 第五元 RULE</div></div></div>
<div class="grid">
<div class="card"><div class="k">决策定义</div><div class="v" id="definitions">–</div></div>
<div class="card"><div class="k">已发布</div><div class="v" id="published">–</div></div>
<div class="card"><div class="k">累计求值</div><div class="v" id="evaluations">–</div></div>
<div class="card"><div class="k">失败决策</div><div class="v bad" id="failures">–</div></div>
<div class="card"><div class="k">成功率</div><div class="v ok" id="successRate">–<small>%</small></div></div>
</div>
<div class="foot" id="foot">加载中…</div>
</div><script>
async function tick(){
  try{
    const r=await fetch('/api/rules/v1/stats');const j=await r.json();const d=j.data||{};
    for(const k of ['definitions','published','evaluations','failures']){
      document.getElementById(k).textContent=(d[k]??0).toLocaleString();}
    document.getElementById('successRate').innerHTML=(d.successRate??100)+'<small>%</small>';
    document.getElementById('foot').textContent='最后更新 '+new Date().toLocaleTimeString()+' · 每 5s 刷新';
  }catch(e){document.getElementById('foot').textContent='连接失败: '+e;}
}
tick();setInterval(tick,5000);
</script></body></html>"#;
