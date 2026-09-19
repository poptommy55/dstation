#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
公众号文章优化与发布 —— 统一命令行入口。

典型全流程：
    gzh.py doctor                                  环境体检（代理/Chrome/Pillow/ACES）
    gzh.py account add aikidslab --appid wx... --secret ...
    gzh.py account check                           凭证 + 权限自检
    gzh.py convert report.html --out out --split-at "3.4" "4."
    gzh.py edit --plan plan.json --parts out
    gzh.py tables --parts out                      宽表转图
    gzh.py cover --prompt "..." --ratio 16:9 --resolution 2k --prefix aces_c1
    gzh.py preview --parts out
    gzh.py push --plan plan.json --parts out       上传图片 + 建草稿
    gzh.py publish <media_id>                      提交发布（仅已认证服务号）

每条子命令都可单独跑，便于中断后续做。
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gzh_api as api        # noqa: E402
import gzh_edit as edit      # noqa: E402
import gzh_html as ghtml     # noqa: E402


# ---------------------------------------------------------------- doctor
def cmd_doctor(a):
    print("=" * 66)
    print("环境体检")
    print("=" * 66)
    print("配置目录      : %s" % api.CONF)
    print("账号文件      : %s%s" % (api.ACCOUNTS,
                                   "（已创建）" if os.path.exists(api.ACCOUNTS) else "（未创建）"))

    # 代理
    px = os.environ.get("MP_PROXY", "").strip()
    print("出网方式      : %s" % ("走代理 " + px if px else "直连（已绕过系统代理）"))
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        if os.environ.get(k):
            print("              ⚠️ 系统变量 %s=%s 存在，本工具已绕过它" % (k, os.environ[k]))

    # 微信连通性
    try:
        r = api.api_get("/cgi-bin/token")
        ec = r.get("errcode")
        if ec == 41002:
            print("微信接口      : ✅ 可直连（41002 = 缺 appid，预期响应）")
        else:
            print("微信接口      : ⚠️ 返回 errcode=%s %s" % (ec, r.get("errmsg")))
    except Exception as e:
        print("微信接口      : ❌ %s" % e)

    # 依赖
    try:
        import PIL
        print("Pillow        : ✅ %s（宽表裁图/压缩需要）" % PIL.__version__)
    except Exception:
        print("Pillow        : ❌ 未安装（宽表转图会失败）")

    try:
        import gzh_media
        ch = gzh_media.find_chrome()
        print("Chrome/Edge   : %s" % ("✅ " + ch if ch else "❌ 未找到（宽表转图会失败）"))
    except Exception as e:
        print("Chrome/Edge   : ❌ %s" % e)

    # ACES
    try:
        import gzh_media
        ac, cli = gzh_media.aces_client()
        print("ACES KEY      : %s" % ("✅ 已配置" if cli.has_key() else "❌ 未配置"))
    except Exception as e:
        print("ACES KEY      : ⚠️ %s" % e)
    return 0


# ---------------------------------------------------------------- account
def cmd_account(a):
    sub = a.action
    if sub == "add":
        if not (a.appid and a.secret):
            print("需要 --appid 与 --secret")
            return 1
        api.add_account(a.name, a.appid, a.secret, a.label or a.name)
        print("已添加账号：%s" % a.name)
        print("账号文件：%s" % api.ACCOUNTS)
        return 0
    if sub == "list":
        d = api.load_accounts()
        if not d.get("accounts"):
            print("还没有账号。用 account add 添加。")
            return 0
        print("当前生效：%s" % d.get("active"))
        for k, v in d["accounts"].items():
            mark = "←" if k == d.get("active") else " "
            print("  %s %-14s %s  %s" % (mark, k, api.mask(v["appid"]), v.get("label", "")))
        return 0
    if sub == "use":
        api.set_active(a.name)
        print("已切换到：%s" % a.name)
        return 0
    if sub in ("check", "perm"):
        n, appid, _ = api.cred(a.name)
        print("账号：%s  AppID：%s" % (n, api.mask(appid)))
        r = api.probe_token(a.name)
        print("access_token：✅ 获取成功（%s）" % r["token"])
        print("-" * 46)
        rows = api.probe_permissions(a.name)
        for row in rows:
            print("  %-10s %s  %s" % (row["label"], "✅" if row["ok"] else "❌", row["detail"]))
        print("-" * 46)
        perm = {r["label"]: r["ok"] for r in rows}
        if perm.get("发布接口"):
            print("=> 这个号【可以直接发布】，无需手动点。")
        elif perm.get("草稿箱"):
            print("=> 只能推草稿，最后一步发布要人工点一下。")
        else:
            print("=> 无可用业务接口，账号多半没做「微信认证」。")
        return 0
    print("未知动作：%s" % sub)
    return 1


# ---------------------------------------------------------------- convert
def cmd_convert(a):
    print("转换：%s" % a.src)
    parts = ghtml.convert(a.src, a.out, split_at=a.split_at,
                          wide_min_cols=a.wide_min_cols, drop_header=a.drop_header)
    print("\n共 %d 篇 -> %s" % (len(parts), a.out))
    for p in parts:
        bad = ghtml.sanitize_report(p["html"])
        if bad:
            print("  ⚠️ 第 %d 篇仍有公众号会剥掉的东西：%s" % (p["part"], bad))
    if not any(ghtml.sanitize_report(p["html"]) for p in parts):
        print("  ✅ 净化体检通过（无 style/class/外链/语义标签残留）")
    return 0


# ---------------------------------------------------------------- edit
def cmd_edit(a):
    print("套用编辑计划：%s" % a.plan)
    res = edit.run(a.plan, a.parts, out_dir=a.out or a.parts)
    print("\n共 %d 篇" % len(res))
    return 0


# ---------------------------------------------------------------- tables
def cmd_tables(a):
    import gzh_media
    tdir = os.path.join(a.parts, "tables")
    if not os.path.isdir(tdir):
        print("没有宽表目录：%s（源文档里没有 >=5 列的宽表？）" % tdir)
        return 0
    print("渲染宽表 -> %s" % a.out)
    out = gzh_media.render_tables(tdir, a.out or os.path.join(a.parts, "img"))
    print("\n完成 %d 张" % len(out))
    return 0


# ---------------------------------------------------------------- cover
def cmd_cover(a):
    import gzh_media
    out_dir = a.out or os.path.join(os.getcwd(), "aces-output")
    print("生成封面（ratio=%s resolution=%s）" % (a.ratio, a.resolution))
    files = gzh_media.make_cover(a.prompt, a.ratio, a.resolution, a.prefix, out_dir)
    print("\n落盘：")
    for f in files:
        print("  " + f)
    return 0


# ---------------------------------------------------------------- preview
def cmd_preview(a):
    titles = {}
    if a.plan and os.path.exists(a.plan):
        with open(a.plan, encoding="utf-8") as f:
            plan = json.load(f)
        for cfg in plan.get("parts", []):
            titles[cfg.get("n")] = cfg.get("title", "")
    paths = edit.make_previews(a.parts, a.out or a.parts, titles)
    print("预览已生成：")
    for p in paths:
        print("  " + p)
    return 0


# ---------------------------------------------------------------- push
def _resolve(path_like, bases):
    if not path_like:
        return None
    if os.path.isabs(path_like) and os.path.exists(path_like):
        return path_like
    for b in bases:
        cand = os.path.join(b, path_like)
        if os.path.exists(cand):
            return cand
    return None


def cmd_push(a):
    with open(a.plan, encoding="utf-8") as f:
        plan = json.load(f)
    bases = [a.parts, os.path.join(a.parts, "img"), os.path.join(a.parts, "tables"),
             os.getcwd(), os.path.join(os.getcwd(), "aces-output")]
    if a.assets:
        bases.insert(0, a.assets)

    n, appid, _ = api.cred(a.account)
    print("推送账号：%s  AppID：%s" % (n, api.mask(appid)))
    print("=" * 66)

    report = []
    for i, cfg in enumerate(plan["parts"], 1):
        title = cfg.get("title") or ("第 %d 篇" % i)
        print("第 %d 篇：%s" % (i, title))
        src = os.path.join(a.parts, "w%d.html" % i)
        if not os.path.exists(src):
            print("  ❌ 找不到 %s（先跑 edit）" % src)
            report.append({"n": i, "status": "NO_HTML"})
            continue
        with open(src, encoding="utf-8") as f:
            html = f.read()

        # 宽表占位符 -> 微信正文图
        missing = []
        for token, img in (cfg.get("tables") or {}).items():
            p = _resolve(img, bases)
            if not p:
                print("  ⚠️ 找不到宽表图片：%s" % img)
                missing.append(img)
                continue
            url = api.upload_content_image(p, a.account)
            print("  正文图 %s -> %s" % (os.path.basename(p), url[:64] + "..."))
            html = html.replace(token, '<img src="%s" style="max-width:100%%;'
                                       'height:auto;display:block;margin:16px auto">' % url)

        # 占位符没换掉 = 读者会看到一串乱码。这必须算失败，不能静默放过。
        if "WIDE_TABLE" in html:
            left = re.findall(r"%WIDE_TABLE_\d+%", html)
            print("  ❌ 仍有未替换的占位符 %s —— 推上去读者看到的是乱码，已中止本篇"
                  % "、".join(sorted(set(left))))
            if missing:
                print("     找不到这些图片：%s" % "、".join(missing))
                print("     用 --assets 指定图片所在目录，或把图片放进 <parts>/img/")
            report.append({"n": i, "title": title, "status": "PLACEHOLDER",
                           "left": sorted(set(left))})
            print("-" * 66)
            continue

        cover = _resolve(cfg.get("cover"), bases)
        if not cover:
            print("  ❌ 找不到封面：%s（草稿必须要有封面）" % cfg.get("cover"))
            report.append({"n": i, "status": "NO_COVER"})
            continue
        thumb = api.upload_thumb(cover, a.account)
        print("  封面 %s -> %s" % (os.path.basename(cover), thumb[:36] + "..."))

        if a.dry_run:
            print("  [dry-run] 跳过建草稿（可见 %d 字 / HTML %d 字符）"
                  % (edit.visible_len(html), len(html)))
            report.append({"n": i, "title": title, "status": "DRY",
                           "visible": edit.visible_len(html)})
            print("-" * 66)
            continue

        mid = api.add_draft(title, html, thumb,
                            digest=cfg.get("digest", ""),
                            author=cfg.get("author", ""),
                            source_url=cfg.get("source_url", ""),
                            open_comment=cfg.get("open_comment", 1),
                            name=a.account)
        print("  ✅ 草稿已创建 media_id = %s" % mid)
        report.append({"n": i, "title": title, "media_id": mid, "status": "OK",
                       "visible": edit.visible_len(html)})
        print("-" * 66)

    ok = sum(1 for r in report if r["status"] in ("OK", "DRY"))
    print("成功 %d / %d" % (ok, len(report)))
    if a.report:
        with open(a.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("报告：%s" % a.report)
    return 0 if ok == len(report) else 1


# ---------------------------------------------------------------- 其他
def cmd_drafts(a):
    rows, total = api.list_drafts(a.account)
    print("草稿共 %s 篇（显示 %d）" % (total, len(rows)))
    for r in rows:
        print("  %s | %s" % (r["media_id"], r["title"]))
    return 0


def cmd_clean(a):
    rows, _ = api.list_drafts(a.account, count=50)
    hit = [r for r in rows if (a.prefix and r["title"].startswith(a.prefix))
           or (a.exact and r["title"] in a.exact)]
    if not hit:
        print("没有匹配的草稿")
        return 0
    for r in hit:
        if a.dry_run:
            print("  [dry-run] 将删除：%s" % r["title"])
        else:
            api.delete_draft(r["media_id"], a.account)
            print("  已删除：%s" % r["title"])
    return 0


def cmd_publish(a):
    pid = api.publish(a.media_id, a.account)
    print("已提交发布 ✅ publish_id = %s" % pid)
    print("（发布是异步的，用 gzh.py status <publish_id> 查结果）")
    return 0


def cmd_status(a):
    print(json.dumps(api.publish_status(a.publish_id, a.account),
                     ensure_ascii=False, indent=2))
    return 0


def cmd_materials(a):
    r = api.list_materials(a.account)
    print("永久图片素材共 %s 个" % r.get("total_count"))
    for it in r.get("item", []):
        print("  %s" % it.get("name"))
        print("      media_id: %s" % it.get("media_id"))
    return 0


# ---------------------------------------------------------------- CLI
def main():
    p = argparse.ArgumentParser(prog="gzh.py", description="公众号文章优化与发布工具链")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="环境体检").set_defaults(func=cmd_doctor)

    ap = sub.add_parser("account", help="账号管理")
    ap.add_argument("action", choices=["add", "list", "use", "check", "perm"])
    ap.add_argument("name", nargs="?", default=None)
    ap.add_argument("--appid")
    ap.add_argument("--secret")
    ap.add_argument("--label")
    ap.set_defaults(func=cmd_account)

    cp = sub.add_parser("convert", help="报告体 HTML -> 公众号内联样式（可切篇）")
    cp.add_argument("src")
    cp.add_argument("--out", required=True)
    cp.add_argument("--split-at", nargs="*", default=[],
                    help="切篇点：标题包含该字符串时从这里开始新的一篇")
    cp.add_argument("--wide-min-cols", type=int, default=5)
    cp.add_argument("--drop-header", action="store_true",
                    help="丢掉报告式页眉（kicker/副标题/元信息 chips），开篇位置留给钩子")
    cp.set_defaults(func=cmd_convert)

    ep = sub.add_parser("edit", help="套用编辑计划做文体改写")
    ep.add_argument("--plan", required=True)
    ep.add_argument("--parts", required=True)
    ep.add_argument("--out")
    ep.set_defaults(func=cmd_edit)

    tp = sub.add_parser("tables", help="宽表 -> 图片")
    tp.add_argument("--parts", required=True)
    tp.add_argument("--out")
    tp.set_defaults(func=cmd_tables)

    vp = sub.add_parser("cover", help="ACES 生成封面")
    vp.add_argument("--prompt", required=True)
    vp.add_argument("--ratio", required=True)
    vp.add_argument("--resolution", required=True)
    vp.add_argument("--prefix", required=True)
    vp.add_argument("--out")
    vp.set_defaults(func=cmd_cover)

    pp = sub.add_parser("preview", help="手机宽度预览")
    pp.add_argument("--parts", required=True)
    pp.add_argument("--out")
    pp.add_argument("--plan")
    pp.set_defaults(func=cmd_preview)

    up = sub.add_parser("push", help="上传图片 + 建草稿")
    up.add_argument("--plan", required=True)
    up.add_argument("--parts", required=True)
    up.add_argument("--assets", help="素材根目录（找封面图用）")
    up.add_argument("--account")
    up.add_argument("--dry-run", action="store_true")
    up.add_argument("--report")
    up.set_defaults(func=cmd_push)

    dp = sub.add_parser("drafts", help="列出草稿")
    dp.add_argument("--account")
    dp.set_defaults(func=cmd_drafts)

    cl = sub.add_parser("clean", help="删草稿")
    cl.add_argument("--prefix")
    cl.add_argument("--exact", nargs="*")
    cl.add_argument("--account")
    cl.add_argument("--dry-run", action="store_true")
    cl.set_defaults(func=cmd_clean)

    pb = sub.add_parser("publish", help="提交发布（仅已认证服务号）")
    pb.add_argument("media_id")
    pb.add_argument("--account")
    pb.set_defaults(func=cmd_publish)

    st = sub.add_parser("status", help="查发布状态")
    st.add_argument("publish_id")
    st.add_argument("--account")
    st.set_defaults(func=cmd_status)

    mp = sub.add_parser("materials", help="列出素材库图片")
    mp.add_argument("--account")
    mp.set_defaults(func=cmd_materials)

    a = p.parse_args()
    try:
        return a.func(a)
    except Exception as e:
        print("ERROR: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
