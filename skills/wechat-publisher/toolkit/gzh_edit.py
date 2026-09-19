#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文体改写引擎：把「报告体」正文改造成「公众号体」（数据驱动）。

核心设计：编辑判断抽成 JSON「编辑计划」，引擎只负责套用。
智能体每次只需产出计划，不必改代码。

编辑计划（plan.json）结构：
{
  "series": "商业智能体的「载体」之争",
  "parts": [
    {
      "n": 1,
      "title":  "商业智能体的「载体」之争①：窗口正在溶解",   // 公众号标题（<=64字）
      "digest": "摘要（<=120字）",
      "cover":  "aces_cover1.png",                        // 封面图文件名或路径
      "hook":   ["开篇第一段", "第二段"],                  // 冲突式开场，支持 <b>
      "points": ["本文看点 ①", "②", "③"],
      "titles": [["原标题关键词", "新观点式标题"], ...],     // 标题改写表
      "summary":["本篇小结 ①", "②", "③"],
      "next":   "下一篇：……（系列钩子）",
      "tables": {"%WIDE_TABLE_01%": "tables/wide_p1_wide_table_01.png"}
    }
  ]
}

改造项（只动结构与表达，事实/数据/结论/来源一个字不改）：
  1. 开篇钩子     报告式页眉 -> 冲突式开场
  2. 本文看点     降低「这值不值得读」的犹豫
  3. 观点式标题   编号小标题改写 + 篇内顺序编号
  4. 长段拆短     >140 字的 <p> 按句号拆到 <=100 字（只在标签深度 0 处切）
  5. 篇末三件套   本篇小结 + 下篇预告 + 引导语
  6. 表格提示     表 >=3 张时标注「可横屏查看」
"""
import json
import os
import re

CIRCLED = "①②③④⑤⑥⑦⑧⑨"

S_HOOK = 'margin:16px 0;font-size:17px;line-height:1.9;color:#1f2328'
S_CARD = ('margin:20px 0;padding:16px 18px;background:#f7f8fa;'
          'border:1px solid #e3e6ec;border-radius:8px')
S_CARD_T = 'margin:0 0 10px;font-size:15px;font-weight:700;color:#0d9488'
S_CARD_B = 'margin:7px 0;font-size:15px;line-height:1.85;color:#1f2328'
S_SUM = ('margin:34px 0 0;padding:18px 20px;background:#f0fdfa;'
         'border-left:4px solid #0d9488;border-radius:0 8px 8px 0')
S_NEXT = ('margin:20px 0;padding:16px 18px;background:#f7f8fa;'
          'border:1px solid #e3e6ec;border-radius:8px')
S_FOOT = 'margin:22px 0;text-align:center;font-size:14px;line-height:1.9;color:#8b939e'
S_SERIES = 'margin:0 0 20px;font-size:13px;letter-spacing:.1em;color:#0d9488;font-weight:700'

SENT_END = "。！？；"


def strip_tags(s):
    return re.sub(r"\s+", "", re.sub(r"<[^>]+>", "", s))


def visible_len(html):
    return len(strip_tags(html))


# ---------------------------------------------------------------- 长段拆分
def split_sentences_flat(html, maxlen=100):
    """按句号切分并重新装箱。**只在标签深度为 0 处切**，保证 <b> 不被截断。"""
    segs, buf, depth, i = [], [], 0, 0
    while i < len(html):
        ch = html[i]
        if ch == "<":
            j = html.find(">", i)
            if j == -1:
                j = len(html) - 1
            tag = html[i:j + 1]
            if tag.startswith("</"):
                depth = max(0, depth - 1)
            elif not tag.endswith("/>"):
                depth += 1
            buf.append(tag)
            i = j + 1
            continue
        buf.append(ch)
        if ch in SENT_END and depth == 0:
            segs.append("".join(buf))
            buf = []
        i += 1
    if buf:
        segs.append("".join(buf))
    if len(segs) <= 1:
        return None

    out, cur, curlen = [], [], 0
    for s in segs:
        sl = visible_len(s)
        if cur and curlen + sl > maxlen:
            out.append("".join(cur))
            cur, curlen = [], 0
        cur.append(s)
        curlen += sl
    if cur:
        out.append("".join(cur))
    return out if len(out) > 1 else None


def split_long_paragraphs(html, threshold=140, maxlen=100):
    pat = re.compile(r'<p style="([^"]*)">(.*?)</p>', re.S)
    n = [0]

    def repl(m):
        style, inner = m.group(1), m.group(2)
        if visible_len(inner) <= threshold:
            return m.group(0)
        pieces = split_sentences_flat(inner, maxlen)
        if not pieces:
            return m.group(0)
        n[0] += 1
        return "".join('<p style="%s">%s</p>' % (style, p) for p in pieces)

    return pat.sub(repl, html), n[0]


# ---------------------------------------------------------------- 标题
def apply_titles(html, mapping):
    """标题改观点式说法并编号。

    编号规则（避免父子同级错乱：曾出现「02 分角色建议 -> 03 如果你在造载体」）：
      · 该篇有多个 h2 -> 编号 h2，h3 作为子标题不编号
      · 该篇只有一个 h2 -> 那个 h2 是导语，编号 h3（真正的小节）
      · 该篇没有 h2    -> 编号 h3
    """
    number_tag = "h2" if len(re.findall(r"<h2\b", html)) > 1 else "h3"
    counter = [0]

    def repl(m):
        tag, style, inner = m.group(1), m.group(2), m.group(3)
        text = strip_tags(inner)
        new = None
        for key, val in (mapping or []):
            if key in text:
                new = val
                break
        if new is None:
            new = re.sub(r"^\d+(\.\d+)*[.、]?\s*", "", text)
        if tag == number_tag:
            counter[0] += 1
            new = "%02d ▍%s" % (counter[0], new)
        return '<%s style="%s">%s</%s>' % (tag, style, new, tag)

    return re.sub(r'<(h[234]) style="([^"]*)">(.*?)</\1>', repl, html, flags=re.S)


# ---------------------------------------------------------------- 模块
def hook_block(cfg, series, n, total, ntables):
    ps = "".join('<p style="%s">%s</p>' % (S_HOOK, t) for t in cfg.get("hook", []))
    pts = "".join('<div style="%s">%s %s</div>' % (S_CARD_B, CIRCLED[i], t)
                  for i, t in enumerate(cfg.get("points", [])))
    note = ""
    if ntables >= 3:
        note = ('<div style="margin:14px 0;text-align:center;font-size:13.5px;'
                'line-height:1.8;color:#8b939e">本篇含 %d 张数据表，'
                '手机上可横屏查看，不影响主线阅读</div>' % ntables)
    head = ""
    if series:
        head = '<div style="%s">%s · 系列第 %d / %d 篇</div>' % (
            S_SERIES, series, n, total)
    points = ""
    if pts:
        points = '<div style="%s"><div style="%s">本文看点</div>%s</div>' % (
            S_CARD, S_CARD_T, pts)
    return head + ps + points + note


def outro_block(cfg):
    items = "".join('<div style="%s">%s %s</div>' % (S_CARD_B, CIRCLED[i], t)
                    for i, t in enumerate(cfg.get("summary", [])))
    out = ""
    if items:
        out += '<div style="%s"><div style="%s">本篇小结</div>%s</div>' % (
            S_SUM, S_CARD_T, items)
    if cfg.get("next"):
        out += '<div style="%s"><div style="%s">下一篇</div>%s</div>' % (
            S_NEXT, S_CARD_T, cfg["next"])
    out += ('<div style="%s">如果这篇对你有用，点个「在看」，'
            '或转发给正在做 AI 产品的朋友。</div>' % S_FOOT)
    return out


# ---------------------------------------------------------------- 主流程
def apply_part(html, cfg, series, total):
    html = apply_titles(html, cfg.get("titles"))
    html, nlong = split_long_paragraphs(html)
    ntables = len(re.findall(r"<table\b", html)) + len(re.findall(r"%WIDE_TABLE_", html))
    html = hook_block(cfg, series, cfg.get("n", 1), total, ntables) + "\n" + html + "\n" + outro_block(cfg)
    return html, nlong


def run(plan_path, parts_dir, out_dir=None, verbose=True):
    """对 gzh_html.convert() 产出的 p*.html 套用编辑计划。

    plan.parts[i] 对应 p{i+1}.html；若计划里指定了 tables 映射，
    占位符在推草稿阶段才会换成微信 URL，这里只做记录。
    """
    with open(plan_path, encoding="utf-8") as f:
        plan = json.load(f)
    series = plan.get("series", "")
    cfgs = plan["parts"]
    out_dir = out_dir or parts_dir
    os.makedirs(out_dir, exist_ok=True)

    results = []
    for i, cfg in enumerate(cfgs):
        src = os.path.join(parts_dir, "p%d.html" % (i + 1))
        if not os.path.exists(src):
            raise RuntimeError("找不到正文：%s（计划里的篇数与转换结果不匹配？）" % src)
        with open(src, encoding="utf-8") as f:
            html = f.read()
        html, nlong = apply_part(html, cfg, series, len(cfgs))
        dst = os.path.join(out_dir, "w%d.html" % (i + 1))
        with open(dst, "w", encoding="utf-8") as f:
            f.write(html)
        results.append({"n": i + 1, "title": cfg.get("title", ""),
                        "path": dst, "visible": visible_len(html),
                        "html_chars": len(html), "long_split": nlong})
        if verbose:
            print("  w%d  %5d 字  HTML %6d 字符  拆长段 %d 处"
                  % (i + 1, results[-1]["visible"], len(html), nlong))
    return results


# ---------------------------------------------------------------- 预览
PREVIEW_TPL = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>预览 · %(title)s</title></head>
<body style="margin:0;background:#eef0f3;font-family:'Microsoft YaHei','PingFang SC',sans-serif">
<div style="max-width:420px;margin:0 auto;background:#fff;padding:22px 16px 60px;
     box-shadow:0 0 24px rgba(0,0,0,.08);min-height:100vh">%(body)s</div>
</body></html>"""

IMG_STYLE = "max-width:100%;height:auto;display:block;margin:16px auto"


def make_previews(parts_dir, out_dir, titles=None):
    paths = []
    files = sorted([f for f in os.listdir(parts_dir) if re.fullmatch(r"w\d+\.html", f)],
                   key=lambda s: int(re.findall(r"\d+", s)[0]))
    for fn in files:
        n = int(re.findall(r"\d+", fn)[0])
        with open(os.path.join(parts_dir, fn), encoding="utf-8") as f:
            body = f.read()
        # 预览里把宽表占位符换成本地图片，方便看版式
        for m in re.finditer(r"%WIDE_TABLE_(\d+)%", body):
            cand = os.path.join(out_dir, "tables", "wide_p%d_wide_table_%s.html" % (n, m.group(1)))
            if os.path.exists(cand):
                body = body.replace(m.group(0),
                                    '<img src="tables/wide_p%d_wide_table_%s_preview.png" style="%s">'
                                    % (n, m.group(1), IMG_STYLE))
        title = (titles or {}).get(n) or ("第 %d 篇" % n)
        dst = os.path.join(out_dir, "preview_w%d.html" % n)
        with open(dst, "w", encoding="utf-8") as f:
            f.write(PREVIEW_TPL % {"title": title, "body": body})
        paths.append(dst)
    return paths
