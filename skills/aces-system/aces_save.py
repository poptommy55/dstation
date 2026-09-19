# -*- coding: utf-8 -*-
"""
ACES 生成物落盘模块（DSH 预览链路的关键一环）。

为什么必须有它：
    本 skill 的创作接口只返回**远端结果**——taskId + query 响应里的 results[].url
    （腾讯云 COS 链接）。全程没有任何本地文件。而 DSH 的「媒体预览」插件识别的是
    **正文里的绝对文件路径**，所以"生成成功"和"能看见"之间差着这一环：
    不落盘 → 插件无从识别 → 用户看到"AI 生成图片不会自动显示"。

    因此：**任何生成任务成功后，都必须先调用本模块把产物下载到会话工作区，
    再把绝对路径写进回复正文。**

用法（三步，缺一不可）：
    from aces_save import save_outputs, print_paths

    r = c.submit_and_wait(...)                 # 1) 等终态，拿到 query 响应
    saved = save_outputs(r.get("result"), prefix="aces_橘猫窗台_16x9_2k")   # 2) 落盘
    print_paths(saved)                          # 3) 打印绝对路径（写进回复正文）

输出目录优先级：
    1) 环境变量 DSH_ACES_OUT_DIR
    2) 调用方显式传入 out_dir
    3) 环境变量 DSH_WORKSPACE_ROOT
    4) 当前工作目录下的 aces-output/
"""

import json
import os
import re
import urllib.request

# 只认这些扩展名，避免把 JSON/日志之类的东西当成品下载
MEDIA_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
             ".mp4", ".webm", ".mov", ".mkv",
             ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac")

# 单文件上限：超过就跳过并说明（防止误下载超大对象）
MAX_BYTES = 512 * 1024 * 1024


def _unescape_ws_segment(seg):
    """
    把 DSH 会话目录名还原成工作区路径（**兜底用**；解不出就返回 None）。

    DSH 的会话日志路径形如：
        <home>\\sessions\\<ENC>\\<session-dir>\\session.jsonl.zstd
    `<ENC>` 是工作区路径的编码：非 ASCII 写成 `~XXXX`（码点十六进制），
    路径分隔符与盘符冒号都写成 `-`，两端再包一层 `-`。
    例：D:\\DSH\\DH2\\实验区  →  --D-DSH-DH2-~5B9E~9A8C~533A--

    这里**不猜编码规则**（猜过两次都错：先漏剥、后多剥，把盘符标记吃掉了）。
    做法是把「两端各剥 0/1/2 个 `-`」与「内部每个 `-` 是否算分隔符」全枚举一遍，
    再用 `os.path.isdir` 兜底验证 —— 真实工作区必然存在，唯一解自然浮出来。
    没有任何候选存在就返回 None（调用方应有明确兜底，不要让图静默丢在工作区外）。
    """
    if not seg:
        return None
    unescaped = re.sub(r"~([0-9A-Fa-f]{4})", lambda m: chr(int(m.group(1), 16)), seg)

    from itertools import combinations

    for lead in (0, 1, 2):
        for tail in (0, 1, 2):
            core = unescaped
            if lead:
                core = core[lead:]
            if tail:
                core = core[: len(core) - tail] if tail <= len(core) else ""
            if not core:
                continue

            drive = ""
            body = core
            # 盘符：开头是 X- 或 -X-
            m = re.match(r"^-?([A-Za-z])-(.*)$", core)
            if m:
                drive, body = m.group(1).upper() + ":", m.group(2)
            else:
                body = core.lstrip("-")

            positions = [i for i, ch in enumerate(body) if ch == "-"]
            for keep in range(0, len(positions) + 1):
                for combo in combinations(positions, keep):
                    chars = list(body)
                    for pos in combo:
                        chars[pos] = os.sep
                    joined = "".join(chars)
                    candidate = (drive + os.sep + joined.lstrip(os.sep)) if drive else (os.sep + joined.lstrip(os.sep))
                    if os.path.isdir(candidate):
                        return os.path.abspath(candidate)
    return None


def _workspace_from_session_log():
    """
    从 DSH 的会话日志路径反推会话工作区（兜底用）。

    DSH 会把会话日志位置放进环境变量 DSH_SESSION_JSONL，形如：
        <home>\\sessions\\<encoded-workspace>\\session-<id>\\session.jsonl.zstd
    其中 `<encoded-workspace>` 是工作区路径的编码。取得到就返回绝对路径，否则 None。
    """
    log = os.environ.get("DSH_SESSION_JSONL")
    if not log:
        return None
    try:
        sess_dir = os.path.dirname(log)                   # …\sessions\<enc>\session-<id>
        enc = os.path.basename(os.path.dirname(sess_dir))  # <enc>
    except Exception:
        return None
    ws = _unescape_ws_segment(enc)
    if ws is None:
        return None
    # 别把技能目录当成工作区（技能目录常挂在 home 下，属于"能解出来但不该用"的情况）
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.abspath(ws) == os.path.abspath(here):
        return None
    return ws


def resolve_out_dir(out_dir=None):
    """
    决定落盘目录（不存在则创建）。

    优先级（**关键：绝不能落到技能目录** —— 那在工作区之外，宿主预览取不到）：

      1. 调用方显式传入的 out_dir
      2. 环境变量 DSH_ACES_OUT_DIR
      3. 环境变量 DSH_WORKSPACE_ROOT 下的 aces-output
      4. 从会话日志路径反推出的工作区下的 aces-output   ← 兜底，避免"cwd 是技能目录"
      5. 当前工作目录下的 aces-output（再兜一层）

    注意第 4 条：很多调用会把 cwd 设成技能目录，此时第 5 条会落到技能目录里，
    产物就永远出不来。第 4 条用 DSH 自己的会话信息纠正它。
    """
    if out_dir:
        cand = out_dir
    elif os.environ.get("DSH_ACES_OUT_DIR"):
        cand = os.environ["DSH_ACES_OUT_DIR"]
    elif os.environ.get("DSH_WORKSPACE_ROOT"):
        cand = os.path.join(os.environ["DSH_WORKSPACE_ROOT"], "aces-output")
    else:
        ws = _workspace_from_session_log()
        cand = os.path.join(ws, "aces-output") if ws else os.path.join(os.getcwd(), "aces-output")

    # 最后一道保险：万一还是落在技能目录里，明确改名，让问题可见而不是静默丢图
    skill_dir = os.path.dirname(os.path.abspath(__file__))
    if os.path.abspath(cand).startswith(os.path.abspath(skill_dir) + os.sep):
        print("  [aces_save] 警告：落盘目录落在技能目录内（%s）。" % cand)
        print("  [aces_save] 这里在工作区之外，宿主预览无法读取 —— 请显式传 out_dir=<会话工作区>。")
    os.makedirs(cand, exist_ok=True)
    return cand


def _walk_urls(obj, acc):
    """递归收集所有 http(s) 链接（结果结构会随版本变化，不硬编码字段名）。"""
    if isinstance(obj, dict):
        for v in obj.values():
            _walk_urls(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _walk_urls(v, acc)
    elif isinstance(obj, str) and obj.startswith("http"):
        acc.append(obj)
    return acc


def _pick_media(urls):
    """优先挑带媒体扩展名的链接；一个都没有时退回全部（交给人判断）。"""
    media = [u for u in urls if os.path.splitext(u.split("?")[0])[1].lower() in MEDIA_EXT]
    return media or urls


def _safe_ext(url, fallback=".png"):
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    return ext if ext in MEDIA_EXT else fallback


def _unique_path(out_dir, name):
    """重名不覆盖：追加 -1 / -2 …"""
    base, ext = os.path.splitext(name)
    cand = os.path.join(out_dir, name)
    i = 1
    while os.path.exists(cand):
        cand = os.path.join(out_dir, "%s-%d%s" % (base, i, ext))
        i += 1
    return cand


def save_outputs(query_result, out_dir=None, prefix="aces", timeout=180, headers=None):
    """
    把一次生成的结果下载到工作区。

    :param query_result: query() 的原始响应（dict），或任何含 http 链接的结构
    :param out_dir:      指定目录；缺省走 resolve_out_dir()
    :param prefix:       文件名前缀，建议带可读信息，如 aces_橘猫窗台_16x9_2k
    :param headers:      额外请求头（个别对象存储需要 Referer/Cookie 之类时用得上）
    :return: list[dict]，每项 {'path': 绝对路径, 'bytes': 字节数, 'url': 来源}
    """
    if not query_result:
        return []
    urls = _pick_media(_walk_urls(query_result, []))
    if not urls:
        return []

    target_dir = resolve_out_dir(out_dir)
    saved = []
    for i, url in enumerate(urls, 1):
        name = "%s%s" % (prefix, "" if i == 1 else "-%d" % i)
        name += _safe_ext(url)
        path = _unique_path(target_dir, name)
        hdrs = {"User-Agent": "Mozilla/5.0"}
        hdrs.update(headers or {})
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                blob = resp.read(MAX_BYTES + 1)
            if len(blob) > MAX_BYTES:
                print("  [aces_save] 跳过（超过 %d MB）：%s" % (MAX_BYTES // 1048576, url[:100]))
                continue
            if len(blob) < 2048:
                # 太小的多半是错误页/占位，不当成品
                print("  [aces_save] 跳过（仅 %d 字节，疑似错误页/空文件）：%s" % (len(blob), url[:100]))
                continue
            with open(path, "wb") as f:
                f.write(blob)
            saved.append({"path": path, "bytes": len(blob), "url": url})
        except Exception as e:  # 单个链接失败不影响其余
            print("  [aces_save] 下载失败 %s：%s %s" % (url[:100], type(e).__name__, e))
    return saved


def print_paths(saved):
    """
    打印可预览的绝对路径。**回复正文里必须出现这些路径**——
    DSH 的媒体预览插件就是靠扫描正文里的绝对路径出卡的。
    """
    if not saved:
        print("(没有成功落盘的产物)")
        return
    print("\n=== 可预览的绝对路径（请原样写进回复正文）===")
    for item in saved:
        print(item["path"])
        print("  -> %.2f MB" % (item["bytes"] / 1048576.0))


def extract_task_id(raw):
    """
    从 run 响应里稳妥地取 taskId。
    存在的意义：客户端原有写法在网关返回 `"data": null` 时会抛 AttributeError。

    补丁 6（2026-09-13）：`DefaultGatewayAdapter.run()` 成功时**直接返回 taskId 字符串**
    （实测 `image_to_video()` 返回 `"2098947148363292673"`），原实现只认 dict、
    对字符串一律返回 None，会导致「任务其实已提交成功，却被判定为没拿到 taskId」——
    白白烧掉一次额度还可能丢掉任务 id。这里补上 str/int 直通。
    """
    if isinstance(raw, str):
        s = raw.strip()
        return s or None
    if isinstance(raw, int):
        return str(raw)
    if not isinstance(raw, dict):
        return None
    data = raw.get("data")
    if isinstance(data, dict) and data.get("taskId"):
        return data["taskId"]
    if isinstance(data, (str, int)) and str(data).strip():
        return str(data).strip()
    tid = raw.get("taskId")
    return str(tid) if tid is not None and str(tid).strip() else None


if __name__ == "__main__":
    """
    自检：不联网。**在 DSH 里请把工作目录设为会话工作区再运行**——
    这样打印出来的路径就是合法的落盘目录。若它不在工作区内，落盘将无法被预览。
    """
    out = resolve_out_dir()
    print("python cwd            =", os.getcwd())
    print("会话日志反推的工作区   =", _workspace_from_session_log())
    print("resolve_out_dir()     =", out)
    print("DSH_WORKSPACE_ROOT    =", os.environ.get("DSH_WORKSPACE_ROOT") or "(未设置)")
    print("DSH_SESSION_JSONL     =", os.environ.get("DSH_SESSION_JSONL") or "(未设置)")
    demo = {"data": {"results": [{"url": "https://x/a.png"}, {"url": "https://x/b.mp4"}]}}
    print("_walk_urls            =", _walk_urls(demo, []))
    print("_pick_media           =", _pick_media(_walk_urls(demo, [])))
    print("extract_task_id(T1)   =", extract_task_id({"data": {"taskId": "T1"}}))
    print("extract_task_id(null) =", extract_task_id({"data": None, "taskId": "T2"}))
    print("extract_task_id(bad)  =", extract_task_id({"data": None}))
    print("writable              =", os.access(out, os.W_OK))
    print(json.dumps({"ok": True, "out_dir": out}, ensure_ascii=False))
