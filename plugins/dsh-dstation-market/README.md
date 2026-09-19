# dsh-dstation-market

D-STATION 插件市场。给 DSH 的「设置 → 插件」加一个标签页，让你在界面里管理插件 ——
**装完插件之后能关掉它、能更新它、能把它打包送人**。

## 为什么需要它

DSH 原本装完插件就没有任何界面能管了：想停用一个插件要去手改 profile 的配置文件，
想更新要自己下载覆盖，想给别人要自己折腾打包。这个插件补的就是这块。

## 它做什么

| 能力 | 说明 |
|---|---|
| **列出已安装插件** | 认两条挂载通道（`dsh.profile.bundles` 与 profile 补丁里的 `insert` 行），外加落在 `plugins\` 但没挂上的 |
| **热停用 / 启用** | 写 profile 的 `cordis.patch.yml`，**约 2 秒生效，不用重启** |
| **卸载** | 删链接 + 注销启动清单。文件默认保留，方便重装 |
| **可下载列表** | 读市场的 `index.json`，一键安装 / 更新 |
| **OTA 更新与回滚** | 更新前完整备份，失败自动回滚；也可以手动回滚到任意历史版本 |
| **导出分发包** | 把任意插件打成「发给朋友就能装」的自包含安装包 |

### 热与冷的区别（很容易搞错）

- **停用 / 启用是热的**：改的是 `cordis.patch.yml`，那个文件有 live watcher。
- **安装 / 卸载 / 更新需要重启**：装载走的是**启动时读取**的 `dsh.profile.bundles`，
  改了它得等下次启动才生效。

界面上会明确提示这一点，不用记。

## 导出分发包

对任意「文件在盘上」的插件点「导出」（**受保护插件也能导出** —— 导出是只读操作），
填两项：

1. **给朋友看到的插件名**（会显示在他的界面上）
2. **朋友装完之后在哪里能看到效果**（会写进安装说明）

然后浏览器会下载一个 `<插件名>-<版本>-分发包.zip`。发给朋友，他：
**解压 → 双击「一键安装.cmd」→ 重启 DSH**。

包是自包含的：自带安装/卸载脚本、逐文件 sha256 清单，以及一份中文安装说明。
对方不需要命令行、不需要联网、不需要知道 DSH 装在哪。

安装脚本会在装之前拦下这些**坏包**（都是真出过事的）：

- 文件缺失或传输损坏
- 内容被改动过（与清单 sha256 不符）
- 声明了 `dsh.client` 但缺 `exports["./client"]` —— **这会让 DSH 直接起不来**

拦下来时不会留下半成品，profile 配置一个字都不会改。

## 安全边界

变更类接口（停用/启用/安装/卸载/更新/回滚/导出）都要求**本机回环 + 同源**：
请求必须来自 `127.0.0.1`，不带任何转发头，且 `Origin` 必须等于 `Host`。
本地自定义路由**没有 cookie 鉴权**，所以每个能改状态的端点都得自己把门。

`/export` 的 `pkg` 参数会被拼进文件系统路径，因此过了两道：
包名白名单正则 + 解析后的路径断言（必须仍在 `plugins\` 里面）。

## 接口

诊断用（GET）：

```
/dstation-market/health        存活与构建号
/dstation-market/state         完整清单（排障第一现场）
/dstation-market/catalog       市场可下载列表
/dstation-market/operations    长任务进度
/dstation-market/backups       某插件的历史备份
/dstation-market/source        市场源地址（可覆盖）
```

写操作（POST，需本机同源）：

```
/toggle        { entry, enabled }        热停用/启用
/install       { pkg }                   安装
/uninstall     { pkg, purgeFiles }       卸载
/update        { pkg }                   OTA 更新
/rollback      { pkg, backupId }         回滚
/remove-rows   { ... }                   清理补丁文件里的残留行
/restart                                 重启 DSH
/export        { pkg, displayName, where }  导出分发包（回 zip 字节）
```

## 文件

```
index.js       宿主半：路由、清单、补丁文件语义、重启
installer.js   安装/更新/回滚/备份（逐文件 sha256 + 暂存 + 自洽性闸门）
exporter.js    导出自包含分发包（纯 JS，不 fork 子进程）
client.js      浏览器半：两个标签页（已安装 / 可下载）
templates/     分发包里的脚本模板（install.ps1 / uninstall.ps1 / .cmd / 说明）
test/          离线测试（151 项）
```

零第三方依赖，只用 Node 内置模块。

## 测试

```bash
node test/run-tests.mjs
```

151 项，不需要起服务。其中值得单独一提的几条：

- **补丁文件语义**，尤其是「删掉最后一行会留下纯注释文件 → dsh 拒绝启动整个 profile」
  这个陷阱
- **路径穿越**：10 种写法的恶意 `pkg` 必须全部被 400 挡下
- **备份 ID 唯一性**：连续两次备份不能互相覆盖（否则「回滚到上一版」会拿到更早的版本）
- **漂移检测**：`exporter.js` 的 zip writer 与 Skill 侧的 `submit.mjs` 必须产出**逐字节相同**的包
  （两份实现是刻意分开的，这条测试是对冲代价）

## 许可

MIT
