#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cmx-rulesengine 设计方案配图生成器。
产出：docs/assets/*.svg（可编辑源）+ docs/assets/_diagrams.json（name→base64 data URI）。
统一科技感视觉语言：锚定蓝(#0a6ed1)/青(#00a99a)/紫(#7c5cff)/绿/琥珀/红，浅底细网格，圆角+投影。
"""
import base64, html, json, os

INK="#1c2530"; MUT="#5a6b7b"; FAINT="#8b97b3"
BG="#ffffff"; PANEL="#eef3fb"; LINE="#d5dce5"
BLUE="#0a6ed1"; TEAL="#00a99a"; PURPLE="#7c5cff"; GREEN="#178a5a"; AMBER="#c26a00"; RED="#d1394a"; SLATE="#5a6b7b"

def mix(hexc, pct, other="#ffffff"):
    a=hexc.lstrip('#'); b=other.lstrip('#')
    ar,ag,ab=int(a[0:2],16),int(a[2:4],16),int(a[4:6],16)
    br,bg,bb=int(b[0:2],16),int(b[2:4],16),int(b[4:6],16)
    r=round(ar*pct+br*(1-pct)); g=round(ag*pct+bg*(1-pct)); bl=round(ab*pct+bb*(1-pct))
    return f"#{r:02x}{g:02x}{bl:02x}"

def esc(s): return html.escape(str(s), quote=True)

def txt(x,y,s,size=13,fill=INK,w="400",anchor="start",spacing=None,family=None,italic=False):
    sp=f' letter-spacing="{spacing}"' if spacing else ""
    fam=family or "ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif"
    it=' font-style="italic"' if italic else ""
    return f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{w}" fill="{fill}" text-anchor="{anchor}"{sp}{it}>{esc(s)}</text>'

MONO="ui-monospace,'SF Mono',Menlo,Consolas,monospace"

def box(x,y,w,h,fill=BG,stroke=LINE,rx=10,sw=1.2,dash=None,shadow=False,op=None):
    d=f' stroke-dasharray="{dash}"' if dash else ""
    o=f' fill-opacity="{op}"' if op is not None else ""
    sh=' filter="url(#sh)"' if shadow else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}{o}{sh}/>'

def line(x1,y1,x2,y2,color=LINE,w=1.4,dash=None):
    d=f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{w}"{d}/>'

def arrow(x1,y1,x2,y2,color=SLATE,w=1.8,dash=None,marker=None):
    d=f' stroke-dasharray="{dash}"' if dash else ""
    m=marker or _mk(color)
    return f'<path d="M{x1},{y1} L{x2},{y2}" fill="none" stroke="{color}" stroke-width="{w}"{d} marker-end="url(#{m})"/>'

def curve(x1,y1,x2,y2,color=SLATE,w=1.8,marker=None,dash=None):
    mx=(x1+x2)/2; m=marker or _mk(color)
    d=f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="M{x1},{y1} C{mx},{y1} {mx},{y2} {x2},{y2}" fill="none" stroke="{color}" stroke-width="{w}"{d} marker-end="url(#{m})"/>'

def vcurve(x1,y1,x2,y2,color=SLATE,w=1.8,marker=None,dash=None):
    my=(y1+y2)/2; m=marker or _mk(color)
    d=f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="M{x1},{y1} C{x1},{my} {x2},{my} {x2},{y2}" fill="none" stroke="{color}" stroke-width="{w}"{d} marker-end="url(#{m})"/>'

_MK={BLUE:"arrb",GREEN:"arrg",PURPLE:"arrp",TEAL:"arrt",RED:"arrr",AMBER:"arra",SLATE:"arr",MUT:"arr",FAINT:"arrf",INK:"arri"}
def _mk(c): return _MK.get(c,"arr")

def chip(x,y,w,h,label,color=BLUE,size=12,wt="600",tf=None):
    return box(x,y,w,h,fill=mix(color,0.13),stroke=mix(color,0.42),rx=h/2)+txt(x+w/2,y+h/2+size*0.35,label,size,tf or color,wt,"middle")

def node(x,y,w,h,title,subs=None,color=BLUE,fill=None,tsize=14,tcolor=INK,accent=True):
    f=fill if fill is not None else mix(color,0.06)
    s=box(x,y,w,h,fill=f,stroke=mix(color,0.5),rx=11,shadow=True)
    if accent: s+=f'<rect x="{x}" y="{y}" width="4.5" height="{h}" rx="2" fill="{color}"/>'
    if subs:
        s+=txt(x+16,y+24,title,tsize,tcolor,"700")
        yy=y+43
        for sub in subs: s+=txt(x+16,yy,sub,11.3,MUT,"400"); yy+=16.5
    else:
        s+=txt(x+w/2,y+h/2+tsize*0.35,title,tsize,tcolor,"700","middle")
    return s

def caption(x,y,t,sub=None):
    s=f'<rect x="{x}" y="{y-13}" width="4" height="17" rx="2" fill="url(#hd)"/>'
    s+=txt(x+11,y,t,15,INK,"700")
    if sub: s+=txt(x+11,y+18,sub,11.5,FAINT,"400")
    return s

def svg(w,h,body,grid=False):
    markers="".join(
        f'<marker id="{mid}" markerWidth="9" markerHeight="9" refX="7.2" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0.5,0.5 L8.5,4.5 L0.5,8.5 z" fill="{col}"/></marker>'
        for mid,col in [("arr",SLATE),("arrb",BLUE),("arrg",GREEN),("arrp",PURPLE),("arrt",TEAL),("arrr",RED),("arra",AMBER),("arrf",FAINT),("arri",INK)])
    g=""
    if grid:
        g=(f'<rect width="{w}" height="{h}" fill="url(#grid)"/>')
    defs=(f'<defs>'
        f'<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3.2" flood-color="#1c2530" flood-opacity="0.11"/></filter>'
        f'<linearGradient id="hd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{BLUE}"/><stop offset="1" stop-color="{TEAL}"/></linearGradient>'
        f'<linearGradient id="core" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{mix(BLUE,0.16)}"/><stop offset="1" stop-color="{mix(TEAL,0.16)}"/></linearGradient>'
        f'<pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse"><rect width="26" height="26" fill="{BG}"/><path d="M26 0 L0 0 0 26" fill="none" stroke="{mix(BLUE,0.06)}" stroke-width="1"/></pattern>'
        f'{markers}</defs>')
    back=f'<rect width="{w}" height="{h}" fill="{BG}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
            f'{defs}{back}{g}{body}</svg>')

# ═══════════════════════════════ 1. 一芯多壳架构 ═══════════════════════════════
def d_arch():
    W,H=980,620; b=[caption(28,40,"总体架构 · 一芯多壳（One-Core-Multi-Shell）","中立核零框架依赖，薄壳承载部署形态——参照 cmx-flowengine / cmx-report")]
    # 外部依赖 chips 右侧
    b.append(txt(W-30,86,"外部依赖",11,FAINT,"600","end"))
    for i,(nm,c) in enumerate([("axum",BLUE),("tokio-postgres",GREEN),("rhai 1.25",PURPLE),("serde",SLATE)]):
        b.append(chip(W-150,98+i*30,120,22,nm,c,11))
    # 壳层
    b.append(node(70,80,300,66,"cmx-rule-server",["独立 bin · 监听 :8094 · chassis 装配"],BLUE))
    b.append(node(400,80,300,66,"cmx-rule-api（门户侧）",["反代壳 proxy-only · 内嵌↔独立仅切 urls"],TEAL))
    b.append(txt(70,168,"部署壳（薄）",11,FAINT,"600"))
    # app 核
    b.append(node(70,190,630,74,"cmx-rule-app · 中立应用核",
        ["26 条 REST 路由（rule_routes::<S> 泛型）· handlers · tenancy 多租户 · stats 大盘 · 求值即落审计日志"],TEAL,tsize=15))
    # engine
    b.append(node(70,300,630,72,"cmx-rule-engine · 求值引擎",
        ["evaluate_with（决策表/图/脚本分派）· graph.rs（Kahn 拓扑编排）· analyze.rs（gap/overlap 完整性分析）"],PURPLE,tsize=15))
    # feel + store
    b.append(node(70,408,300,84,"cmx-rule-feel",
        ["FEEL 引擎：tokenizer+Pratt+eval","~25 内置函数 · Constraint 区域推理","Rhai 脚本沙箱（script.rs）"],AMBER))
    b.append(node(400,408,300,84,"cmx-rule-store-pg",
        ["PgDecisionStore（DecisionStore trait）","5 张表 · 无 RU（工作内存）","tokio-postgres 并行连接池"],GREEN))
    # model 核
    b.append(box(70,528,630,64,fill="url(#core)",stroke=mix(BLUE,0.5),rx=13,shadow=True))
    b.append(txt(86,556,"cmx-rule-model · 中立领域核",15,INK,"800"))
    b.append(txt(86,576,"HitPolicy · DecisionDef/DecisionBody · DecisionTable/Graph/ScriptBody · TraceNode · CoverageReport · 仅依赖 serde",11.3,mix(INK,0.7)))
    # depends-on arrows (down)
    def dn(x1,y1,x2,y2,c): return arrow(x1,y1,x2,y2,c,1.7,marker=_mk(c))
    b.append(dn(220,146,220,190,BLUE)); b.append(dn(540,146,430,190,TEAL))
    b.append(dn(300,264,300,300,PURPLE)); b.append(dn(470,264,470,300,PURPLE))
    b.append(dn(220,372,220,408,AMBER)); b.append(dn(520,372,540,408,GREEN))
    b.append(dn(220,492,300,528,SLATE)); b.append(dn(540,492,470,528,SLATE))
    b.append(txt(714,236,"↑ 依赖方向",10.5,FAINT,"600"))
    b.append(txt(714,252,"（壳→核）",10.5,FAINT,"400"))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 2. metaKind + DecisionBody ═══════════════════════════════
def d_metakind():
    W,H=980,470; b=[caption(28,40,"领域定位 · metaKind 分类学第五元 RULE","决策集 DecisionDef 一体三态：决策表 / 决策图 / 脚本决策")]
    metas=[("DCT","字典",SLATE),("DOC","单据",SLATE),("FLX","流程表单",SLATE),("RPT","报表",SLATE),("RULE","决策规则",BLUE)]
    x0=70
    for i,(k,zh,c) in enumerate(metas):
        x=x0+i*175; hi=(k=="RULE")
        b.append(node(x,80,150,62,k,[zh],c,fill=mix(c,0.14) if hi else BG,tsize=17,tcolor=c if hi else INK))
        if hi: b.append(txt(x+75,158,"▲ 本引擎",10.5,BLUE,"700","middle"))
    # DecisionDef
    cx=W/2
    b.append(node(cx-165,205,330,62,"DecisionDef（决策集）",["key（跨版本稳定）· name · version · body"],BLUE,tsize=15))
    b.append(arrow(70+4*175+75,142,cx,205,BLUE,1.8,marker="arrb"))
    # three bodies
    trio=[("decisionTable","决策表",["输入列 × 规则行 × 输出列","11 命中策略 · gap/overlap 分析"],GREEN),
          ("graph","决策图 JDM",["JSON DAG · 6 类节点","Kahn 拓扑编排多决策"],PURPLE),
          ("script","脚本决策",["Rhai 过程式逃生舱","阶梯/多步/带状态计算"],AMBER)]
    bw=290; gap=17; total=3*bw+2*gap; sx=(W-total)/2
    for i,(kind,zh,subs,c) in enumerate(trio):
        x=sx+i*(bw+gap)
        b.append(node(x,320,bw,120,f'{zh}',subs,c,tsize=15))
        b.append(f'<text x="{x+bw-14}" y="{320+26}" font-family="{MONO}" font-size="11" fill="{c}" text-anchor="end" font-weight="700">kind:"{kind}"</text>')
        b.append(arrow(cx,267,x+bw/2,320,c,1.7,marker=_mk(c)))
    b.append(txt(cx,296,"DecisionBody（internally tagged · tag=\"kind\"，与 GoRules JDM 同构）",11.5,MUT,"500","middle"))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 3. 决策表解剖 ═══════════════════════════════
def d_table():
    W,H=980,520; b=[caption(28,40,"决策表解剖 · 输入判定（FEEL）× 输出赋值","招牌能力：声明式二维表 + 命中策略；判定侧永远 FEEL，保完整性分析有效")]
    gx,gy=70,110; cellw=[54,150,150,150,150]; rowh=40; hh=64
    heads=[("#","idx",SLATE),("score 分数","IN",BLUE),("region 地区","IN",BLUE),("level 等级","OUT",GREEN),("limit 额度","OUT",GREEN)]
    x=gx
    xs=[gx]
    for w in cellw: xs.append(xs[-1]+w)
    tblw=xs[-1]-gx
    # hit policy badge
    b.append(chip(gx+tblw-150,74,150,26,"命中策略：U · 唯一",BLUE,12))
    # header
    for i,(t,tag,c) in enumerate(heads):
        cx=xs[i]
        fill=mix(c,0.14) if i>0 else mix(SLATE,0.08)
        b.append(box(cx,gy,cellw[i],hh,fill=fill,stroke=mix(c,0.4),rx=0,sw=1))
        if i==0:
            b.append(txt(cx+cellw[i]/2,gy+hh/2+5,"#",13,SLATE,"700","middle"))
        else:
            b.append(txt(cx+10,gy+26,t,12.5,INK,"700"))
            b.append(chip(cx+cellw[i]-42,gy+hh-26,32,17,tag,c,9.5))
    # rows
    data=[("1",'> 700','"north","south"','"A"','50000'),
          ("2",'[600..700)','-','"B"','30000'),
          ("3",'< 600','-','"C"','10000')]
    for r,row in enumerate(data):
        ry=gy+hh+r*rowh
        for i,val in enumerate(row):
            cx=xs[i]
            fill=BG if i==0 else (mix(BLUE,0.04) if heads[i][1]=="IN" else mix(GREEN,0.05))
            b.append(box(cx,ry,cellw[i],rowh,fill=fill,stroke=LINE,rx=0,sw=1))
            fam=MONO if i>0 else None
            col=INK if i>0 else FAINT
            b.append(f'<text x="{cx+ (cellw[i]/2 if i==0 else 10)}" y="{ry+rowh/2+4.5}" font-family="{fam or "ui-sans-serif,system-ui"}" font-size="12" fill="{col}" text-anchor="{"middle" if i==0 else "start"}">{esc(val)}</text>')
    by=gy+hh+len(data)*rowh
    # annotations
    b.append(arrow(xs[1]+70,by+18,xs[1]+70,by+2,BLUE,1.6,marker="arrb"))
    b.append(txt(xs[1]+80,by+34,"输入列 = FEEL unary test（区间/比较/集合/-通配）",11.5,BLUE,"600"))
    b.append(arrow(xs[3]+70,by+18,xs[3]+70,by+2,GREEN,1.6,marker="arrg"))
    b.append(txt(xs[3]+80,by+34,"输出列 = FEEL 表达式 / 字面量 / =rhai: 脚本",11.5,GREEN,"600"))
    # eval example
    ey=by+58
    b.append(node(gx,ey,tblw,58,"求值示例",["input {score:750, region:\"north\"} → 命中规则 1 → output {level:\"A\", limit:50000}"],TEAL,tsize=13))
    return svg(W,H,"".join(b),grid=False)

# ═══════════════════════════════ 4. 11 命中策略 ═══════════════════════════════
def d_policies():
    W,H=980,470; b=[caption(28,40,"11 种命中策略（Hit Policy）· 对齐 DMN 标准","多行命中时如何裁决输出——单命中 / 多命中 / 聚合三族")]
    groups=[("单命中（返回一行输出）",BLUE,[("U","Unique 唯一 · 多命中即冲突"),("A","Any 任意 · 多命中须同值"),("P","Priority · 按值优先取一"),("F","First · 按行序取首命中")]),
            ("多命中（返回数组）",PURPLE,[("C","Collect 收集——所有命中输出成列表"),("R","RuleOrder 规则序——按行序收集"),("O","OutputOrder 输出序——按输出优先序收集")]),
            ("聚合（Collect 变体，返回单值）",GREEN,[("C+","CollectSum 求和"),("C<","CollectMin 最小"),("C>","CollectMax 最大"),("C#","CollectCount 计数")])]
    y=78
    for title,c,items in groups:
        b.append(f'<rect x="28" y="{y-2}" width="6" height="{22+len(items)//4*0}" rx="3" fill="{c}"/>')
        b.append(txt(44,y+13,title,13.5,c,"700"))
        yy=y+30
        # chips grid
        perrow=4; cw=224; ch=44; gapx=10
        for i,(code,desc) in enumerate(items):
            col=i%perrow; xx=44+col*(cw+gapx); ry=yy+(i//perrow)*(ch+9)
            b.append(box(xx,ry,cw,ch,fill=mix(c,0.05),stroke=mix(c,0.35),rx=9))
            b.append(f'<rect x="{xx+8}" y="{ry+8}" width="30" height="{ch-16}" rx="6" fill="{mix(c,0.16)}" stroke="{mix(c,0.4)}"/>')
            b.append(f'<text x="{xx+23}" y="{ry+ch/2+5}" font-family="{MONO}" font-size="13" font-weight="800" fill="{c}" text-anchor="middle">{esc(code)}</text>')
            b.append(txt(xx+46,ry+ch/2+4,desc,10.6,INK,"500"))
        y=yy+((len(items)-1)//perrow+1)*(ch+9)+16
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 5. FEEL 流水线 ═══════════════════════════════
def d_feel():
    W,H=980,430; b=[caption(28,40,"FEEL 表达式引擎 · 自研三段流水线","离线自研 tokenizer + Pratt 解析器 + 求值器；对齐 DMN 标准（超越 ZEN 私有方言）")]
    stages=[("源文本","score > 700 and ...",SLATE,MONO),
            ("① Tokenizer","词法：数/串/标识/运算符/区间",BLUE,None),
            ("② Pratt Parser","按绑定力构 AST（左/右结合）",PURPLE,None),
            ("③ Evaluator","递归求值 → Value（f64 归一）",TEAL,None)]
    x=58; y=92; bw=198; gap=26
    for i,(t,s,c,fam) in enumerate(stages):
        xx=x+i*(bw+gap)
        b.append(node(xx,y,bw,88,t,None,c,tsize=13.5))
        b.append(f'<text x="{xx+bw/2}" y="{y+58}" font-family="{fam or "ui-sans-serif,system-ui"}" font-size="10.2" fill="{MUT}" text-anchor="middle">{esc(s)}</text>')
        if i<3: b.append(arrow(xx+bw,y+44,xx+bw+gap,y+44,c,2,marker=_mk(c)))
    # builtins（手绘框，标题左上角，避免 node() 居中标题压住网格）
    by=y+120; bw2=W-120
    b.append(box(60,by,bw2,74,fill=mix(AMBER,0.06),stroke=mix(AMBER,0.5),rx=11,shadow=True))
    b.append(f'<rect x="60" y="{by}" width="4.5" height="74" rx="2" fill="{AMBER}"/>')
    b.append(txt(78,by+22,"内置函数库（~25 · 逐字对齐两引擎）",13,INK,"700"))
    fns=["floor","ceil","round","abs","modulo","sqrt","min","max","sum","avg","upperCase","lowerCase","substring","contains","startsWith","endsWith","concat","string","number","trim","len","sort","append","not","coalesce"]
    per=13; fx=78; fy=by+46
    for i,fn in enumerate(fns):
        col=i%per; rr=i//per; xx=fx+col*66; ry=fy+rr*20
        b.append(f'<text x="{xx}" y="{ry}" font-family="{MONO}" font-size="10.3" fill="{mix(AMBER,0.85)}">{esc(fn)}</text>')
    # constraint note
    ny=by+94
    b.append(node(60,ny,bw2,52,"区域推理（Constraint / NumRange）",["parse_constraint 把单元格解析为区间/集合/通配 → 供决策表 gap/overlap 做区域相交（非逐点求值）"],GREEN,tsize=12.5))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 6. 决策图 JDM 求值 ═══════════════════════════════
def d_graph():
    W,H=980,560; b=[caption(28,40,"决策图 · JDM（JSON Decision Model）拓扑编排","数据自 Input 左→右流至 Output；Kahn 拓扑排序，逐节点累积上下文合并")]
    # node types legend
    types=[("input","输入",SLATE),("decisionTable","决策表",GREEN),("expression","表达式映射",BLUE),("script","脚本",AMBER),("decision","子决策",PURPLE),("output","输出",TEAL)]
    lx=70
    b.append(txt(70,78,"6 类节点：",11.5,FAINT,"600"))
    for i,(k,zh,c) in enumerate(types):
        xx=150+i*135
        b.append(f'<rect x="{xx}" y="66" width="12" height="12" rx="3" fill="{mix(c,0.5)}" stroke="{c}"/>')
        b.append(txt(xx+18,76,f'{zh}',10.8,INK,"500"))
    # DAG
    y0=120
    IN=(80,240); T=(280,150); E=(280,330); S=(520,150); D=(520,330); OUT=(760,240)
    def gnode(cx,cy,w,h,title,sub,c):
        return node(cx,cy,w,h,title,[sub] if sub else None,c,tsize=13)
    nb=[]
    nb.append(gnode(IN[0],IN[1],150,64,"Input","输入事实 facts",SLATE))
    nb.append(gnode(T[0],T[1],190,64,"决策表 · 资格","score→level",GREEN))
    nb.append(gnode(E[0],E[1],190,64,"表达式 · 额度","income*rate→limit",BLUE))
    nb.append(gnode(S[0],S[1],190,64,"脚本 · 阶梯税","Rhai 累进计算",AMBER))
    nb.append(gnode(D[0],D[1],190,64,"子决策 · 风控","按组织路由",PURPLE))
    nb.append(gnode(OUT[0],OUT[1],150,64,"Output","决策输出",TEAL))
    # edges
    def ec(a,aw,ah,bx,by_,c): return curve(a[0]+aw,a[1]+ah/2, bx, by_, c, 1.9, marker=_mk(c))
    b.append(curve(IN[0]+150,IN[1]+32,T[0],T[1]+32,SLATE,1.9,marker="arr"))
    b.append(curve(IN[0]+150,IN[1]+32,E[0],E[1]+32,SLATE,1.9,marker="arr"))
    b.append(curve(T[0]+190,T[1]+32,S[0],S[1]+32,GREEN,1.9,marker="arrg"))
    b.append(curve(E[0]+190,E[1]+32,D[0],D[1]+32,BLUE,1.9,marker="arrb"))
    b.append(curve(S[0]+190,S[1]+32,OUT[0],OUT[1]+20,AMBER,1.9,marker="arra"))
    b.append(curve(D[0]+190,D[1]+32,OUT[0],OUT[1]+44,PURPLE,1.9,marker="arrp"))
    b+=nb
    # topo strip
    ty=430
    b.append(node(70,ty,W-140,54,"Kahn 拓扑求值",["拓扑序逐节点：读累积上下文 → 求值 → 输出 merge 回上下文 → 传递后继；成环在求值期报错并落 trace"],PURPLE,tsize=13))
    b.append(node(70,ty+70,W-140,44,"子决策路由（SubflowRouter 式）",["decision 节点按主决策维度（org/字典）BFS 预载解析器 → 递归求值，深度上限防失控"],SLATE,tsize=12.5))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 7. 脚本四载体 ═══════════════════════════════
def d_script():
    W,H=980,560; b=[caption(28,40,"脚本能力 · Rhai 过程式逃生舱（SC0–SC4）","唯一接缝 eval_scripted 分派；判定侧永远 FEEL，脚本仅在输出/计算侧")]
    # center sandbox
    cx,cy,cw,ch=W/2-175,250,350,190
    b.append(box(cx,cy,cw,ch,fill=mix(PURPLE,0.07),stroke=mix(PURPLE,0.5),rx=14,shadow=True))
    b.append(txt(cx+cw/2,cy+30,"Rhai 沙箱内核（script.rs）",15,PURPLE,"800","middle"))
    b.append(txt(cx+cw/2,cy+50,"eval_scripted(lang, src, ctx)",11,mix(PURPLE,0.8),"600","middle",family=MONO))
    gates=[("max_operations = 100,000","操作数闸门·防死循环"),("max_call_levels = 32","递归深度·防爆栈"),("string/array/map ≤ 上限","内存爆炸防护"),("Don't-Panic + f64 归一","永不 panic·数值对齐 FEEL")]
    for i,(g,d) in enumerate(gates):
        yy=cy+74+i*28
        b.append(f'<rect x="{cx+16}" y="{yy-13}" width="10" height="10" rx="2" fill="{PURPLE}"/>')
        b.append(f'<text x="{cx+34}" y="{yy-4}" font-family="{MONO}" font-size="10.5" fill="{INK}" font-weight="600">{esc(g)}</text>')
        b.append(txt(cx+34,yy+10,d,9.8,MUT))
    # four carriers around top
    carriers=[("SC1 · 决策图 Script 节点","graph.rs \"script\" 分支·累积上下文→对象 merge",AMBER,70,96),
              ("SC2 · 决策表脚本单元格","=rhai: 前缀·输出格走脚本，判定侧仍 FEEL",GREEN,520,96),
              ("SC4 · 脚本决策","kind:\"script\"·整决策一段脚本，可被图引用",BLUE,70,168),
              ("SC3 · 脚本函数库","cmx_rule_script_function·发布后三载体可调",TEAL,520,168)]
    for t,d,c,x,y in carriers:
        b.append(node(x,y,390,58,t,[d],c,tsize=13))
    # arrows into sandbox
    b.append(curve(70+390,96+29,cx+40,cy+10,AMBER,1.7,marker="arra"))
    b.append(curve(520,96+29,cx+cw-40,cy+10,GREEN,1.7,marker="arrg"))
    b.append(curve(70+390,168+29,cx,cy+70,BLUE,1.7,marker="arrb"))
    b.append(curve(520,168+29,cx+cw,cy+70,TEAL,1.7,marker="arrt"))
    # bottom note
    b.append(node(70,470,W-140,54,"共用求值内核 · 零主流程改动",["四载体全在既有 match 分派点加分支；serde 桥接 Value↔Dynamic；错误带行号级失败归因，完整纳入 trace"],PURPLE,tsize=13))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 8. gap/overlap 完整性分析 ═══════════════════════════════
def d_gap():
    W,H=980,500; b=[caption(28,40,"完整性分析 · gap（空隙）/ overlap（重叠）","超越 ZEN 的世界级能力：区域推理，非逐点穷举——ZEN/多数引擎缺此")]
    # number line
    lx,rx=110,860; ly=214
    b.append(txt(70,96,"决策表某输入列 score 的规则区间（判定侧 FEEL）：",12,MUT,"600"))
    b.append(line(lx,ly,rx,ly,SLATE,2))
    ticks=[(0,"0"),(600,"600"),(700,"700"),(1000,"1000")]
    def px(v): return lx+(v/1000)*(rx-lx)
    for v,lab in ticks:
        b.append(line(px(v),ly-6,px(v),ly+6,SLATE,1.6))
        b.append(txt(px(v),ly+22,lab,10.5,FAINT,"500","middle"))
    # rule segments
    segs=[("规则1 [700..1000]",700,1000,GREEN,ly-52),("规则2 [600..700)",600,700,BLUE,ly-52),("规则3 [650..800]",650,800,PURPLE,ly-84)]
    for lab,a,c2,col,yy in segs:
        b.append(box(px(a),yy,px(c2)-px(a),20,fill=mix(col,0.2),stroke=mix(col,0.5),rx=6))
        b.append(txt((px(a)+px(c2))/2,yy+14,lab,9.5,mix(col,0.85),"600","middle"))
    # gap region [0..600)
    b.append(box(px(0),ly-52,px(600)-px(0),72,fill=mix(RED,0.08),stroke=mix(RED,0.5),rx=6,dash="5 3"))
    b.append(txt((px(0)+px(600))/2,ly-64,"GAP 空隙 [0..600)",11,RED,"700","middle"))
    b.append(txt((px(0)+px(600))/2,ly-24,"未被任何规则覆盖",9.5,RED,"500","middle"))
    # overlap region 700..800 between r1 & r3
    b.append(box(px(700),ly-92,px(800)-px(700),8,fill=AMBER,rx=3))
    b.append(txt(px(750),ly-100,"OVERLAP 重叠",10,AMBER,"700","middle"))
    # two methods
    my=ly+80
    b.append(node(70,my,420,120,"overlap · 区域相交推理",
        ["Constraint::intersects 对每对规则逐列判相交","含 not()/!= 的列判「未知」→ 不误报","U/A/P 等单命中策略下重叠即潜在冲突"],AMBER,tsize=13.5))
    b.append(node(510,my,400,120,"gap · 分段笛卡尔积 + 真实求值",
        ["每列按边界切分 → 取代表点","笛卡尔积（里程表编码）遍历组合","逐组合过真实 any_rule_matches 查覆盖"],RED,tsize=13.5))
    b.append(txt(70,my+142,"注：脚本决策为黑盒，analyze 显式返回「不参与完整性分析」（非静默假 complete）——诚实披露。",11,MUT,"500"))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 9. 求值主流程 + trace ═══════════════════════════════
def d_eval():
    W,H=980,600; b=[caption(28,40,"求值主流程 · 无状态决策 + 可解释 trace","每次 evaluate 产逐节点 trace（含失败归因）并落审计日志——超越 ZEN 的失败可解释性")]
    steps=[("POST /evaluate 或 /decisions/{key}/evaluate","客户端提交 input 事实（或内联 definition 试算）",BLUE),
           ("按 key 装载激活版本 / 或用内联定义","cmx_rule_release active 版本；内联走 validate",SLATE),
           ("build_resolver（BFS 预载子决策）","决策图含 decision 节点时递归预取被引用决策",PURPLE),
           ("with_functions（注入已发布脚本库）","load_published_functions → thread_local RAII",TEAL),
           ("evaluate_with · 分派求值","决策表 row_matches / 图 Kahn / 脚本 Rhai",GREEN),
           ("组装响应 + append_log 落审计","{output, trace[], timingUs, failure}",AMBER)]
    x=70; y=84; w=W-140; hh=52
    for i,(t,d,c) in enumerate(steps):
        yy=y+i*(hh+22)
        b.append(node(x,yy,w-320,hh,t,[d],c,tsize=13))
        if i<len(steps)-1: b.append(arrow(x+(w-320)/2,yy+hh,x+(w-320)/2,yy+hh+22,c,1.9,marker=_mk(c)))
    # trace panel on right
    tx=x+w-300; ty=84; th=len(steps)*(hh+22)-22
    b.append(box(tx,ty,300,th,fill=mix(INK,0.03),stroke=mix(INK,0.25),rx=12,shadow=True))
    b.append(txt(tx+16,ty+26,"TraceNode（逐节点归因）",13,INK,"700"))
    fields=[("nodeId / nodeKind","节点标识与类型"),("matchedRules[]","命中的规则行号"),("output","该节点输出快照"),("timingUs","微秒级时延"),("failure?","失败原因（带行号）")]
    for i,(f,d) in enumerate(fields):
        yy=ty+52+i*40
        b.append(f'<rect x="{tx+16}" y="{yy-16}" width="268" height="34" rx="7" fill="{BG}" stroke="{LINE}"/>')
        b.append(f'<text x="{tx+26}" y="{yy}" font-family="{MONO}" font-size="11" fill="{BLUE}" font-weight="700">{esc(f)}</text>')
        b.append(txt(tx+26,yy+13,d,9.5,MUT))
    b.append(txt(tx+16,ty+th-12,"logs / simulator 页据此下钻可解释性",9.8,FAINT,"500"))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 10. 多租户 ═══════════════════════════════
def d_tenancy():
    W,H=940,440; b=[caption(28,40,"多租户 · db-per-tenant 物理隔离（R3）","single 单库零回归；multi 派生 rule_<tenant> 库，懒备库")]
    b.append(node(60,110,250,74,"请求 + 租户身份",["JWT claim / X-Tenant 头","current_tenant()"],BLUE,tsize=13.5))
    b.append(node(370,110,220,74,"tenancy.rs 派生",["single→RULE_DB_ID","multi→rule_<tenant>（小写）"],PURPLE,tsize=13.5))
    b.append(arrow(310,147,370,147,BLUE,1.9,marker="arrb"))
    # DBs
    dbs=[("rule_pg（single 默认）",SLATE),("rule_acme",GREEN),("rule_globex",TEAL)]
    for i,(nm,c) in enumerate(dbs):
        yy=96+i*80; x=660
        b.append(f'<path d="M{x},{yy} h180 v46 a90,10 0 0 1 -180,0 v-46 a90,10 0 0 1 180,0" fill="{mix(c,0.08)}" stroke="{mix(c,0.5)}" stroke-width="1.3"/>')
        b.append(f'<ellipse cx="{x+90}" cy="{yy}" rx="90" ry="10" fill="{mix(c,0.14)}" stroke="{mix(c,0.5)}"/>')
        b.append(txt(x+90,yy+30,nm,11.5,mix(c,0.85),"700","middle",family=MONO))
        b.append(arrow(590,147,x-6,yy+22,c,1.6,marker=_mk(c)))
    b.append(node(60,352,W-120,54,"隔离与备库",["按租户选 db_id + 懒建库建表（ensure_current_ready）；引擎无长驻运行态，比流程 S2 更简单——只需选库 + 懒备"],SLATE,tsize=13))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 11. 存储 5 表 ═══════════════════════════════
def d_storage():
    W,H=940,430; b=[caption(28,40,"存储层 · 5 张表（无 RU / 工作内存）","PgDecisionStore 实现 DecisionStore trait；决策集草稿↔发布↔日志↔用例↔脚本库")]
    tbls=[("cmx_rule_definition","决策集草稿（key PK · body JSONB · published 标记）",BLUE,70,96),
          ("cmx_rule_release","不可变发布版本（key+version · active 激活位）",GREEN,510,96),
          ("cmx_rule_decision_log","决策审计日志（input/output/trace/timing/failure）",PURPLE,70,200),
          ("cmx_rule_test_case","测试用例（决策集绑定 · 期望输出 · 覆盖率）",TEAL,510,200),
          ("cmx_rule_script_function","脚本函数库（name PK · params · body · published）",AMBER,290,304)]
    for nm,d,c,x,y in tbls:
        b.append(node(x,y,360,72,nm,[d],c,tsize=13))
    # key relations
    b.append(curve(430,132,510,132,SLATE,1.5,marker="arr",dash="4 3"))
    b.append(txt(470,124,"publish",9.5,FAINT,"600","middle"))
    b.append(arrow(250,168,250,200,SLATE,1.5,dash="4 3",marker="arr"))
    b.append(txt(300,190,"key",9.5,FAINT,"600","middle"))
    b.append(txt(70,400,"决策集稳定 key 贯穿五表；发布产不可变 release，求值装载 active 版本，每次求值落 log。",11,MUT,"500"))
    return svg(W,H,"".join(b),grid=True)

# ═══════════════════════════════ 12. 前端工作台 ═══════════════════════════════
def d_frontend():
    W,H=980,540; b=[caption(28,40,"前端 · 门户 native 四区工作台（3 列表台 + 3 设计器）","explorer 决策集 / content 编辑 / property 属性；shadow DOM 自包含 ES 模块，双主题")]
    # three-region schematic
    rx,ry=70,96; rw=W-140; rh=150
    b.append(box(rx,ry,rw,rh,fill=PANEL,stroke=LINE,rx=12))
    ex=rx+14
    b.append(box(ex,ry+14,220,rh-28,fill=BG,stroke=mix(BLUE,0.4),rx=9))
    b.append(txt(ex+16,ry+38,"explorer",12.5,BLUE,"700")); b.append(txt(ex+16,ry+56,"决策集列表",10.5,MUT))
    b.append(txt(ex+16,ry+80,"查找 / 分页 / 刷新",10,FAINT))
    cxx=ex+236
    b.append(box(cxx,ry+14,rw-560,rh-28,fill=BG,stroke=mix(GREEN,0.4),rx=9))
    b.append(txt(cxx+16,ry+38,"content",12.5,GREEN,"700")); b.append(txt(cxx+16,ry+56,"网格/画布/表单编辑",10.5,MUT))
    px=cxx+(rw-560)+10
    b.append(box(px,ry+14,270,rh-28,fill=BG,stroke=mix(PURPLE,0.4),rx=9))
    b.append(txt(px+16,ry+38,"property",12.5,PURPLE,"700")); b.append(txt(px+16,ry+56,"属性 / 分析 / trace",10.5,MUT))
    # six pages
    pages=[("design-workbench","决策设计工作台·总入口",BLUE),("designer","决策表设计器·网格+fx向导",GREEN),
           ("graph-designer","决策图设计器·SVG DAG 编辑",PURPLE),("sim-workbench","决策应用工作台·求值",TEAL),
           ("simulator","决策仿真台·用例集+覆盖率",AMBER),("logs","决策审计中心·trace 下钻",RED)]
    py=ry+rh+34; bw=284; gap=14
    for i,(nm,d,c) in enumerate(pages):
        col=i%3; row=i//3; x=70+col*(bw+gap); y=py+row*80
        b.append(node(x,y,bw,66,nm,[d],c,tsize=12.5))
    b.append(txt(70,H-24,"多实例 openWorkNode 开成 Tab；native 页经 /api/native-pages 供给，门户 F3 反代与独立 :8094 同源。",11,MUT,"500"))
    return svg(W,H,"".join(b),grid=True)

DIAGRAMS={
    "arch":d_arch,"metakind":d_metakind,"table":d_table,"policies":d_policies,
    "feel":d_feel,"graph":d_graph,"script":d_script,"gap":d_gap,
    "eval":d_eval,"tenancy":d_tenancy,"storage":d_storage,"frontend":d_frontend,
}

def main():
    here=os.path.dirname(os.path.abspath(__file__))
    os.makedirs(here,exist_ok=True)
    b64map={}
    for name,fn in DIAGRAMS.items():
        s=fn()
        with open(os.path.join(here,f"{name}.svg"),"w",encoding="utf-8") as f: f.write(s)
        enc=base64.b64encode(s.encode("utf-8")).decode("ascii")
        b64map[name]=f"data:image/svg+xml;base64,{enc}"
        print(f"  {name:10s} {len(s):6d} B svg  {len(enc):6d} B base64")
    with open(os.path.join(here,"_diagrams.json"),"w",encoding="utf-8") as f:
        json.dump(b64map,f,ensure_ascii=False)
    print(f"共 {len(b64map)} 图 → _diagrams.json")

if __name__=="__main__": main()
