#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能体预设校验：复刻宿主 @deepseek-ai/dsh-agent-presets 的检查逻辑。

宿主对每个预设做两件事，任一不通过就会被标成 `broken` 并静默不出现在 SUPER AGENTS：
  1. entryListProblem()：组合必须是「顶层 plugin 行列表」，每行是带 name 字符串的 map，
     group:true 的行要递归检查其 config
  2. packageInstalled()：每个 name 指向的包必须能在 node_modules 里找到

本脚本把这两条本地化，写完预设先自己验一遍，别等宿主静默跳过。
"""
import os
import json
import os
import shutil
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:
    print("需要 PyYAML"); sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="gzh-preset-")


class JsTag:
    def __init__(self, v):
        self.v = v


def js_ctor(loader, node):
    return JsTag(loader.construct_scalar(node) if isinstance(node, yaml.ScalarNode) else None)


for tag in ("tag:yaml.org,2002:js", "!js"):
    yaml.SafeLoader.add_constructor(tag, js_ctor)

APP_NM = r"<repo-root>\build\dist\app\node_modules"
PRESETS = r"<repo-root>\build\dist\home\.agent-presets"


def entry_list_problem(rows, at=""):
    """与宿主 entryListProblem() 同规则。"""
    if not isinstance(rows, list):
        return ("the composition must be a top-level list of plugin rows"
                if at == "" else "group %s must hold a list of plugin rows" % at)
    for i, row in enumerate(rows):
        label = ("row %d" % (i + 1)) if at == "" else "%s row %d" % (at, i + 1)
        if not isinstance(row, dict):
            return '%s is not a plugin row (expected a map with a "name")' % label
        name = row.get("name")
        if not isinstance(name, str) or name == "":
            return '%s names no plugin (a "name" string is required)' % label
        if row.get("group") is True:
            nested = entry_list_problem(row.get("config"), label)
            if nested:
                return nested
    return None


def package_installed(name):
    # `cordis:group` 这类带冒号前缀的是 cordis 内置构造，不是 npm 包，不参与安装检查。
    # （判据：已知可用的 secretary / weather-reporter 也含 cordis:group，
    #   若把它算作缺失，校验器会把好预设也判成坏的。）
    if ":" in name:
        return True
    pkg = "/".join(name.split("/")[:2]) if name.startswith("@") else name.split("/")[0]
    return os.path.exists(os.path.join(APP_NM, pkg, "package.json"))


def collect_names(rows, out):
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("name"), str):
            out.append(row["name"])
            if row.get("group") is True:
                collect_names(row.get("config") or [], out)
    return out


def collect_rows(rows, out=None):
    """把组合摊平成 [{id, name, config}]，交给 Node 做插件级配置校验。
    群组行本身的 config 是子行列表，不是插件配置，故置 None。"""
    out = [] if out is None else out
    for row in rows:
        if not isinstance(row, dict):
            continue
        is_group = row.get("group") is True
        out.append({"id": row.get("id"), "name": row.get("name"),
                    "config": None if is_group else row.get("config")})
        if is_group and isinstance(row.get("config"), list):
            collect_rows(row["config"], out)
    return out


def main(targets):
    ok_all = True
    for name in targets:
        d = os.path.join(PRESETS, name)
        comp = os.path.join(d, "agent.cordis.yml")
        print("=" * 68)
        print("预设：%s" % name)
        if not os.path.exists(comp):
            print("  ❌ 缺少 agent.cordis.yml")
            ok_all = False
            continue

        # preset.yml
        py = os.path.join(d, "preset.yml")
        if os.path.exists(py):
            meta = yaml.safe_load(open(py, encoding="utf-8"))
            print("  显示名 : %s" % meta.get("name"))
            print("  排序   : %s" % meta.get("order", "(未设)"))
            if not meta.get("description"):
                print("  ⚠️ 缺 description，SUPER AGENTS 里会没有副标题")
        else:
            print("  ⚠️ 缺 preset.yml（会以目录名为显示名）")

        doc = yaml.safe_load(open(comp, encoding="utf-8"))
        prob = entry_list_problem(doc)
        if prob:
            print("  ❌ 组合结构不合格：%s" % prob)
            ok_all = False
            continue
        print("  ✅ 组合结构合格（顶层 %d 行）" % len(doc))

        names = collect_names(doc, [])
        missing = [n for n in names if not package_installed(n)]
        print("  %s 插件包 %d 个，全部已安装" % ("✅" if not missing else "❌", len(names)))
        if missing:
            for m in missing:
                print("      缺失：%s" % m)
            ok_all = False

        # persona 必填
        persona = next((r for r in doc if isinstance(r, dict) and r.get("id") == "persona"), None)
        if persona and persona.get("config", {}).get("text"):
            print("  ✅ persona 已配置（%d 字）" % len(persona["config"]["text"]))
        else:
            print("  ⚠️ 没有 persona，智能体没有系统提示词")

        # 第三步：插件自身的配置校验。
        # 宿主「发现」不查这个 —— 插件配置要到【挂载】阶段才校验，所以漏一个必填项会
        # 表现为「发现 OK，但智能体被系统禁用」。这里把挂载时会跑的那段代码提前跑一遍。
        rows_out = os.path.join(TMP, "_rows_%s.json" % name)
        with open(rows_out, "w", encoding="utf-8") as f:      # 无 BOM，否则 JSON.parse 报错
            json.dump(collect_rows(doc), f, ensure_ascii=False)
        node = shutil.which("node")
        checker = os.path.join(HERE, "check_plugin_config.mjs")
        if node and os.path.exists(checker):
            res = os.path.join(TMP, "_cfg_%s.txt" % name)
            with open(res, "w", encoding="utf-8") as f:
                subprocess.run([node, checker, rows_out], stdout=f, stderr=subprocess.STDOUT)
            text = open(res, encoding="utf-8").read()
            bad = [l for l in text.splitlines() if "配置校验失败" in l]
            if bad:
                print("  ❌ 插件配置校验未通过：")
                for l in bad:
                    print("     " + l.strip())
                ok_all = False
            else:
                print("  ✅ 插件配置校验通过（含必填项检查）")
        else:
            print("  ⚠️ 跳过插件配置校验（找不到 node 或 check_plugin_config.mjs）")
    print("=" * 68)
    print("结论：%s" % ("全部通过 ✅" if ok_all else "存在问题 ❌"))
    return 0 if ok_all else 1


if __name__ == "__main__":
    args = sys.argv[1:] or ["gzh-publisher"]
    sys.exit(main(args))
