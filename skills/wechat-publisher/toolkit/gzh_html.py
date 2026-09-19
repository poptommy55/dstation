#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HTML 转换引擎：任意「报告体 / 深色主题」HTML -> 公众号可粘贴的浅色内联样式 HTML。

为什么必须转换（实测结论，不是推测）：
  1. 公众号编辑器会剥掉 <style> 块和所有 class，只保留内联 style 属性
  2. 深色主题直接粘贴到白底编辑器 = 一片黑糊
  3. grid / flex / ::before 伪元素公众号全不支持，必须打平成块级元素
  4. 语义标签 header/footer 会被剥掉（连样式一起丢），须打平为 div
  5. 站外 <a href> 会被剥成纯文字 -> 直接降级为 span，避免留下死链

用法：
    parts = convert("report.html", "out/", split_at=["3.4", "4."])
"""
import json
import os
import re
from html.parser import HTMLParser

VOID = {"br", "hr", "img", "meta", "link", "input", "source"}

# ---- 浅色主题色板（深色原文 -> 公众号白底）----
C = {
    "fg": "#1f2328", "fg2": "#57606a", "fg3": "#8b939e",
    "line": "#e3e6ec", "bg2": "#f7f8fa", "bg3": "#eef1f5",
    "acc": "#0d9488", "acc2": "#4f46e5",
    "warn": "#b45309", "dang": "#dc2626", "ok": "#16a34a",
}

S = {
    "p": 'margin:14px 0;font-size:16px;line-height:1.85;color:%s' % C["fg"],
    "h2": ('margin:36px 0 16px;padding-left:12px;border-left:4px solid %s;'
           'font-size:20px;font-weight:700;line-height:1.5;color:#111418' % C["acc"]),
    "h3": 'margin:28px 0 12px;font-size:17.5px;font-weight:700;line-height:1.5;color:#111418',
    "h4": 'margin:20px 0 8px;font-size:16px;font-weight:700;color:%s' % C["acc2"],
    "ul": 'margin:14px 0;padding-left:24px',
    "ol": 'margin:14px 0;padding-left:24px',
    "li": 'margin:7px 0;font-size:16px;line-height:1.8;color:%s' % C["fg"],
    "bq": ('margin:18px 0;padding:14px 18px;background:%s;border-left:3px solid %s;'
           'border-radius:0 6px 6px 0;font-size:15px;line-height:1.8;color:%s'
           % (C["bg2"], C["acc2"], C["fg2"])),
    "code": ('background:%s;border-radius:4px;padding:1px 5px;'
             'font-family:Consolas,Menlo,monospace;font-size:14px;color:%s'
             % (C["bg3"], C["acc"])),
    "pre": ('background:%s;border-radius:6px;padding:14px 16px;overflow-x:auto;'
            'font-family:Consolas,Menlo,monospace;font-size:13.5px;line-height:1.7;'
            'color:%s;white-space:pre-wrap;word-break:break-all' % (C["bg2"], C["fg"])),
    "link": 'color:%s' % C["acc2"],
    "hr": 'border:0;border-top:1px solid %s;margin:40px 0' % C["line"],
    "lead": ('margin:22px 0;padding:18px 20px;background:#f0fdfa;'
             'border-left:4px solid %s;border-radius:0 8px 8px 0' % C["acc"]),
    "box": ('margin:20px 0;padding:16px 18px;background:%s;border:1px solid %s;'
            'border-radius:8px' % (C["bg2"], C["line"])),
    "card": ('margin:12px 0;padding:14px 16px;background:%s;border:1px solid %s;'
             'border-radius:8px' % (C["bg2"], C["line"])),
    "sub": 'margin:10px 0;font-size:14.5px;line-height:1.75;color:%s' % C["fg2"],
    "src": 'font-size:12.5px;color:%s' % C["fg3"],
    "table": 'width:100%;border-collapse:collapse;margin:18px 0;font-size:13.5px;line-height:1.6',
    "th": ('border:1px solid %s;background:%s;color:%s;font-weight:700;'
           'padding:8px 10px;text-align:left;vertical-align:top'
           % (C["line"], C["bg3"], C["acc"])),
    "td": ('border:1px solid %s;padding:8px 10px;text-align:left;'
           'vertical-align:top;color:%s' % (C["line"], C["fg"])),
    "tag": ('display:inline-block;font-size:12px;padding:1px 7px;border-radius:4px;'
            'background:%s;border:1px solid %s;color:%s;margin:0 5px 4px 0'
            % (C["bg3"], C["line"], C["fg2"])),
    "kicker": 'font-size:13px;letter-spacing:.12em;color:%s;font-weight:700;margin:0 0 10px' % C["acc"],
    "numtag": 'font-size:12.5px;letter-spacing:.08em;color:%s;font-weight:700' % C["acc"],
    "tl": 'margin:22px 0 22px 4px;padding-left:20px;border-left:2px solid %s' % C["line"],
    "ev": 'margin:0 0 18px',
    "d": 'font-size:13px;color:%s;font-weight:700;margin-bottom:2px' % C["acc"],
    "x": 'font-size:15px;line-height:1.75;color:%s' % C["fg"],
    "foot": ('margin-top:40px;padding-top:20px;border-top:1px solid %s;'
             'font-size:13.5px;line-height:1.8;color:%s' % (C["line"], C["fg3"])),
    "strong": 'margin:6px 0;font-size:15.5px;font-weight:700;color:#111418',
}
TAG_C = {"g": C["ok"], "y": C["warn"], "r": C["dang"]}


# ---------------------------------------------------------------- DOM
class Node:
    __slots__ = ("tag", "attrs", "kids")

    def __init__(self, tag, attrs=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.kids = []

    def cls(self):
        return set(self.attrs.get("class", "").split())

    def text(self):
        return "".join(k if isinstance(k, str) else k.text() for k in self.kids)


class Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]
        self.skip = None

    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script"):
            self.skip = tag
            return
        if self.skip:
            return
        n = Node(tag, dict(attrs))
        self.stack[-1].kids.append(n)
        if tag not in VOID:
            self.stack.append(n)

    def handle_startendtag(self, tag, attrs):
        if not self.skip:
            self.stack[-1].kids.append(Node(tag, dict(attrs)))

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip:
                self.skip = None
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if self.skip or not data.strip():
            return
        # <pre> 的换行是内容的一部分，不能压平
        if self.stack[-1].tag == "pre":
            self.stack[-1].kids.append(data)
            return
        self.stack[-1].kids.append(re.sub(r"\s+", " ", data))


def find(node, pred, acc=None):
    acc = [] if acc is None else acc
    for k in node.kids:
        if isinstance(k, Node):
            if pred(k):
                acc.append(k)
            find(k, pred, acc)
    return acc


def find_one(node, pred):
    r = find(node, pred)
    return r[0] if r else None


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- 渲染
def _render(node, ctx):
    t = node.tag
    cls = node.cls()

    if t == "h1":
        return ""                      # 标题走公众号标题字段，正文里不重复
    if t in ("thead", "tbody"):
        return "".join(_render(k, ctx) for k in node.kids)
    if t in ("header", "footer"):      # 语义标签会被剥掉，打平为 div
        t = "div"

    if t == "table":
        cols = 0
        for tr in find(node, lambda n: n.tag == "tr"):
            cols = max(cols, sum(1 for k in tr.kids
                                 if isinstance(k, Node) and k.tag in ("td", "th")))
        body = _children(node, ctx)
        if cols >= ctx["wide_min_cols"]:
            idx = len(ctx["wide"]) + 1
            token = "%%WIDE_TABLE_%02d%%" % idx
            ctx["wide"].append({"token": token, "cols": cols, "html": body,
                                "part": ctx["part"]})
            return ('<p style="%s;text-align:center;font-size:14px;color:%s">'
                    '▼ 表格见下图 ▼</p>' % (S["p"], C["fg3"])) + token
        return '<table style="%s">%s</table>' % (S["table"], body)

    if t in ("td", "th"):
        st = S["td"] if t == "td" else S["th"]
        cs = node.attrs.get("colspan")
        cs = ' colspan="%s"' % cs if cs else ""
        return '<%s style="%s"%s>%s</%s>' % (t, st, cs, _children(node, ctx), t)

    style = _style_for(node, t, cls, ctx)

    if t == "a":
        # 公众号会剥掉站外链接，直接降级为带色文本，不留死链
        return '<span style="%s">%s</span>' % (S["link"], _children(node, ctx))
    if t == "hr":
        return '<hr style="%s">' % S["hr"]
    if t == "br":
        return "<br>"

    inner = _children(node, ctx)
    if not inner.strip():
        return ""
    if t == "span" and not style:
        return inner
    if style:
        return '<%s style="%s">%s</%s>' % (t, style, inner, t)
    return "<%s>%s</%s>" % (t, inner, t)


def _style_for(node, t, cls, ctx):
    par = ctx["parents"]
    if t == "p":
        # .lead 的外层 div 已刷高亮块样式，内层 p 不能再刷一遍（否则三重边框）
        if "lead" in par:
            return 'margin:9px 0;font-size:16px;line-height:1.85;color:%s' % C["fg"]
        if "box" in par and "t" in cls:
            return S["strong"]
        return S["p"]
    if t in ("h2", "h3", "h4", "ul", "ol", "blockquote", "code", "pre"):
        return S.get({"blockquote": "bq"}.get(t, t), "")
    if t == "li":
        return S["li"]
    if t == "footer":
        return S["foot"]
    if t == "div":
        if "lead" in cls:
            return S["lead"]
        if "kicker" in cls:
            return S["kicker"]
        if "sub" in cls:
            return S["sub"]
        if "src" in cls:
            return S["src"]
        if "box" in cls:
            s = S["box"]
            for k, col in (("warn", C["warn"]), ("dang", C["dang"]), ("ok", C["ok"])):
                if k in cls:
                    s += ";border-left:3px solid %s" % col
            return s
        if "card" in cls:
            return S["card"]
        if "h" in cls and "card" in par:
            return S["strong"]
        if "b" in cls and "card" in par:
            return 'font-size:14.5px;line-height:1.75;color:%s' % C["fg2"]
        if "n" in cls:
            return S["numtag"]
        if "t" in cls and "box" in par:
            return S["strong"]
        if "tl" in cls:
            return S["tl"]
        if "ev" in cls:
            return S["ev"]
        if "d" in cls:
            return S["d"]
        if "x" in cls:
            return S["x"]
        if "grid" in cls:
            return "margin:18px 0"
        if "meta" in cls:
            return "margin:14px 0 0"
        if "tw" in cls:
            return "margin:0"
        return ""
    if t == "span":
        if "chip" in cls or "tag" in cls:
            s = S["tag"]
            for k, col in TAG_C.items():
                if k in cls:
                    s += ";color:%s;border-color:%s" % (col, col)
            return s
        if "num" in cls:
            return 'color:%s;font-weight:700' % C["acc"]
        return ""
    return ""


def _children(node, ctx):
    sub = {"wide": ctx["wide"], "part": ctx["part"],
           "parents": ctx["parents"] | node.cls(),
           "wide_min_cols": ctx["wide_min_cols"]}
    out = []
    for k in node.kids:
        out.append(esc(k) if isinstance(k, str) else _render(k, sub))
    return "".join(out)


# ---------------------------------------------------------------- 对外
def strip_tags(s):
    return re.sub(r"\s+", "", re.sub(r"<[^>]+>", "", s))


def _norm(s):
    """归一化：去掉所有空白。

    标题文本经 strip_tags 后是不含空格的（「3. 价值在往哪里迁移」-> 「3.价值在往哪里迁移」），
    所以切篇关键词也必须归一化后再比，否则用户写「3. 价值在往哪里迁移」（带空格）会静默匹配不上。
    """
    return re.sub(r"\s+", "", s or "")


def visible_len(html):
    return len(strip_tags(html))


def sanitize_report(html):
    """体检：返回公众号会剥掉的东西清单。

    注意：宽表占位符（%WIDE_TABLE_xx%）是【设计如此】——它在 push 阶段才换成微信 URL，
    不在这里判定，否则每次 convert 都会误报。
    """
    checks = {
        "style/script 块": len(re.findall(r"<(style|script)\b", html)),
        "class 属性": len(re.findall(r"\bclass=", html)),
        "外部 a 链接": len(re.findall(r"<a\b", html)),
        "header/footer 标签": len(re.findall(r"</?(header|footer)\b", html)),
        "外链 js/css": len(re.findall(r'(?:src|href)="[^"]*\.(?:js|css)"', html)),
        "残留 %% 格式符": len(re.findall(r"%%", html)),
    }
    return {k: v for k, v in checks.items() if v}


def convert(src_path, out_dir, split_at=None, wide_min_cols=5, drop_header=False,
            verbose=True):
    """把源 HTML 转成若干篇公众号正文。

    split_at     字符串列表；正文遇到「标题包含其中任一个」时，从那里开始新的一篇
                 （比较时会归一化空白，所以写「3. 价值在往哪里迁移」或「3.价值在往哪里迁移」都行）
    drop_header  丢掉正文开始前的报告式页眉（kicker / 副标题 / 元信息 chips）。
                 报告页眉在公众号里是劝退的——「核验日期 / 信源 60+ 页面」抓不住读者，
                 开篇位置应该留给冲突式钩子。定位第一个 .lead 块或第一个 h2，之前的内容整体丢弃。
    """
    split_at = split_at or []
    with open(src_path, encoding="utf-8") as f:
        raw = f.read()
    if "<body" in raw:
        body = raw.split("<body", 1)[1].split(">", 1)[1].split("</body>", 1)[0]
    else:
        body = raw

    b = Builder()
    b.feed(body)
    root = find_one(b.root, lambda n: n.tag == "div" and "wrap" in n.cls()) or b.root

    groups = [[]]
    for k in root.kids:
        if isinstance(k, str):
            continue
        if k.tag == "hr":
            continue
        if k.tag in ("h2", "h3") and split_at:
            txt = strip_tags(k.text())
            if any(_norm(key) in txt for key in split_at) and groups[-1]:
                groups.append([])
        groups[-1].append(k)

    os.makedirs(out_dir, exist_ok=True)
    tdir = os.path.join(out_dir, "tables")
    os.makedirs(tdir, exist_ok=True)

    if drop_header and groups and groups[0]:
        idx = None
        for i, nd in enumerate(groups[0]):
            if nd.tag == "h2":
                idx = i
                break
            if nd.tag == "div" and "lead" in nd.cls():
                idx = i
                break
        if idx:
            if verbose:
                print("  丢弃报告式页眉：正文前 %d 个块" % idx)
            groups[0] = groups[0][idx:]

    parts, manifest = [], {"source": os.path.basename(src_path), "parts": []}
    for i, nodes in enumerate(groups, 1):
        ctx = {"wide": [], "part": i, "parents": set(), "wide_min_cols": wide_min_cols}
        html = "\n".join(_render(n, ctx) for n in nodes)
        html = re.sub(r"\n{3,}", "\n\n", html).strip()

        entry = {"part": i, "wide": [], "visible": visible_len(html)}
        for w in ctx["wide"]:
            fn = "wide_p%d_%s.html" % (i, w["token"].strip("%").lower())
            stage = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font-family:"Microsoft YaHei","PingFang SC",sans-serif}
.stage{display:inline-block;padding:24px 26px}
table{border-collapse:collapse;font-size:20px;line-height:1.55}
th,td{border:1px solid %s;padding:11px 14px;text-align:left;vertical-align:top;color:%s}
th{background:%s;color:%s;font-weight:700;white-space:nowrap}
tbody tr:nth-child(even){background:#fafbfc}
</style></head><body><div class="stage"><table><tbody>%s</tbody></table></div></body></html>""" \
                % (C["line"], C["fg"], C["bg3"], C["acc"], w["html"])
            with open(os.path.join(tdir, fn), "w", encoding="utf-8") as f:
                f.write(stage)
            entry["wide"].append({"token": w["token"], "cols": w["cols"],
                                  "file": os.path.join("tables", fn)})

        path = os.path.join(out_dir, "p%d.html" % i)
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
        entry["path"] = path
        entry["html"] = html
        parts.append(entry)
        if verbose:
            print("  第 %d 篇  可见 %5d 字  HTML %6d 字符  宽表 %d 个"
                  % (i, entry["visible"], len(html), len(entry["wide"])))

    manifest["parts"] = [{k: v for k, v in p.items() if k != "html"} for p in parts]
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return parts
