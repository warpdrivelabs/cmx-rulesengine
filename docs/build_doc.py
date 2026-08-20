#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 _方案模板.md 中的 ![alt](@@name@@) 占位替换为 <img src="data:image/svg+xml;base64,…"> 内嵌图，产出最终方案 md。"""
import html, json, os, re, sys

HERE=os.path.dirname(os.path.abspath(__file__))
TPL=os.path.join(HERE,"_方案模板.md")
OUT=os.path.join(HERE,"cmx-rulesengine-设计与功能方案.md")
B64=os.path.join(HERE,"assets","_diagrams.json")

def main():
    with open(B64,encoding="utf-8") as f: dmap=json.load(f)
    with open(TPL,encoding="utf-8") as f: md=f.read()
    missing=[]
    # ① 图片语法 ![alt](@@name@@) → <img src="dataURI" alt="alt">（居中、自适应）
    def img_repl(m):
        alt,name=m.group(1),m.group(2)
        if name not in dmap: missing.append(name); return m.group(0)
        return (f'<img src="{dmap[name]}" alt="{html.escape(alt,quote=True)}" '
                f'style="display:block;max-width:100%;margin:16px auto;">')
    md=re.sub(r"!\[([^\]]*)\]\(@@([a-zA-Z0-9_]+)@@\)",img_repl,md)
    # ② 兜底：其余裸 @@name@@（正文直接引用）→ dataURI
    md=re.sub(r"@@([a-zA-Z0-9_]+)@@",lambda m:dmap.get(m.group(1),m.group(0)) if m.group(1) in dmap else missing.append(m.group(1)) or m.group(0),md)
    left=re.findall(r"@@([a-zA-Z0-9_]+)@@",md)
    if missing: print("⚠ 缺图:",set(missing)); sys.exit(1)
    with open(OUT,"w",encoding="utf-8") as f: f.write(md)
    residual=len(re.findall(r"!\[[^\]]*\]\(data:",md))
    print(f"✅ 产出 {OUT}")
    print(f"   内嵌 {md.count('data:image/svg+xml;base64,')} 图（<img> 形式）；剩余占位 {len(left)}；残留 Markdown 图 {residual}")

if __name__=="__main__": main()

