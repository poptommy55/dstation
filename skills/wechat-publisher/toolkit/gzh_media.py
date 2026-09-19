#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片引擎：宽表转图 + ACES 封面生成。

两个硬约束（都是实测出来的，不是猜的）：
  1. 正文图片 (media/uploadimg) 单图必须 <= 1MB，超了微信直接拒
     -> 本模块内置降质循环：PNG -> JPEG 92..64 质量、1.0..0.6 倍尺寸
  2. Chrome 在 workspace-write 沙箱下【一律无法启动】：
     FATAL:mojo\\public\\cpp\\platform_channel.cc:108 Check failed: 拒绝访问。(0x5)
     根因是 Chrome 多进程架构用命名管道做 IPC，而沙箱禁止命名管道。
     换 Edge / headless-shell / Start-Process / cmd /c 全部同样失败。
     => 渲染宽表前必须确认会话已具备 danger-full-access。
"""
import glob
import os
import shutil
import subprocess
import sys

MAX_BYTES = 950 * 1024
WIN_W, WIN_H, SCALE = 2000, 3400, 2

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1219\chrome-win64\chrome.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright"
                       r"\chromium_headless_shell-1219\chrome-headless-shell-win64"
                       r"\chrome-headless-shell.exe"),
]


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    return shutil.which("chrome") or shutil.which("msedge")


def _shot(chrome, html_path, png_path, profile):
    cmd = [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
           "--no-first-run", "--no-default-browser-check",
           "--disable-crash-reporter",
           "--force-device-scale-factor=%d" % SCALE,
           "--window-size=%d,%d" % (WIN_W, WIN_H),
           "--user-data-dir=" + profile,
           "--screenshot=" + png_path,
           "file:///" + os.path.abspath(html_path).replace("\\", "/")]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=120)
    except Exception:
        return False
    return os.path.exists(png_path)


def _trim(im):
    from PIL import Image, ImageChops
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg.convert("RGB")
    else:
        im = im.convert("RGB")
    diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255)))
    box = diff.getbbox()
    if not box:
        return im
    pad = 16
    l, t, r, b = box
    return im.crop((max(0, l - pad), max(0, t - pad),
                    min(im.width, r + pad), min(im.height, b + pad)))


def _save_under_limit(im, out_base):
    png = out_base + ".png"
    im.save(png, "PNG", optimize=True)
    if os.path.getsize(png) <= MAX_BYTES:
        return png, os.path.getsize(png)
    os.remove(png)
    jpg = out_base + ".jpg"
    for scale in (1.0, 0.9, 0.8, 0.7, 0.6):
        cur = im if scale == 1.0 else im.resize(
            (int(im.width * scale), int(im.height * scale)))
        for q in (92, 86, 80, 72, 64):
            cur.save(jpg, "JPEG", quality=q, optimize=True, progressive=True)
            if os.path.getsize(jpg) <= MAX_BYTES:
                return jpg, os.path.getsize(jpg)
    return jpg, os.path.getsize(jpg)


def render_tables(tables_dir, img_dir, verbose=True):
    """把 tables_dir 里的 wide_*.html 渲染成图片。返回 [{name, path, w, h, bytes}]。"""
    from PIL import Image
    chrome = find_chrome()
    if not chrome:
        raise RuntimeError("找不到 Chrome / Edge，无法渲染宽表")
    os.makedirs(img_dir, exist_ok=True)
    tmp = os.path.join(img_dir, "_tmp")
    profile = os.path.join(tmp, "chrome-profile")
    os.makedirs(profile, exist_ok=True)

    out = []
    files = sorted(glob.glob(os.path.join(tables_dir, "wide_*.html")))
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        raw = os.path.join(tmp, name + "_raw.png")
        if verbose:
            print("  渲染 %s ..." % name)
        if not _shot(chrome, f, raw, profile):
            print("    ❌ 渲染失败。若报 Mojo platform_channel 拒绝访问(0x5)，"
                  "说明当前会话是 workspace-write 沙箱，Chrome 起不来，需要 danger-full-access。")
            continue
        im = _trim(Image.open(raw))
        path, size = _save_under_limit(im, os.path.join(img_dir, name))
        out.append({"name": name, "path": path, "w": im.width, "h": im.height,
                    "bytes": size})
        if verbose:
            print("    %s  %dx%d  %.0f KB"
                  % (os.path.basename(path), im.width, im.height, size / 1024.0))
    return out


# ---------------------------------------------------------------- ACES 封面
def aces_client():
    """加载 ACES 客户端。技能目录可用 ACES_SKILL 覆盖。"""
    skill = os.environ.get("ACES_SKILL", "").strip()
    if not skill:
        home = os.environ.get("DSH_HOME", "").strip()
        if home:
            skill = os.path.join(home, "skills", "aces-system")
    if not skill or not os.path.isdir(skill):
        raise RuntimeError("找不到 aces-system 技能目录，设 ACES_SKILL 环境变量指定")
    if skill not in sys.path:
        sys.path.insert(0, skill)
    import aces_client as ac
    return ac, ac.ACESClient.from_keyfile()


def make_cover(prompt, ratio, resolution, prefix, out_dir):
    """文生图。prompt/ratio/resolution 三项必填、无默认值。

    注意：不能用 client.text_to_image() 后再调 submit_and_wait ——
    text_to_image 只返回 taskId，而 submit_and_wait 内部会【再 run() 一次】，
    等于重复提交、白烧一次额度。这里显式走 run -> 落盘 taskId -> 轮询。
    """
    import time
    ac, c = aces_client()
    if not c.has_key():
        raise RuntimeError("ACES KEY 未配置")
    if not (prompt and ratio and resolution):
        raise RuntimeError("prompt / ratio / resolution 三项均为必填")
    import aces_save
    os.makedirs(out_dir, exist_ok=True)
    nodes = [
        {"nodeId": ac.IMG_TEXT_NODE, "fieldName": "Text",
         "fieldValue": prompt, "description": "提示词"},
        {"nodeId": ac.IMG_RATIO_NODE, "fieldName": "aspectRatio",
         "fieldValue": ratio, "description": "画面比例"},
        {"nodeId": ac.IMG_RES_NODE, "fieldName": "resolution",
         "fieldValue": resolution, "description": "画面分辨率"},
    ]
    task_id = c.run(ac.IMG_WEBAPP, nodes)
    # 立刻落盘 taskId —— 进程中断还能续查；ACES 无任务列表接口，丢了 id 就白烧额度
    with open(os.path.join(out_dir, "_last_task_id.txt"), "w", encoding="utf-8") as f:
        f.write(str(task_id))
    print("  taskId = %s（已落盘）" % task_id)
    deadline = time.time() + 900
    res = None
    while time.time() < deadline:
        res = c.query(task_id)
        data = res.get("data") if isinstance(res, dict) else None
        status = (data.get("status") if isinstance(data, dict) else None) or \
                 (res.get("status") if isinstance(res, dict) else None)
        if status in ("SUCCESS", "FAILED", "FAIL"):
            if status != "SUCCESS":
                raise RuntimeError("ACES 返回：%s" % status)
            saved = aces_save.save_outputs(res, out_dir=out_dir, prefix=prefix)
            aces_save.print_paths(saved)
            try:
                q = c.get_quota()
                print("  生成成功 ✅ ｜ 本次消耗：1 次（ACES 账户额度）｜ %s"
                      % ac.ACESClient.format_quota_report(q))
            except Exception:
                pass
            return [str(p) for p in (saved or [])]
        time.sleep(5)
    raise RuntimeError("TIMEOUT：任务仍在 ACES 运行，可用任务 ID %s 续查" % task_id)
