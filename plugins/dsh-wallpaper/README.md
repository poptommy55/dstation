# dsh-wallpaper

给 DSH Web GUI 换**窗口背景**：纯色 / 渐变 / 图片壁纸，并让侧栏与卡片半透明以透出背景。

入口在 **设置 → 通用 → 「窗口背景」**，与官方自带的「外观」「正文字号」并排。

- 零运行时依赖（只用 Node 内置模块）、零构建步骤
- 不上传任何数据，壁纸只存在你自己的 `%DSH_HOME%\wallpapers\`
- 带 69 项离线测试：`node test/run-tests.mjs`（不需要起 DSH）

---

## 安装（把这整个文件夹发给别人，对方执行一条命令）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会做四件事（幂等，可重复执行）：

1. 把本包复制到 `<DSH_HOME>\plugins\dsh-wallpaper`
2. 在 `<DSH_HOME>\profiles\<profile>\node_modules\` 下建 junction
3. 把 `dsh-wallpaper` 追加进该 profile `package.json` 的 `dsh.profile.bundles`
   —— profile 启动时会自动合并本包自带的 `cordis.patch.yml`，
   **不需要手工编辑任何 profile 文件**
4. 若 profile 里还留着旧的**手动 mount 行**，给出警告（那会导致双重挂载、启动失败）

然后**重启 `dsh web`**（宿主半不热重载，见下）。

可选参数：`-Profile web`（默认 web）、`-DshHome "D:\path\to\home"`。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1            # 保留壁纸文件
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData # 连壁纸一起删
```

**另一条安装路径**（官方 CLI，需要 npm 上能取到该包）：

```sh
dsh plugin --profile web add dsh-wallpaper
```

两条路效果相同 —— 后者会拿 `dsh.bundle.patch` 与 `dsh.profile.bundles` 对账并自动挂载。
⚠️ **不要两条路同时用**：`install.ps1` 的手工 junction 与 pnpm 装出来的目录会撞车。

---

## 排障入口

```powershell
# 存活 + 构建号
curl http://127.0.0.1:3080/dsh-wallpaper/health

# 排障第一现场：配置、字段定义、已存壁纸、两份浏览器侧上报
curl http://127.0.0.1:3080/dsh-wallpaper/status
```

`/status` 的 `reports` 分两个槽（互不覆盖）：

- `reports.probe` —— **宿主注入的探针**（不依赖客户端模块是否加载）报回的
  浏览器**计算值**：各 `--dsw-*` 令牌的实际取值、侧栏的计算背景色、
  谁声明了这些令牌、以及客户端模块跑到了哪一步（`clientPhase`）
- `reports.client` —— 客户端模块自己报的状态（`ready` / `saved` / `error`）

**遇到"改了没生效"先读这里，不要靠猜。**

---

## 它和 DSH 自带功能的边界

DSH 自带 `@deepseek-ai/dsh-client-ui-theme`，已经提供：

| 已有 | 说明 |
|---|---|
| 明 / 暗 / 跟随系统 | 设置 → 通用 → 「外观」 |
| 正文字号 12–17px | 同一分区 |
| 整套 `--dsw-*` 设计令牌 | 挂在 `body` 与 `body[data-ds-dark-theme]` 上 |

**它没有**：自定义颜色、背景图、壁纸、任意配色。本插件补的就是这一块。

---

## 三个设计决策（都有原因，改代码前先读）

### 1. 背景走**宿主首屏注入**，不是等客户端加载完再改

第一帧就要带壁纸，否则每次开页面都会先闪一下没有壁纸的界面。

宿主监听 `webserver/index-inject`，往 `<head>` 塞一个
`<style id="dsh-wallpaper-boot">`；客户端加载后再把自己那份 CSS 写回**同一个元素**。

> 为什么不用官方扩展点 `ctx.theme.overrideTokens()`：它只在客户端加载后生效，
> 必然闪一下。DSH 自己的主题为了同样的原因也是走宿主注入
> （见 ui-theme 的 `bootThemeInjection`），本插件与官方保持同一条路径。

### 2. 令牌覆写的选择器是 `html body`，不是 `body`

官方声明的就是 `body{--dsw-alias-bg-base:…}`。**同特异性下由文档顺序决定胜负**，
而官方那几张样式表是客户端插件运行时 `appendChild` 进 `<head>` 的，
位置一定晚于宿主首屏注入的这段。

用后代选择器把特异性提到 `(0,0,2)` / `(0,1,2)`，就与文档顺序无关了。

### 3. 颜色按「原色令牌 + 半透明」合成，不硬编码色值

```css
--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 55%, transparent)
```

引用的是官方调色板变量本身 ⇒ 官方换配色时本插件自动跟着对。
（`color-mix()` 在 DSH 自己的 CSS 里已在用，兼容性没问题。）

**透明度偏移量要按计算后的实际 alpha 验收，不能只看滑杆数字** ——
第一批偏移写得太保守（+12/+22/+26），滑杆 60 时侧栏实际是 72% 不透明，
叠在深色照片上肉眼看不出差别，被用户当场判为"没生效"。

---

## 安全边界

宿主自定义路由**没有 cookie 鉴权**（只有 `/api` 前缀有），所以：

- **上传，而不是让用户填路径**：图片字节经宿主校验后存进
  `%DSH_HOME%\wallpapers\files\`，**文件名由宿主按内容哈希生成**
  ⇒ 用户提供的任何路径都到不了文件系统，天然没有穿越面。
- 只按**魔数**认图片（png/jpg/webp/gif/bmp），不信任扩展名、不信任 Content-Type。
- 取图路由的文件名必须匹配 `^[0-9a-f]{40}\.(png|jpg|gif|bmp|webp)$`，再加 `basename` 双保险。
- 请求体限长（上传 24MB / 配置 64KB）。
- 配置写入过白名单：**未知字段拒绝、类型归一、非法值报错而不是静默取默认**。
- 配置先写临时文件再 `rename`，避免半截 JSON。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-wallpaper/health` | 存活 + 构建号 |
| GET | `/dsh-wallpaper/status` | **排障第一现场**：配置、字段定义、已存壁纸、客户端/探针上报 |
| GET/POST | `/dsh-wallpaper/config` | 读 / 写配置（**同一条路由**，靠 `req.method` 分派） |
| GET | `/dsh-wallpaper/style.css` | 由配置生成的 CSS，客户端与首屏注入共用这一份实现 |
| POST | `/dsh-wallpaper/upload` | 原始图片字节 → 内容寻址落盘 |
| GET | `/dsh-wallpaper/file/<name>` | 取已存壁纸 |
| POST | `/dsh-wallpaper/report` | 浏览器侧把读数报回来 |

### 排障：`GET /dsh-wallpaper/status` 的 `clientReport`

浏览器侧我看不见，所以页面里注入了一段探针，加载后会把**浏览器的真实读数**
报回宿主：计算后的自定义属性值、谁声明了这些令牌、body/html 的内联样式、
侧栏的计算背景色、以及客户端模块跑到了哪一步（`clientPhase`）。

**遇到"改了没生效"先读这里**，不要靠猜。

---

## 已知边界

- **设置行组件只在设置面板打开时才挂载**。所以页面刚加载时
  `clientPhase` 会停在 `apply:ok`、`clientCssChars` 为 `none`，
  这是正常的 —— 页面加载阶段完全由宿主注入那份 CSS 负责。
- 改 **宿主半（index.js）需要重启服务**；改客户端半（client.js）会热重载。
  Node 的 ESM 缓存按 URL 记住模块，插件树重载不会重新 import 它。
- 半透明会降低文字对比度，靠「背景压暗」补偿；没有做毛玻璃（`backdrop-filter`），
  因为要给官方那些带哈希类名的表面挂样式，太脆。
- **两处同时挂载会启动失败**：profile 的 `cordis.patch.yml` 手写 mount 行
  与 `dsh.profile.bundles` 通道只能二选一，否则宿主半注册两次同名路由，
  报 `webserver: duplicate exact route "/dsh-wallpaper/config"`。
- **令牌兜底不是可选的**：`color-mix(in srgb, var(--dsw-static-x) N%, transparent)`
  里的 `var()` 一旦解析失败（官方改令牌名），整条声明会变成
  invalid at computed-value time ⇒ 自定义属性退化成 guaranteed-invalid ⇒
  用它的 `background` 回落到 initial = **全透明**，面板直接消失。
  所以每个 `var()` 都写了 `, #hex` 兜底；测试里有一条断言专门盯这个。
- `engines.dsh` 声明的是**实测过的版本线** `>=0.1.2-rc.1 <0.2.0`。
  插件依赖若干 DSH 内部契约（`webserver/index-inject` 事件、
  `ctx.webServer.register` 的 `(kind,path)` 唯一性、`settings.general.item`
  是 `settings.section` 的子槽位、`--dsw-*` 令牌名、`body[data-ds-dark-theme]`），
  **换 DSH 大版本要重新验证**。

---

## 开发

```powershell
node test/run-tests.mjs     # 69 项，不需要起服务
```

不要用 `node --test test/`（子进程管道会被沙箱拦，见 dsh-plugin-dev 坑 #10）。

真实路径：`%DSH_HOME%\plugins\dsh-wallpaper\`（profile 里是 junction）。

> ⚠️ 本包的 `.ps1` 脚本**刻意全部用 ASCII 写**：Windows PowerShell 5.1 读
> **无 BOM 的 UTF-8 `.ps1`** 会按 ANSI 解码，把非 ASCII 文本弄乱。
> 改脚本时请保持 ASCII。
