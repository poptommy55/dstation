"""
ACES 系统 API 客户端

对外统一称「ACES 系统」。本模块不出现任何供应商具体名称，
所有调用都走 ACES 网关自有开放端点。

⚠️ 网关地址**不内置**：请复制 .aceskey.example 为 .aceskey 并填写 base_url。

鉴权：每个账户一个 KEY（用户在网页「我的 ACES KEY」可见）。对外能力走以下端点：
  - apiCallDemo  -> Query ?apiKey=<KEY>   （诊断用）
  - upload       -> Form  apiKey=<KEY>
  - ai-app/run   -> Body  {"apiKey": <KEY>}  (唯一扣额度)
  - query        -> Header Authorization: Bearer <KEY>
  - quota        -> Header Authorization: Bearer <KEY>  (查账户剩余额度)

能力：文生图 / 图生图 / 图生视频 / 背景音乐 / 数字人(带货·探店·演讲·混剪)。
用户可见功能 = 上述 5 类，与 PC 网页「创作/数字人」完全一致。
本客户端只走 ACES 网关自有开放端点，不依赖任何历史遗留直连通道。
"""

import os
import json
import time
import uuid
import urllib.request
import urllib.error
import tempfile

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(SKILL_DIR, ".aceskey")
APPS_CACHE = os.path.join(SKILL_DIR, "selected_apps.json")

# 不内置任何网关地址：请在 .aceskey 中配置 base_url。
# 留空时 ensure_key() 会给出明确指引并拒绝联网，而不是连向某个第三方主机。
DEFAULT_BASE_URL = ""

# ---- 应用标识（随 ACES 系统更新同步）----
IMG_WEBAPP = "2087776849849044994"     # 文生图 / 图生图 同一应用
VIDEO_WEBAPP = "2086359666010968065"   # 图生视频
BGM_WEBAPP = "2086792289673895937"     # 背景音乐

# 文生图/图生图（IMG_WEBAPP）
IMG_TEXT_NODE = "2"          # DF_Text_Box        fieldName=Text        提示词
IMG_RATIO_NODE = "1"         # 组合               fieldName=aspectRatio  画面比例
IMG_RES_NODE = "1"           # 组合               fieldName=resolution   画面分辨率
IMG_IMG_NODES = ["5", "6", "7"]  # fieldName=image 参考图1/2/3

# 图生视频（VIDEO_WEBAPP）
VIDEO_IMG_NODE = "114"       # LoadImage          fieldName=image       参考图
VIDEO_TEXT_NODE = "149"      # DF_Text_Box        fieldName=Text        视频提示词
VIDEO_RATIO_NODE = "150:5"   # ResolutionSelector fieldName=aspect_ratio 画面比例
VIDEO_DUR_NODE = "152"       # Float              fieldName=value       时长(5-15秒)

# 补丁 5（2026-09-13）：视频「画面比例」节点的真实 id 与取值都已变，原值 ("115"/"16:9") 会被网关拒。
# 实测提交报 `803 NODE_INFO_MISMATCH(nodeId=115, fieldName=aspect_ratio,
# reason=node_not_found_in_workflow)`；查 `get_app_info(VIDEO_WEBAPP).data.nodeInfoList`
# 得到真身：nodeId="150:5"，且是 COMBO 下拉，取值必须是**选项全称**（官方示例 "16:9 (Widescreen)"）。
# 因此这里把用户友好的 "16:9" 映射成下拉全称；已是全称的原样透传。
VIDEO_RATIO_MAP = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}

# 背景音乐（BGM_WEBAPP）
BGM_TEXT_NODE = "105"        # DF_Text_Box        fieldName=Text        提示词
BGM_DUR_NODE = "98"          # PrimitiveFloat     fieldName=value       时长(秒)

# 数字人场景定义
DIGITAL_SCENE_DEFS = {
    "general": {
        "webapp_id": VIDEO_WEBAPP,
        "image_inputs": [{"key": "person", "node": VIDEO_IMG_NODE, "label": "参考人物", "required": True}],
        "text_inputs": [{"key": "script", "node": VIDEO_TEXT_NODE, "field": "Text", "label": "口播稿", "required": True}],
    },
    "daigou": {
        "webapp_id": "2088102507095613442",
        "image_inputs": [
            {"key": "person", "node": "80", "label": "参考人物", "required": True},
            {"key": "product", "node": "77", "label": "产品", "required": True},
            {"key": "environment", "node": "78", "label": "环境", "required": True},
        ],
        "audio_inputs": [
            {"key": "tone", "node": "67", "label": "音色", "required": True},
            {"key": "bgm", "node": "65", "label": "背景音乐", "required": True},
        ],
        "text_inputs": [{"key": "script", "node": "70", "field": "Text", "label": "口播文案", "required": True}],
    },
    "tandian": {
        "webapp_id": "2084847504323076097",
        "image_inputs": [
            {"key": "person", "node": "10", "label": "人物设定", "required": True},
            {"key": "storefront", "node": "193", "label": "店面·门头", "required": True},
            {"key": "environment", "node": "194", "label": "店面·环境", "required": True},
            {"key": "customers", "node": "195", "label": "店面·顾客", "required": True},
            {"key": "product", "node": "196", "label": "店面·产品", "required": True},
        ],
        "audio_inputs": [{"key": "bgm", "node": "142", "label": "背景音乐", "required": True}],
        "text_inputs": [{"key": "script", "node": "199", "field": "Text", "label": "探店剧情", "required": True}],
    },
    "yanjiang": {
        "webapp_id": "2083228471328858113",
        "image_inputs": [{"key": "person", "node": "110", "label": "参考人物", "required": True}],
        "audio_inputs": [
            {"key": "tone", "node": "116", "label": "参考音色", "required": True},
            {"key": "bgm", "node": "137", "label": "背景音乐", "required": True},
        ],
        "text_inputs": [
            {"key": "scenario", "node": "111", "field": "value", "label": "场景提示词", "required": True},
            {"key": "script", "node": "115", "field": "text", "label": "演讲稿", "required": True},
        ],
    },
    # 混剪：数字人与现有视频素材融合，多用于文旅/个人IP口播。
    "hunjian": {
        "webapp_id": "2091472277329235970",
        "image_inputs": [
            {"key": "person", "node": "20", "label": "人物参考图", "required": True},
            {"key": "env", "node": "47", "label": "环境参考图", "required": True},
        ],
        "text_inputs": [
            {"key": "action", "node": "50", "field": "Text", "label": "视频动作提示词", "required": True},
            {"key": "script", "node": "178", "field": "Text", "label": "口播", "required": True},
            {"key": "narration", "node": "11", "field": "Text", "label": "旁白", "required": True},
        ],
        "audio_inputs": [{"key": "bgm", "node": "14", "label": "背景音乐", "required": True}],
        "video_inputs": [
            {"key": "v1", "node": "175", "label": "混剪素材1", "required": True},
            {"key": "v2", "node": "176", "label": "混剪素材2", "required": True},
            {"key": "v3", "node": "177", "label": "混剪素材3", "required": True},
        ],
    },
}
DIGITAL_SCENE_NAMES = {
    "general": "通用口播", "daigou": "带货", "tandian": "探店",
    "yanjiang": "演讲", "hunjian": "混剪",
}


class ACESClient:
    """ACES 系统客户端。"""

    def __init__(self, base_url=None, api_key=None, provider=None):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.api_key = api_key or ""
        self.provider = provider or ""
        self.adapter = self._build_adapter()

    # ---------- 配置加载 ----------
    @classmethod
    def from_keyfile(cls, path=None):
        """从 .aceskey 加载配置。格式：api_key=你的ACES_KEY（网页「我的 KEY」可见）。"""
        path = path or KEY_FILE
        cfg = {}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        k, v = line.split("=", 1)
                        cfg[k.strip()] = v.strip()
        api_key = cfg.get("api_key", "")
        base_url = cfg.get("base_url") or DEFAULT_BASE_URL
        provider = cfg.get("provider", "")
        return cls(base_url=base_url, api_key=api_key, provider=provider)

    def _build_adapter(self):
        return DefaultGatewayAdapter(self.base_url, self.api_key)

    # ---------- KEY 前置检查（任何联网动作前必须调用）----------
    def has_key(self):
        """是否已配置有效 KEY。**只返回 bool，绝不返回 KEY 本身。**

        补丁 8（2026-09-13）：原实现 `return bool(self.api_key) and self.api_key.strip()`
        在 KEY 非空时返回的是**去掉空白的 KEY 明文**，而不是 True。
        后果：任何一句诊断代码 `print(c.has_key())` 都会把凭证打进对话记录/日志
        （就是本次会话真实发生的事）。改为显式 bool，保留真值语义。
        """
        return bool(self.api_key and self.api_key.strip())

    def ensure_key(self):
        """没有 KEY 时立即抛出清晰指引，禁止继续任何联网操作。
        调用方（SKILL / agent）应在执行任何 ACES 任务的第一步就调用本方法，
        缺 KEY 时立刻告知用户如何配置并停止，不要做无谓探查。"""
        if not self.base_url:
            raise RuntimeError(
                "ACES 网关地址未配置。\n"
                "本仓库不内置任何 ACES 网关地址，请编辑文件：%s\n"
                "写入一行：base_url=https://你的ACES网关地址\n"
                "（可参考同目录 .aceskey.example）\n"
                "配置保存后重新发起请求即可。"
                % KEY_FILE
            )
        if not self.has_key():
            raise RuntimeError(
                "ACES 系统 KEY 未配置。\n"
                "请编辑文件：%s\n"
                "写入一行：api_key=你的ACES_KEY\n"
                "（KEY 在 ACES 网页「我的 KEY」页面可见）\n"
                "配置保存后重新发起请求即可。"
                % KEY_FILE
            )
        return True

    # ---------- PC 网页功能清单（本项目 ACES 系统用户可见入口）----------
    @classmethod
    def pc_functions(cls):
        """返回 ACES 系统用户可见的功能入口清单。
        与 ACES 网页「创作 / 数字人」完全一致。"""
        return [
            {"key": "text", "name": "文生图", "method": "text_to_image", "args": "prompt[, ratio, resolution]"},
            {"key": "img2img", "name": "图生图", "method": "image_to_image", "args": "prompt, image_path[, ratio, resolution]"},
            {"key": "video", "name": "图生视频", "method": "image_to_video", "args": "image_path, prompt[, ratio, duration]"},
            {"key": "bgm", "name": "背景音乐", "method": "bgm", "args": "prompt[, duration]"},
            {"key": "digital", "name": "数字人", "method": "digital", "args": "scene=daigou|tandian|yanjiang|hunjian[, images, texts, audios, videos]"},
        ]

    # ---------- 基础能力封装（_ 开头 = 内部/诊断用，不在 SKILL 公共 API 暴露）----------
    def _list_apps(self, use_cache=True, force=False):
        """【诊断用，非功能列表】列出 ACES 内部诊断信息。
        本方法为私有方法，SKILL.md / agent 不得向普通用户展示或调用。"""
        if use_cache and not force and os.path.exists(APPS_CACHE):
            try:
                with open(APPS_CACHE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("apps"):
                    return data["apps"]
            except Exception:
                pass
        self.ensure_key()
        apps = self.adapter._list_apps()
        try:
            with open(APPS_CACHE, "w", encoding="utf-8") as f:
                json.dump({"updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "apps": apps}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return apps

    def _refresh_apps(self):
        """【诊断用】强制刷新 ACES 内部诊断信息。"""
        return self._list_apps(use_cache=True, force=True)

    def get_app_info(self, webapp_id):
        """查看某应用结构。"""
        self.ensure_key()
        return self.adapter.get_app_info(webapp_id)

    def upload(self, file_path, file_type="input"):
        """上传素材，返回 ACES 内部 fileName。file_type: input/audio/video。"""
        self.ensure_key()
        return self.adapter.upload(file_path, file_type)

    def run(self, webapp_id, node_info_list):
        """提交运行任务，返回 taskId（自动扣额度）。"""
        self.ensure_key()
        return self.adapter.run(webapp_id, node_info_list)

    def query(self, task_id):
        """轮询任务结果，返回原始 JSON。"""
        self.ensure_key()
        return self.adapter.query(task_id)

    def get_quota(self):
        """KEY 鉴权：查该账户的剩余额度（次数配额，非金额）。
        返回 dict：{remaining_today, daily_limit, used_today, remaining_total, total_limit, used_total}。
        limit/remaining 为 -1 表示不限量。"""
        self.ensure_key()
        return self.adapter.get_quota()

    @staticmethod
    def format_quota_report(quota):
        """把额度 dict 格式化为面向用户的中文通报行。quota 取 get_quota() 的返回值。"""
        if not quota:
            return "（当前账户剩余额度暂无法读取）"
        d = quota.get("data", quota) if isinstance(quota, dict) else {}
        def _fmt(rem, limit, used, unit="次"):
            if limit is None:
                return "不限量"
            if limit == -1:
                return "不限量"
            return "剩余 %s / 限额 %s %s（已用 %s）" % (rem, limit, unit, used)
        today = _fmt(d.get("remaining_today"), d.get("daily_limit"), d.get("used_today"))
        total = _fmt(d.get("remaining_total"), d.get("total_limit"), d.get("used_total"))
        return "账户额度 → 今日：%s；累计：%s" % (today, total)

    def submit_and_wait(self, webapp_id, node_info_list, timeout=300, interval=5):
        """run -> 循环 poll 到终态。返回 {status, task_id, result, message, quota}。
        quota 在 SUCCESS 时自动附带（来自 get_quota），供通报账户剩余额度。"""
        task_id = self.run(webapp_id, node_info_list)
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            res = self.query(task_id)
            last = res
            data = res.get("data") if isinstance(res, dict) else None
            status = (data.get("status") if isinstance(data, dict) else None) or res.get("status")
            if status in ("SUCCESS", "FAILED", "FAIL"):
                out = {"status": status, "task_id": task_id, "result": res, "message": "", "quota": None}
                if status == "SUCCESS":
                    try:
                        out["quota"] = self.get_quota()
                    except Exception:
                        out["quota"] = None
                return out
            time.sleep(interval)
        return {"status": "TIMEOUT", "task_id": task_id, "result": last, "quota": None,
                "message": "任务仍在 ACES 系统运行，可用『查 ACES 任务 %s』续查" % task_id}

    # ---------- 5 类创作能力（对齐 PC 网页，全部走 ai-app/run）----------
    def _ref(self, val):
        """素材引用：本地路径自动上传，URL/fileName 直接用。返回 fieldValue。"""
        if not val:
            return val
        if isinstance(val, str) and (val.startswith("http://") or val.startswith("https://")):
            return val
        if os.path.exists(val):
            return self.upload(val)
        return val

    def text_to_image(self, prompt, ratio, resolution):
        """文生图。prompt=画面提示词；ratio=画面比例(如16:9/9:16)；resolution=分辨率(如1k/2k/4k)。三者均为必填。"""
        if not prompt or not ratio or not resolution:
            raise ValueError("文生图参数 prompt / ratio / resolution 均为必填")
        nodes = [
            {"nodeId": IMG_TEXT_NODE, "fieldName": "Text", "fieldValue": prompt, "description": "提示词"},
            {"nodeId": IMG_RATIO_NODE, "fieldName": "aspectRatio", "fieldValue": ratio, "description": "画面比例"},
            {"nodeId": IMG_RES_NODE, "fieldName": "resolution", "fieldValue": resolution, "description": "画面分辨率"},
        ]
        return self.run(IMG_WEBAPP, nodes)

    def image_to_image(self, prompt, image_path, ratio, resolution):
        """图生图。image_path=本地参考图/URL；prompt=改图提示词；ratio=画面比例；resolution=分辨率。四者均为必填。"""
        if not prompt or not image_path or not ratio or not resolution:
            raise ValueError("图生图参数 prompt / image_path / ratio / resolution 均为必填")
        fn = self._ref(image_path)
        nodes = [
            {"nodeId": IMG_TEXT_NODE, "fieldName": "Text", "fieldValue": prompt, "description": "提示词"},
            {"nodeId": IMG_IMG_NODES[0], "fieldName": "image", "fieldValue": fn, "description": "参考图1"},
            {"nodeId": IMG_RATIO_NODE, "fieldName": "aspectRatio", "fieldValue": ratio, "description": "画面比例"},
            {"nodeId": IMG_RES_NODE, "fieldName": "resolution", "fieldValue": resolution, "description": "画面分辨率"},
        ]
        return self.run(IMG_WEBAPP, nodes)

    def image_to_video(self, image_path, prompt, ratio, duration):
        """图生视频。image_path=本地参考图/URL；prompt=视频提示词；ratio=画面比例；duration=时长(5-15秒)。四者均为必填。"""
        if not image_path or not prompt or not ratio or duration is None:
            raise ValueError("图生视频参数 image_path / prompt / ratio / duration 均为必填")
        fn = self._ref(image_path)
        # 补丁 5：ComfyUI 的 ResolutionSelector 是 COMBO，必须传下拉选项全称
        ratio_val = VIDEO_RATIO_MAP.get(str(ratio).strip(), ratio)
        nodes = [
            {"nodeId": VIDEO_IMG_NODE, "fieldName": "image", "fieldValue": fn, "description": "参考图"},
            {"nodeId": VIDEO_TEXT_NODE, "fieldName": "Text", "fieldValue": prompt, "description": "视频提示词"},
            {"nodeId": VIDEO_RATIO_NODE, "fieldName": "aspect_ratio", "fieldValue": ratio_val, "description": "画面比例"},
            {"nodeId": VIDEO_DUR_NODE, "fieldName": "value", "fieldValue": str(duration), "description": "时长"},
        ]
        return self.run(VIDEO_WEBAPP, nodes)

    def bgm(self, prompt, duration):
        """背景音乐。prompt=音乐描述；duration=时长(秒)。两者均为必填。"""
        if not prompt or duration is None:
            raise ValueError("背景音乐参数 prompt / duration 均为必填")
        nodes = [
            {"nodeId": BGM_TEXT_NODE, "fieldName": "Text", "fieldValue": prompt, "description": "提示词"},
            {"nodeId": BGM_DUR_NODE, "fieldName": "value", "fieldValue": str(duration), "description": "音乐长度"},
        ]
        return self.run(BGM_WEBAPP, nodes)

    def digital(self, scene, images, texts, audios, videos):
        """数字人视频。scene=general/daigou/tandian/yanjiang/hunjian；
        images/texts/audios/videos 为 {素材key: 本地路径|URL|文本}。
        本地路径自动上传，URL/fileName 直接用。
        所有声明字段均为必填，缺失直接抛错。"""
        if not scene:
            raise ValueError("数字人场景 scene 不能为空")
        defn = DIGITAL_SCENE_DEFS.get(scene)
        if not defn:
            raise ValueError("不支持的数字人场景：%s" % scene)
        webapp = defn["webapp_id"]
        images = images or {}; texts = texts or {}
        audios = audios or {}; videos = videos or {}
        nodes = []
        for inp in defn.get("image_inputs", []):
            v = images.get(inp["key"])
            if inp.get("required") and not v:
                raise ValueError("数字人「%s」缺少必填图片素材：%s" % (DIGITAL_SCENE_NAMES.get(scene, scene), inp["label"]))
            if v:
                nodes.append({"nodeId": inp["node"], "fieldName": "image",
                              "fieldValue": self._ref(v), "description": inp["label"]})
        for tin in defn.get("text_inputs", []):
            v = texts.get(tin["key"])
            if tin.get("required") and not v:
                raise ValueError("数字人「%s」缺少必填文本素材：%s" % (DIGITAL_SCENE_NAMES.get(scene, scene), tin["label"]))
            if v:
                nodes.append({"nodeId": tin["node"], "fieldName": tin.get("field", "text"),
                              "fieldValue": v, "description": tin["label"]})
        for ain in defn.get("audio_inputs", []):
            v = audios.get(ain["key"])
            if ain.get("required") and not v:
                raise ValueError("数字人「%s」缺少必填音频素材：%s" % (DIGITAL_SCENE_NAMES.get(scene, scene), ain["label"]))
            if v:
                nodes.append({"nodeId": ain["node"], "fieldName": "audio",
                              "fieldValue": self._ref(v), "description": ain["label"]})
        for vin in defn.get("video_inputs", []):
            v = videos.get(vin["key"])
            if vin.get("required") and not v:
                raise ValueError("数字人「%s」缺少必填视频素材：%s" % (DIGITAL_SCENE_NAMES.get(scene, scene), vin["label"]))
            if v:
                nodes.append({"nodeId": vin["node"], "fieldName": "video",
                              "fieldValue": self._ref(v), "description": vin["label"]})
        return self.run(webapp, nodes)


class ProviderAdapter:
    """供应商适配抽象层。子类实现具体端点交互。"""

    def __init__(self, base_url, api_key):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _post(self, *a, **k):
        raise NotImplementedError

    def _list_apps(self):
        raise NotImplementedError

    def get_app_info(self, webapp_id):
        raise NotImplementedError

    def upload(self, file_path, file_type):
        raise NotImplementedError

    def run(self, webapp_id, node_info_list):
        raise NotImplementedError

    def query(self, task_id):
        raise NotImplementedError

    def get_quota(self):
        raise NotImplementedError


class DefaultGatewayAdapter(ProviderAdapter):
    """当前 ACES 网关适配（供应商无关封装）。"""

    def _request(self, method, path, *, headers=None, data=None, json_body=None,
                 form_files=None, form_fields=None, is_json_response=True):
        url = self.base_url + path
        h = dict(headers or {})
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        # multipart
        if form_files is not None or form_fields is not None:
            boundary = "----acesboundary" + uuid.uuid4().hex
            h["Content-Type"] = "multipart/form-data; boundary=" + boundary
            body = b""
            for k, v in (form_fields or {}).items():
                body += ("--%s\r\n" % boundary).encode()
                body += ("Content-Disposition: form-data; name=\"%s\"\r\n\r\n" % k).encode()
                body += str(v).encode("utf-8") + b"\r\n"
            for fname, fpath in (form_files or {}).items():
                with open(fpath, "rb") as f:
                    fdata = f.read()
                body += ("--%s\r\n" % boundary).encode()
                body += ("Content-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                         % (fname, os.path.basename(fpath))).encode()
                body += b"Content-Type: application/octet-stream\r\n\r\n"
                body += fdata + b"\r\n"
            body += ("--%s--\r\n" % boundary).encode()
            data = body
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in h.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
            raise RuntimeError("ACES 系统返回 HTTP %s：%s" % (e.code, raw.decode("utf-8", "replace")))
        if not is_json_response:
            return raw
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            return {"raw": raw.decode("utf-8", "replace")}

    # ---- 各端点鉴权映射（均为 ACES 网关自有端点）----
    def _list_apps(self):
        h = {"Authorization": self.api_key}
        r = self._request("POST", "/openapi/v2/aiapp/list", headers=h)
        if isinstance(r, dict):
            if "records" in r:
                return r["records"]
            if isinstance(r.get("data"), dict) and "records" in r["data"]:
                return r["data"]["records"]
            if isinstance(r.get("data"), list):
                return r["data"]
        return []

    def get_app_info(self, webapp_id):
        return self._request("GET", "/api/webapp/apiCallDemo?apiKey=" + self.api_key
                             + "&webappId=" + str(webapp_id))

    def upload(self, file_path, file_type="input"):
        # 补丁 4（2026-09-13）：上传端点同样会**间歇性**被网关拒绝鉴权。
        # 实测 `/task/openapi/upload` 返回 `HTTP 401 ApiKey verification failed`，
        # 而同一 KEY 隔几秒重试即 4/4 成功、且同 KEY 的文生图全程正常 ——
        # 与 run() 注释里描述的「网关间歇性拒鉴权」是同一现象，只是之前只给 run() 打了补丁。
        # 这里按同样思路对**鉴权类**失败做短重试；业务错误直接抛出，不重试。
        fields = {"apiKey": self.api_key, "fileType": file_type}
        last_err = None
        for _attempt in range(4):
            try:
                res = self._request("POST", "/task/openapi/upload",
                                    form_fields=fields, form_files={"file": file_path})
            except RuntimeError as e:
                msg = str(e)
                if ("HTTP 401" not in msg) and ("HTTP 403" not in msg) and ("apikey" not in msg.lower()):
                    raise
                last_err = e
                time.sleep(2)
                continue
            if isinstance(res, dict):
                if res.get("code") in (301, 811):
                    last_err = RuntimeError("ACES 系统返回：%s" % res)
                    time.sleep(2)
                    continue
                data = res.get("data")
                fn = res.get("fileName")
                if not fn and isinstance(data, dict):
                    fn = data.get("fileName")
                return fn or res
            return res
        raise last_err

    def run(self, webapp_id, node_info_list):
        body = {
            "apiKey": self.api_key,
            "webappId": str(webapp_id),
            "nodeInfoList": node_info_list,
            "origin": "aces_skill",
        }
        # 补丁（2026-09-13）：网关**间歇性**拒绝鉴权 —— 只读端点连打三次出现过
        # 第 1 次 `811 CORPAPIKEY_INVALID`、第 2/3 次 success；提交端点也出现过
        # `301 apikey not enabled`，表现为"服务器端没收到任务"（请求被挡在鉴权那一步）。
        # KEY 本身有效（quota 端点稳定正常、同 KEY 可成功生成），所以这里对**鉴权类**
        # 响应做短重试，避免碰上那一次就整轮报废。
        # 注意：只重试鉴权拒绝，不重试业务错误（如应用未授权），也不会重复提交——
        # 因为被拒的请求没有产生任务。
        AUTH_REJECT = (301, 811, 401, 403000)
        last = None
        for attempt in range(3):
            res = self._request("POST", "/task/openapi/ai-app/run", json_body=body)
            if isinstance(res, dict):
                code = res.get("code")
                msg = str(res.get("msg") or "")
                is_auth_reject = (code in AUTH_REJECT) or ("apikey" in msg.lower()) or ("APIKEY" in msg.upper())
                if is_auth_reject and attempt < 2:
                    last = res
                    time.sleep(1.5 * (attempt + 1))
                    continue
                # 原写法 `res.get("data", {})` 在 `"data": null` 时拿到 None
                # （默认值只在键缺失时生效），紧接着 .get() 会 AttributeError。
                data = res.get("data")
                inner = data.get("taskId") if isinstance(data, dict) else None
                return res.get("taskId") or inner or res
            return res
        return last if last is not None else res

    def query(self, task_id):
        # 补丁 7（2026-09-13）：query 端点同样会被网关**间歇性**拒鉴权。
        # 实测对同一个成功任务的 taskId 连查 3 次：SUCCESS / 811 CORPAPIKEY_INVALID / SUCCESS。
        # 危害：用户在对话里说「查 ACES 任务 <id>」时，可能被这一次拒签误导成
        # 「KEY 失效 / 任务有问题」，而任务其实早已 SUCCESS。
        # （submit_and_wait 的轮询是自愈的——被拒时 status 为空、不落终态、下一轮继续查，
        #  所以本补丁主要修的是**单次查询**这条对外路径。）
        # 只对鉴权类响应重试；业务错误（如 taskId 不存在）直接返回，不吞掉真实报错。
        h = {"Authorization": "Bearer " + self.api_key}
        AUTH_REJECT = (301, 811, 401, 403000)
        last = None
        for attempt in range(4):
            res = self._request("POST", "/openapi/v2/query",
                                json_body={"taskId": str(task_id)}, headers=h)
            if not isinstance(res, dict):
                return res
            inner = res.get("data")
            status = res.get("status") or (inner.get("status") if isinstance(inner, dict) else None)
            code = res.get("code")
            err_code = res.get("errorCode")
            msg = str(res.get("errorMessage") or res.get("msg") or "")
            is_auth_reject = (code in AUTH_REJECT) or (err_code in AUTH_REJECT) \
                or ("apikey" in msg.lower()) or ("APIKEY" in msg.upper())
            # 已经拿到真实状态 → 直接返回；非鉴权类业务错误也原样返回，不吞错
            if status or not is_auth_reject:
                return res
            last = res
            if attempt < 3:
                time.sleep(1.5 * (attempt + 1))
        return last

    def get_quota(self):
        """KEY 鉴权：查该账户剩余额度（今日剩余/每日额度/累计已用/总限额）。"""
        h = {"Authorization": "Bearer " + self.api_key}
        return self._request("POST", "/openapi/v2/quota", headers=h)


def download_to_temp(url):
    """远程 URL 下载到临时文件，返回本地路径。"""
    suffix = os.path.splitext(url.split("?")[0])[1] or ".tmp"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    req = urllib.request.Request(url, headers={"User-Agent": "aces-skill"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        tmp.write(resp.read())
    tmp.close()
    return tmp.name


if __name__ == "__main__":
    # 自验证：无 KEY 时仅测试客户端构造与缓存逻辑，不联网
    c = ACESClient.from_keyfile()
    print("base_url:", c.base_url)
    print("has_key:", bool(c.api_key))
    print("adapter:", type(c.adapter).__name__)
    print("scenes:", list(DIGITAL_SCENE_DEFS.keys()))
