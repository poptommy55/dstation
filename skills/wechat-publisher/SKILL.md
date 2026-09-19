---
name: wechat-publisher
description: 把调研报告/长文优化成公众号文章并发布。涵盖报告体→公众号体的文体转换（钩子开场、观点式标题、长段拆短、看点卡、篇末三件套）、宽表转图、ACES 生成封面、多账号凭证与权限自检、草稿箱推送与发布。触发词：发公众号、公众号文章、推草稿、草稿箱、优化公众号、把报告改成公众号、公众号排版、群发、发布文章、wechat article、公众号运营。
---

# 公众号文章优化与发布

**先记住一句话：调研报告 ≠ 公众号文章。** 换个皮不算转换——报告体在公众号里，读者三屏就流失。

## ⚡ 最快启动路径

```bash
T=<技能目录>/toolkit
python $T/gzh.py doctor                       # ① 环境体检（必做一次）
python $T/gzh.py account check                # ② 凭证与权限自检
```

`account check` 的输出决定了**能做到哪一步**，先看这个再谈别的：

| 结果 | 含义 | 后续 |
|---|---|---|
| 发布接口 ✅ | 已认证服务号 | **可全自动发布**（`gzh.py publish`） |
| 只有草稿箱 ✅ | 订阅号或未认证服务号 | 推草稿全自动，**最后一步要人工点发布** |
| 连素材库都 ❌ | 账号没做微信认证 | 只能出 HTML，人工粘贴 |

## 🔴 铁律

1. **只动结构与表达，事实、数据、结论、来源一个字不改。** 改写是编辑行为，不是创作行为。
2. **所有参数必填，没有默认值。** 尤其 ACES 生图的 `prompt` / `ratio` / `resolution`，缺一个就问用户，不许替用户决定。
3. **凭证不回显。** AppID 只显示掩码，Secret 与 access_token 永不打印、永不写进对话。用户若贴了明文，做完提醒他去后台重置。
4. **推草稿前必须让人看预览。** 发布是单向的；草稿可删，发出去收不回。
5. **发布前逐项确认**：账号对不对、标题对不对、封面有没有、占位符有没有残留。

## 标准流程（六步）

```
报告 HTML
  │
  ├─① convert   报告体 → 公众号浅色内联样式，按需切篇，标记宽表
  ├─② 读骨架    用 outline 看标题层级/段落长度，产出「编辑计划」
  ├─③ edit      套用编辑计划做文体改写（钩子/观点式标题/拆段/看点/篇末）
  ├─④ tables    宽表(≥5列)渲染成图片（微信单图 ≤1MB）
  ├─⑤ cover     ACES 生成封面（每篇一张）
  ├─⑥ push      上传图片 + 替换占位符 + 建草稿
  └─⑦ publish   提交发布（仅已认证服务号；否则人工点）
```

### ① convert

```bash
python $T/gzh.py convert report.html --out out --drop-header \
    --split-at "3. 价值在往哪里迁移" "谁吃到钱" "4. 载体形态"
```

`--split-at` 是**切篇点**：正文遇到标题包含该字符串时，从那里开始新的一篇。
比较时会归一化空白，写带不带空格都行。上例把一篇 23821 字的报告切成 4 篇
（每篇 4000–6000 字，这是完成率最高的区间）。

`--drop-header` 丢掉正文开始前的报告式页眉（`Research Note` / 副标题 / 元信息 chips）。
**报告页眉在公众号里是劝退**——前 3 秒看到的是元信息而不是观点，开篇位置应该让给钩子。

转换器会自动做这些事（都是被微信剥掉的东西）：
- 剥 `<style>`/`class`，全部改内联样式；深色主题 → 浅色主题
- `header`/`footer` 语义标签打平为 `div`（否则连样式一起丢）
- 站外 `<a href>` 降级为带色文本（微信会剥链接，留着就是死链）
- ≥5 列的表替换成 `%WIDE_TABLE_xx%` 占位符，另存可渲染的 HTML

### ② 读骨架，产出编辑计划

先用 `outline.py` 的思路导出每篇的标题层级与段落长度，然后**人工撰写**编辑计划：

```json
{
  "series": "商业智能体的「载体」之争",
  "parts": [
    {
      "n": 1,
      "title": "……①：窗口正在溶解",
      "digest": "摘要，≤120 字",
      "cover": "aces_cover1.png",
      "hook": ["先问你一个问题：……", "三家巨头，三种动作，指向同一件事——<b>窗口正在溶解。</b>"],
      "points": ["看点一", "看点二", "看点三"],
      "titles": [["先拆概念", "先拆概念：「载体」其实是四件事"]],
      "summary": ["小结一", "小结二", "小结三"],
      "next": "第 ② 篇：<b>价值在往哪里迁移</b>——……",
      "tables": {"%WIDE_TABLE_01%": "tables/wide_p1_wide_table_01.png"}
    }
  ]
}
```

见 `plan.sample.json`。**计划是智能体唯一需要「创作」的部分**，引擎负责套用。

### ③ edit

```bash
python $T/gzh.py edit --plan plan.json --parts out
```

自动做四件事：
- 标题改写 + 篇内顺序编号 `01 ▍`
- **长段拆短**：>140 字的段落按句号拆到 ≤100 字（只在标签深度 0 处切，保证 `<b>` 不被截断）
- 追加「本文看点」卡与篇末三件套（小结/预告/引导）
- 表 ≥3 张时自动标注「可横屏查看」

### ④ tables / ⑤ cover

```bash
python $T/gzh.py tables --parts out
python $T/gzh.py cover --prompt "……" --ratio 16:9 --resolution 2k --prefix aces_cover1
```

### ⑥ push / ⑦ publish

```bash
python $T/gzh.py push --plan plan.json --parts out --assets <封面图目录> --dry-run
python $T/gzh.py push --plan plan.json --parts out --assets <封面图目录>
python $T/gzh.py publish <media_id>
```

`--dry-run` 先空跑一遍，确认封面、占位符、字数都对，再真推。

## 多账号

```bash
python $T/gzh.py account add <别名> --appid wx... --secret ... --label "备注"
python $T/gzh.py account list
python $T/gzh.py account use <别名>
python $T/gzh.py account check
```

账号存在 `<DSH_HOME>/wechat-publisher/accounts.json`（可用 `GZH_HOME` 覆盖）。
**不在 skills 目录内**，避免被打包发布时带出去。token 缓存按 appid 分桶，换号不串。

## 写文章时的判断依据

**报告体 → 公众号体的六个改造点**（少一个都会掉完成率）：

| 改造点 | 为什么 |
|---|---|
| 冲突式开篇 | 前 3 秒决定读者去留；「核验日期/信源数量」是报告式开场，抓不住人 |
| 本文看点卡 | 消除「这值不值得读」的犹豫 |
| 观点式标题 | 编号小标题像在读目录，没有点击欲 |
| 长段拆短 | 手机上 >150 字一段会挤成 8–10 行，视觉疲劳 |
| 表格导读/转图 | 读者遇表即走；宽表必须转图 |
| 篇末三件套 | 读完有收口，且被拽向下一篇 |

**拆篇原则**：单篇 4000–6000 字。超过 8000 字就该拆。

## 排障

见 `PITFALLS.md`（每一次踩坑的实测记录与判据）。
其中最要命的三条：**Chrome 在沙箱下起不来**、**`40164` 是 IP 白名单不是凭证错**、**`48001` 看是哪个接口被拒来判断账号类型**。

## 作为「智能体」运行

本能力同时以 **DSH 智能体预设**的形式提供：`$DSH_HOME/.agent-presets/gzh-publisher/`
（显示名「公众号主编」）。预设里有 persona（编辑方法论 + 铁律）与工具挂载，
`SUPER AGENTS` 列表里能看到並直接拉起。

预设与技能的分工：

| | 技能（本目录） | 智能体预设 |
|---|---|---|
| 作用 | 工具链 + 方法论 + 坑台账 | persona + 工具挂载 |
| 谁用 | 任何会话里的智能体 | 独立拉起的「公众号主编」 |
| 位置 | `$DSH_HOME/skills/wechat-publisher/` | `$DSH_HOME/.agent-presets/gzh-publisher/` |

改了工具链不必动预设；改了编辑方法论则两边都要看。

**校验预设**（写完必跑。宿主对不合格的预设**只标 broken 不弹错**；
而插件配置错误更隐蔽——它表现为「列表里看得见，点开被系统禁用」）：

```bash
python toolkit/verify_preset.py gzh-publisher
# 先跑对照组确认校验器本身没问题：
python toolkit/verify_preset.py secretary weather-reporter
```

三层校验缺一不可：

| 层 | 查什么 | 不通过的后果 |
|---|---|---|
| 1 组合结构 | 顶层是 plugin 行列表，每行有 `name` | 标 `broken`，列表里不显示 |
| 2 包是否安装 | 每个 `name` 能在 node_modules 找到 | 标 `broken`，列表里不显示 |
| 3 **插件配置** | 调插件自己的 `resolveConfig()` | **列表里显示，但报错被系统禁用** |

第 3 层宿主的发现逻辑**不做**，要到挂载时才校验——所以必须自己提前跑
（`toolkit/check_plugin_config.mjs`）。踩过的实例：漏了 `dsh-plan-mode` 的必填
`config.section`，直接导致智能体被禁用。
