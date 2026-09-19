# 坑清单（全部为实测，附判据与错误原文）

> 原则：**每条坑都要留下「怎么认出来」的证据**，否则下次还是一样卡住。

---

## 坑 #1 · Chrome 在沙箱下根本起不来（最要命）

**现象**：宽表渲染失败，`subprocess` 无声返回、没有 PNG、`$LASTEXITCODE` 是空的。

**错误原文**：
```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: 拒绝访问。 (0x5)
[ERROR:crashpad_client_win.cc:421] OpenProcess: 拒绝访问。 (0x5)
crash server failed to launch, self-terminating
```

**根因**：Chrome 多进程架构用**命名管道**做内部 IPC（Mojo），而 DSH 沙箱禁止命名管道。

**已排除的其他可能**（换一个也没用，别浪费时间）：
- 换 `Start-Process` → `Access is denied`
- 换 `cmd /c` → exit `-36863`，无 PNG
- 换 Edge → 同样失败
- 换 playwright `chrome-headless-shell` → 同样 `Mojo platform_channel 拒绝访问`
- 换 `--no-sandbox --disable-crash-reporter` → 无效

**判据**：错误里出现 `Mojo` 或 `platform_channel` 或 `crashpad` → **这就是沙箱边界，不是命令写法问题**。
唯一解：提升到 `danger-full-access`。渲染宽表前先确认会话权限。

---

## 坑 #2 · 管道会伪装成「程序被禁止执行」

**现象**：`python foo.py | Select-Object -First 8` 报
```
Program 'python.exe' failed to run: Access is denied
CategoryInfo: ResourceUnavailable ... NativeCommandFailed
```
看起来像 python 被禁了，**其实是管道触发的**。

**对照实验**（决定性）：同一条命令加管道 → 失败；不加管道 → 正常。
连 `python --version` 加管道都会失败，可见与具体程序无关。

**判据**：报错说某个 exe 无法运行，但**同一条命令不加管道就能跑** → 是管道问题。

**处理**：诊断时把输出重定向到文件再读，不要用管道。

---

## 坑 #3 · 系统代理存在但没在跑，会拖死所有出网请求

**现象**：所有 URL 请求失败；`Invoke-WebRequest` 报「基础连接已经关闭」。

**判据**：
```powershell
Get-NetTCPConnection -LocalPort 7890 -State Listen   # 无监听 → 代理没跑
$env:HTTP_PROXY                                       # 但仍指向它
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'  # ProxyEnable=1
```
环境变量 + 注册表都指向一个**死掉的**代理。

**处理**：`gzh_api.py` 默认用 `ProxyHandler({})` **绕过系统代理**（微信接口国内可直连）。
确需走代理时设 `MP_PROXY=http://host:port`。

> ⚠️ 注意：Python 的 `urllib` 在 Windows 上**会读注册表代理**，光清环境变量不够，必须显式用 `ProxyHandler({})`。

---

## 坑 #4 · `40164` 是 IP 白名单，不是凭证错误

**错误原文**：
```
errcode=40164 errmsg=invalid ip <your-public-ip> ipv6 ::ffff:<your-public-ip>, not in whitelist
```

**判据**：`40164` → **AppID/Secret 那一关已经过了**（否则是 `40013`/`40125`），纯粹是 IP 没加白。

**处理**：后台「设置与开发 → 开发接口管理 → IP 白名单」加上 errmsg 里那个 IP。
**errmsg 会直接告诉你微信看到的出口 IP**，不必另外查。

**注意**：`<your-public-ip>` 看着是动态分配的（移动宽带）。报 `40164` = IP 变了，重跑看新 IP。
**不同公众号的白名单互相独立**——AIKIDSLAB 不用加，中晟科悦必须加。

---

## 坑 #5 · `48001` 看是「哪个接口」被拒，才能判断账号类型

| 被拒范围 | 结论 |
|---|---|
| 连**素材库**都拒 | 账号**没做微信认证** → 基本没戏 |
| 素材库/草稿箱可以，**发布接口**拒 | 订阅号或**未认证服务号** → 能推草稿，不能 API 直发 |
| 全都可以 | **已认证服务号** → 全自动 |

**关键认知：「服务号」这个身份本身不给权限，「微信认证」才给。**

实测的两个号：

| 账号 | 类型 | 素材库 | 草稿箱 | 发布 |
|---|---|---|---|---|
| AIKIDSLAB | 订阅号/未认证服务号 | ✅ | ✅ | ❌ |
| 中晟科悦 | **服务号**（企业主体） | ❌ | ❌ | ❌ |

中晟科悦是服务号却被全拒 → 它**没认证**。别被「服务号」三个字误导。

---

## 坑 #6 · 换账号时不删 token 缓存会串号

`access_token` 与 `appid` 严格绑定。缓存是按「一个 token」存的，换号后仍读旧缓存 →
拿 A 号的 token 打 B 号的接口，必然失败且报错难懂。

**已修**：`gzh_api.py` 的 token 缓存按 `appid` 分桶，取之前校验 appid 一致。
手工换号时仍建议清一次。

---

## 坑 #7 · `/cgi-bin/draft/add` 的「2 万字符」限制按**可见文字**计，不是 HTML

官方文档只写「content 必须少于 2 万字符」，没说清按什么计。

**实测数据**（决定性）：

| 篇 | HTML 字符 | 可见字数 | 结果 |
|---|---|---|---|
| 上 | 18690 | 4451 | ✅ |
| 中 | **53698** | 10122 | ✅ **通过** |
| 下 | 22160 | 4760 | ✅ |

HTML 长达 53698 字符仍然成功 ⇒ **限制按可见正文文字计**。

**教训**：我一度以为按 HTML 计，差点把 18 个表格全改成图片来压缩字符数。
**先做一次最小实测，比读文档和猜都便宜。**

---

## 坑 #8 · 正文图片硬限制 1MB，封面没有

- `media/uploadimg`（正文图片）：**单图 ≤ 1MB**，超了直接拒
- `material/add_material`（封面/永久素材）：上限宽松得多（10MB 级），2.6MB 封面可直接传

**处理**：`render_tables` 内置降质循环（PNG → JPEG 92→64 质量、尺寸 1.0→0.6 倍）保证达标。

---

## 坑 #9 · ACES 的 `text_to_image()` 只返回 taskId，直接接 `submit_and_wait()` 会重复提交

```python
def text_to_image(self, prompt, ratio, resolution):
    nodes = [...]
    return self.run(IMG_WEBAPP, nodes)      # ← 只返回 taskId

def submit_and_wait(self, webapp_id, node_info_list, ...):
    task_id = self.run(webapp_id, node_info_list)   # ← 内部又 run() 一次！
```

**后果**：`tid = c.text_to_image(...)` 之后若再调 `submit_and_wait(...)` → **提交两次，白烧一次额度**。

**正确做法**：自己 `run()` 提交 → **立刻落盘 taskId** → 轮询 `query()` 到终态。
`gzh_media.make_cover()` 已按此实现。
（落盘 taskId 很重要：ACES 没有任务列表接口，丢了 id 就等于白烧一次额度。）

---

## 坑 #10 · 工具链自身的两个 bug（写代码时埋的，已修）

| bug | 症状 | 根因 |
|---|---|---|
| `width:100%%` 漏进输出 | 表格宽度失效 | 模板串里写了 `%%` 却没做 `%` 格式化 |
| `.lead` 样式三重嵌套 | 版式崩坏、三重边框 | 外层 `div.lead` 与内层 `<p>` 都被刷了高亮块样式 |

还有一个**隐蔽的**：用 `next(iter(cls))` 从 class 集合里取一个元素当父级标识——
`set` 迭代顺序不确定，`.box.ok` 可能取到 `"ok"` 而非 `"box"`，导致 `.box .t` / `.card .h`
的父级判定随机失灵。**已改为传递完整的父级 class 集合。**

> 通用教训：判断「我的父元素是谁」时，永远传**集合**，不要传从集合里随手取的一个元素。

---

## 坑 #11 · `freepublish/*` 未授权时，查不到「已发布列表」

`freepublish/batchget` 与 `submit` 是同一套权限。这个号没发布权限 → **也查不了发布记录**。

**后果**：草稿箱里少了一篇，无法用 API 判断是「已发布」还是「被删除」。
**只能让用户去后台「发表记录」人工核对。** 推草稿时要提醒这一点。

---

## 坑 #12 · 公众号编辑器剥掉的东西（转换器必须处理）

| 被剥掉 | 处理 |
|---|---|
| `<style>` 块、`class` | 全部改内联 `style=` |
| `header` / `footer` 语义标签 | 打平为 `div`（否则连样式一起丢） |
| 站外 `<a href>` | 降级为带色 `span`（留着就是死链） |
| `grid` / `flex` / `::before` | 打平成块级元素 |
| 无属性的 `<span>` | 直接打平 |

**转换后自检**：`gzh.py convert` 会自动跑净化体检，残留任何一项都会告警。

---

## 坑 #13 · 切篇关键词带空格会**静默**匹配不上

**现象**：`--split-at "3. 价值在往哪里迁移" "谁吃到钱" "4. 载体形态"` 期望切 4 篇，
实际只切出 2 篇——**不报错，只是结果不对**。

**根因**：标题文本经 `strip_tags()` 后**所有空白都被去掉**
（`"3. 价值在往哪里迁移"` → `"3.价值在往哪里迁移"`），而关键词里的空格还在 → 匹配失败。
只有不带空格的 `"谁吃到钱"` 命中了。

**已修**：比较时两边都做空白归一化，用户写带不带空格都行。

> 通用教训：**「静默不匹配」比报错危险得多。** 凡是字符串匹配的开关，都要先归一化再比，
> 并且最好在结果数量不符时给出提示。

---

## 坑 #14 · 报告式页眉必须显式丢弃

源报告开头是：
```
Research Note · 实证调研
基于 2026 年 8–9 月一手信源的调研。所有事实性判断均标注可核验来源……
[核验日期 2026-09-18] [信源 60+ 一手页面] [覆盖 103 个在运营 Agent 产品] …
```

这段在报告里是规范，在公众号里是**劝退**——读者前 3 秒看到的是元信息而不是观点。

**处理**：`gzh.py convert --drop-header`，定位第一个 `.lead` 块或第一个 `h2`，
之前的内容整体丢弃，开篇位置让给冲突式钩子。

**回归验证**：不丢页眉时第①篇 5022 字，丢掉后 4906 字，与手工成果**完全一致**。

---

## 坑 #15 · 量「最长段落」时正则别写成 `<p`

`<p[^>]*>` 会匹配到 `<pre style="...">` 里面的 `p`（`<p` + `re style=`），
于是代码块被当成一个 481 字的超长段落，看起来像「拆段失败」。

**正确写法**：`<p style="([^"]*)">`（要求 `<p` 后紧跟空格），或直接用 DOM 解析。
`gzh_edit.split_long_paragraphs()` 用的就是前者，所以它一直是对的——
**是测量脚本错了，不是引擎错了。**

---

## 坑 #16 · 「静默成功」比报错更危险

**现象**：端到端 dry-run 时，宽表图片路径找不到、占位符 `%WIDE_TABLE_01%` **没被替换**，
脚本却照样打印：

```
⚠️ 仍有未替换的占位符，微信里会显示成乱码文本
...
成功 4 / 4          ← 这是在骗自己
```

推上去读者看到的是 `%WIDE_TABLE_01%` 这串乱码，但流程"成功"了，没人会去查。

**已修**：占位符残留 = **本篇失败**，打印残留清单 + 指出图片该放哪，并让整体退出码非 0。

> 通用教训：**「降级警告 + 继续成功」是危险组合。**
> 凡是会导致「推上去就烂掉」的问题，都必须升级为失败，而不是 warning。
> 验收标准要按「读者看到什么」来定，不是按「脚本跑没跑完」来定。

---

## 附：素材路径的约定

`push` 按以下顺序查找封面与宽表图片，**放对位置就不用每次传 `--assets`**：

```
<--assets 指定目录>  →  <parts>/  →  <parts>/img/  →  <parts>/tables/
  →  <cwd>/  →  <cwd>/aces-output/
```

推荐布局：宽表图放 `<parts>/img/`，ACES 封面放 `cwd/aces-output/`（ACES 默认落盘位置）。

---

## 坑 #17 · 校验器必须拿「已知可用」的样本做对照组

**现象**：写完智能体预设后，我自制的校验器报：

```
预设：gzh-publisher
  ❌ 插件包 24 个，全部已安装
      缺失：cordis:group
```

看起来是预设写坏了。**但把已知可用的 `secretary` 丢进同一个校验器，报了一模一样的错**：

```
预设：secretary
  ❌ 插件包 22 个，全部已安装
      缺失：cordis:group
```

⇒ **是校验器错了，不是预设错了。** `cordis:group` 是 cordis 内置构造，不是 npm 包，不该参与
「包是否安装」的检查。

**做法**：任何自制校验器，动手判别人的东西之前，**先拿一个已知合格的样本跑一遍**。
对照组不通过 = 校验器有问题；对照组通过、目标不通过 = 目标真有问题。
没有对照组的校验器，给出的结论不可信——这次它差点让我去"修"一个完全正确的预设。

---

## 坑 #18 · 智能体预设静默不显示，先查这两条

`SUPER AGENTS` 列表里看不到新预设时，宿主会把它标成 `broken` 但**不弹错**。宿主只查两件事：

1. **组合结构**：`agent.cordis.yml` 必须是「顶层 plugin 行列表」，每行是带 `name` 字符串的 map；
   `group: true` 的行要递归检查其 `config`
2. **包是否安装**：每个 `name` 指向的包必须能在 `node_modules` 里找到（带 `:` 前缀的内置构造除外）

用 `toolkit/verify_preset.py` 本地先跑一遍，别等宿主静默跳过。

**另外两条容易忽略的**：

- 预设目录必须在 `$DSH_HOME/.agent-presets/<id>/`，且**目录名就是预设 id**；
  `preset.yml` 只承载显示文本（`name` / `description` / `order`），不含 id、不含 trust。
- `trust` 由**根目录**决定，不由文件内容决定：`.agent-presets/` 下的自动是 `trust: 'user'`
  （才进 SUPER AGENTS），随部署发行的 `presets/` 目录是 `trust: 'system'`。
  **不要试图在 preset.yml 里写 trust**——写了也没用。

**不需要重启**：花名册是「每次读取时」动态构建的，已挂载的预设按 composition 文件的
mtime 增量重挂载。刷新页面即可。

---

## 坑 #19 · 「发现通过」≠「挂载成功」——插件必填配置只在挂载时校验

**现象**：智能体在列表里但**报错被系统禁用**。用宿主自己的发现逻辑查，却报 `✅ OK`：

```
✅ OK  gzh-publisher  trust=user  公众号主编
```

**根因**：宿主的「发现」只做两件事——组合结构 + 包是否存在。**插件自身的配置校验要到
`mount` 阶段才跑**。我漏了 `dsh-plan-mode` 的必填配置：

```yaml
- id: plan-mode
  name: '@deepseek-ai/dsh-plan-mode'
  # ← 少了 config.section
```

而 `dsh-plan-mode` 的 `resolveConfig()` 写得很死：

```js
const section = config.section;
if (typeof section !== "string") throw new Error("PlanModeConfig needs a string `section`");
if (section.trim() === "") throw new Error("PlanModeConfig needs a non-empty `section`");
const unknown = Object.keys(config).filter((k) => k !== "section");
if (unknown.length > 0) throw new Error(`PlanModeConfig has unknown key(s) ...`);
```

抛异常 → 挂载失败 → 智能体被禁用。

**判据**：`发现 OK` 但 `挂载失败` ⇒ 一定是**某个插件的配置**问题，不是组合结构问题。
去查该插件源码里的 `resolveConfig` / schema。

**修复**：补上 `config.section`。这段是**部署级通用引导语**，原样取自已验证可用的
`commodities-desk`，不要自创措辞。

**校验工具**：`toolkit/check_plugin_config.mjs` —— 对每一行调用插件自己的 `resolveConfig()`
（若导出），把挂载阶段会跑的代码提前跑一遍。已用负向对照证明它能抓到本 bug：

| 用例 | 结果 |
|---|---|
| plan-mode 不带 config（原 bug 写法） | ❌ 被抓住 |
| section 只有空白 | ❌ 被抓住 |
| section 正常但多一个未知字段 | ❌ 被抓住 |
| section 正常 | ✅ 通过 |

一条命令跑完三层校验：`python toolkit/verify_preset.py <预设id>`

---

## 坑 #20 · PowerShell 写 JSON 会加 BOM，Node 的 `JSON.parse` 会炸

**现象**：

```
SyntaxError: Unexpected token '﻿', "﻿[{"id":"p"... is not valid JSON
```

看着像 JSON 文件内容坏了，其实只是**开头多了个 BOM**。

**根因**：Windows PowerShell 5.1 的 `Out-File -Encoding utf8` / `Set-Content -Encoding utf8`
**默认写 BOM**。Node 的 `JSON.parse` 不认 BOM。

**处理**（二选一）：
- 写文件时用无 BOM 编码：`[System.IO.File]::WriteAllText($p, $json, (New-Object Text.UTF8Encoding $false))`，
  或干脆用 Python 的 `open(p, "w", encoding="utf-8")`
- 读文件时兜底：`readFileSync(p, 'utf8').replace(/^\uFEFF/, '')`

`check_plugin_config.mjs` 已加兜底，两种写法都不会再翻车。

> 通用教训：**跨 PowerShell / Node / Python 传文件时，编码是默认的踩坑点。**
> 报「JSON 语法错误」而肉眼看着正常时，先查 BOM。



