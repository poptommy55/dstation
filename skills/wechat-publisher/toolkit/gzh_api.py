#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
公众号 API 客户端（多账号版）

设计要点：
  · 多账号：accounts.json 里存多个号，用 active 标记当前生效账号，不必反复改凭证文件
  · token 缓存按 appid 分桶 —— 换号不会串 token（这是实际踩过的坑）
  · 默认绕过系统代理：本机系统代理常年指向一个没跑的 127.0.0.1:7890，会让所有请求被拖死；
    微信接口国内可直连。确需走代理时设 MP_PROXY=http://host:port
  · 凭证与 token 一律不回显

配置目录解析顺序（GZH_HOME > $DSH_HOME/wechat-publisher > <cwd>/.gzh）
"""
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

API = "https://api.weixin.qq.com"
TIMEOUT = 30


# ---------------------------------------------------------------- 配置目录
def config_home():
    """返回可写的配置目录。"""
    env = os.environ.get("GZH_HOME", "").strip()
    if env:
        os.makedirs(env, exist_ok=True)
        return env
    dsh = os.environ.get("DSH_HOME", "").strip()
    if dsh:
        p = os.path.join(dsh, "wechat-publisher")
        try:
            os.makedirs(p, exist_ok=True)
            probe = os.path.join(p, ".wtest")
            with open(probe, "w") as f:
                f.write("1")
            os.remove(probe)
            return p
        except Exception:
            pass
    p = os.path.join(os.getcwd(), ".gzh")
    os.makedirs(p, exist_ok=True)
    return p


CONF = config_home()
ACCOUNTS = os.path.join(CONF, "accounts.json")
TOKENS = os.path.join(CONF, "tokens.json")


# ---------------------------------------------------------------- 网络
_PROXY = os.environ.get("MP_PROXY", "").strip()
if _PROXY:
    _OPENER = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": _PROXY, "https": _PROXY}))
else:
    _OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _req(url, data=None, ctype=None):
    req = urllib.request.Request(url, data=data)
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:400]))
    except urllib.error.URLError as e:
        raise RuntimeError("网络不可达（是否被代理拦了？设 MP_PROXY 或检查系统代理）：%s" % e)


def _qs(params):
    if not params:
        return ""
    return "?" + "&".join("%s=%s" % (k, urllib.parse.quote(str(v))) for k, v in params.items())


def api_get(path, **params):
    return _req(API + path + _qs(params))


def api_post_json(path, obj, **params):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return _req(API + path + _qs(params), body, "application/json; charset=utf-8")


def _multipart(files):
    b = "----gzh" + uuid.uuid4().hex
    out = []
    for k, (fn, blob, ct) in files.items():
        out.append(("--" + b).encode())
        out.append(('Content-Disposition: form-data; name="%s"; filename="%s"'
                    % (k, os.path.basename(fn))).encode("utf-8"))
        out.append(("Content-Type: %s" % ct).encode())
        out.append(b"")
        out.append(blob)
    out.append(("--" + b + "--").encode())
    out.append(b"")
    return b"\r\n".join(out), "multipart/form-data; boundary=" + b


def api_post_file(path, filepath, **params):
    if not os.path.exists(filepath):
        raise RuntimeError("文件不存在: " + filepath)
    ct = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
    with open(filepath, "rb") as f:
        blob = f.read()
    body, ctype = _multipart({"media": (filepath, blob, ct)})
    return _req(API + path + _qs(params), body, ctype)


HINTS = {
    40164: "调用方 IP 不在白名单！去「设置与开发 → 开发接口管理 → IP 白名单」"
           "把 errmsg 里那个 IP 加上（注意：不同公众号的白名单互相独立）。",
    40013: "AppID 无效。",
    40125: "AppSecret 无效（别把 AppID 当 Secret 填）。",
    48001: "该接口未授权。连素材库都被拒 → 账号没做「微信认证」；"
           "只有草稿箱被拒 → 账号类型不支持。发布接口需【已认证服务号】。",
    45009: "接口调用次数超限。",
    40007: "media_id 无效或已过期。",
    53500: "已被平台封禁。",
    53503: "该接口需要「已认证服务号」资质。",
}


def check_err(res, where):
    if not isinstance(res, dict):
        raise RuntimeError("%s: 返回异常 %r" % (where, res))
    ec = res.get("errcode", 0)
    if ec == 0:
        return res
    msg = res.get("errmsg", "")
    hint = HINTS.get(ec, "")
    raise RuntimeError("%s 失败 errcode=%s errmsg=%s%s"
                       % (where, ec, msg, ("\n>>> " + hint) if hint else ""))


# ---------------------------------------------------------------- 账号
def load_accounts():
    if not os.path.exists(ACCOUNTS):
        return {"active": "", "accounts": {}}
    with open(ACCOUNTS, encoding="utf-8") as f:
        return json.load(f)


def save_accounts(d):
    with open(ACCOUNTS, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def add_account(name, appid, appsecret, label=""):
    d = load_accounts()
    d["accounts"][name] = {"appid": appid.strip(), "appsecret": appsecret.strip(),
                           "label": label or name}
    if not d.get("active"):
        d["active"] = name
    save_accounts(d)
    return name


def set_active(name):
    d = load_accounts()
    if name not in d.get("accounts", {}):
        raise RuntimeError("没有这个账号：%s（现有：%s）"
                           % (name, ", ".join(d.get("accounts", {})) or "无"))
    d["active"] = name
    save_accounts(d)
    return name


def cred(name=None):
    """返回 (name, appid, appsecret)。"""
    d = load_accounts()
    name = name or d.get("active")
    acc = d.get("accounts", {}).get(name)
    if not acc or not acc.get("appid") or not acc.get("appsecret"):
        raise RuntimeError(
            "没有可用账号。先执行：\n"
            "  gzh.py account add <别名> --appid wx... --secret ...\n"
            "配置目录：%s" % CONF)
    return name, acc["appid"].strip(), acc["appsecret"].strip()


def mask(appid):
    return appid[:6] + "..." + appid[-4:] if len(appid) > 12 else "***"


# ---------------------------------------------------------------- token
def _load_tokens():
    if not os.path.exists(TOKENS):
        return {}
    try:
        with open(TOKENS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_tokens(d):
    with open(TOKENS, "w", encoding="utf-8") as f:
        json.dump(d, f)


def get_token(name=None, force=False):
    name, appid, secret = cred(name)
    now = int(time.time())
    toks = _load_tokens()
    if not force:
        c = toks.get(appid)
        # token 与 appid 严格绑定，换号必须作废旧缓存
        if c and c.get("expire_at", 0) > now + 120:
            return c["access_token"]
    res = api_get("/cgi-bin/token", grant_type="client_credential",
                  appid=appid, secret=secret)
    check_err(res, "获取 access_token")
    tok = res["access_token"]
    toks[appid] = {"access_token": tok, "expire_at": now + int(res.get("expires_in", 7200))}
    _save_tokens(toks)
    return tok


# ---------------------------------------------------------------- 高层动作
def probe_token(name=None):
    """只验凭证，不做任何业务调用。"""
    n, appid, _ = cred(name)
    get_token(n, force=True)
    return {"account": n, "appid": mask(appid), "token": "OK"}


PERM_PROBES = [
    ("草稿箱", "/cgi-bin/draft/batchget", {"offset": 0, "count": 1, "no_content": 1}),
    ("素材库", "/cgi-bin/material/batchget_material",
     {"type": "image", "offset": 0, "count": 1}),
    ("发布接口", "/cgi-bin/freepublish/batchget",
     {"offset": 0, "count": 1, "no_content": 1}),
]


def probe_permissions(name=None):
    tok = get_token(name)
    out = []
    for label, path, body in PERM_PROBES:
        try:
            r = api_post_json(path, body, access_token=tok)
        except RuntimeError as e:
            out.append({"label": label, "ok": False, "detail": str(e)[:120]})
            continue
        ec = r.get("errcode", 0)
        if ec == 0:
            extra = ""
            if "total_count" in r:
                extra = "（现有 %s 条）" % r["total_count"]
            out.append({"label": label, "ok": True, "detail": "可用" + extra})
        elif ec == 48001:
            out.append({"label": label, "ok": False, "detail": "未授权（48001）"})
        else:
            out.append({"label": label, "ok": False,
                        "detail": "errcode=%s %s" % (ec, r.get("errmsg", ""))})
    return out


def upload_thumb(path, name=None):
    """永久图片素材 -> thumb_media_id（封面用）。上限宽松（10MB 级）。"""
    tok = get_token(name)
    r = api_post_file("/cgi-bin/material/add_material", path,
                      access_token=tok, type="image")
    check_err(r, "上传永久图片素材")
    return r["media_id"]


def upload_content_image(path, name=None):
    """正文图片 -> 微信 URL。硬限制 1MB，超了会被拒。"""
    sz = os.path.getsize(path)
    if sz > 1024 * 1024:
        raise RuntimeError("正文图片 %.2fMB 超过微信 1MB 限制：%s" % (sz / 1048576.0, path))
    tok = get_token(name)
    r = api_post_file("/cgi-bin/media/uploadimg", path, access_token=tok)
    check_err(r, "上传正文图片")
    return r["url"]


def list_materials(name=None, count=20):
    tok = get_token(name)
    r = api_post_json("/cgi-bin/material/batchget_material",
                      {"type": "image", "offset": 0, "count": count},
                      access_token=tok)
    check_err(r, "拉取素材列表")
    return r


def list_drafts(name=None, count=20):
    tok = get_token(name)
    r = api_post_json("/cgi-bin/draft/batchget",
                      {"offset": 0, "count": count, "no_content": 1},
                      access_token=tok)
    check_err(r, "拉取草稿列表")
    rows = []
    for it in r.get("item", []):
        for a in it.get("content", {}).get("news_item", []):
            rows.append({"media_id": it.get("media_id"), "title": a.get("title"),
                         "update_time": it.get("update_time")})
    return rows, r.get("total_count", len(rows))


def add_draft(title, content_html, thumb_media_id, digest="", author="",
              source_url="", open_comment=1, name=None):
    if len(title) > 64:
        raise RuntimeError("标题超过 64 字（当前 %d）" % len(title))
    digest = digest or ""
    if len(digest) > 120:
        digest = digest[:120]
    tok = get_token(name)
    art = {
        "title": title,
        "author": author,
        "digest": digest,
        "content": content_html,
        "content_source_url": source_url,
        "thumb_media_id": thumb_media_id,
        "need_open_comment": int(open_comment),
        "only_fans_can_comment": 0,
    }
    r = api_post_json("/cgi-bin/draft/add", {"articles": [art]}, access_token=tok)
    check_err(r, "新增草稿")
    return r["media_id"]


def delete_draft(media_id, name=None):
    tok = get_token(name)
    r = api_post_json("/cgi-bin/draft/delete", {"media_id": media_id}, access_token=tok)
    check_err(r, "删除草稿")
    return True


def publish(media_id, name=None):
    """提交发布。仅【已认证服务号】可用。"""
    tok = get_token(name)
    r = api_post_json("/cgi-bin/freepublish/submit", {"media_id": media_id},
                      access_token=tok)
    check_err(r, "提交发布")
    return r.get("publish_id")


def publish_status(publish_id, name=None):
    tok = get_token(name)
    r = api_post_json("/cgi-bin/freepublish/get", {"publish_id": publish_id},
                      access_token=tok)
    check_err(r, "查询发布状态")
    return r


if __name__ == "__main__":
    print("配置目录:", CONF)
    print("账号文件:", ACCOUNTS, "(存在)" if os.path.exists(ACCOUNTS) else "(未创建)")
    print("token缓存:", TOKENS)
    sys.exit(0)
