---
name: aces-troubleshoot
description: ACES 技能故障排查与运维手册（KEY 位置排查、首次配置、更新/升级技能流程）。仅在 has_key() 为假、需要首次配置、或用户要求更新技能时读取。
---

# ACES 排障与运维手册

> **平时不要读本文件。** 只在下列三种情况读取：
> ① 一次调用验 KEY 得到 `False`（KEY 没配或配错了地方）；② 用户要首次配置；
> ③ 用户说「更新 / 升级 ACES 技能」。创作任务全程用不到本文件。

## 一、KEY 位置排查（has_key() 为假时看这里）

**.aceskey 的真实位置（2026-09-13 修正，原文档写错了）：**

客户端里写死 `KEY_FILE = os.path.join(SKILL_DIR, ".aceskey")`，即**只认本技能目录下那份**：

```
<本技能目录>/.aceskey        # 例如 %DSH_HOME%\skills\aces-system\.aceskey
```

判定方法（不要靠记忆，直接算）：

```python
import os, aces_client
print(aces_client.KEY_FILE)          # 这就是实际会读的路径
os.path.exists(aces_client.KEY_FILE) # 是否存在
```

**排查提示**：若存在多份 skill 目录（隔离的 DSH home 与本机用户级配置各一份），
KEY 很可能只配在其中一份里，而技能读的是另一份 → `api_key` 为空、`has_key()` 为假。
此时把已配置的那份 `.aceskey` **复制**到 `aces_client.KEY_FILE` 指向的位置即可（不要回显内容）。

## 二、首次配置（KEY 文件格式）

## 首次配置（KEY 安全，详见上方「强制前置检查」）

> 判断是否已配置 KEY 一律走上方「强制前置检查」铁律，不要在此重复判断。本节仅说明 `.aceskey` 文件格式细节。

1. `.aceskey` 文件位于**本技能目录下**（= `aces_client.KEY_FILE`，见上方「强制前置检查」里的实际路径），若缺失则用户尚未配置。
2. **不存在**时，不要要求用户对话粘贴明文 KEY。改为提示：
   > 请手动编辑文件 `<aces_client.KEY_FILE 的实际路径>`，写入你的 ACES 系统 KEY（每行一个 `key=value`）。格式见同目录 `.aceskey.example`。KEY 含调用额度，请勿外泄、勿提交到 git。
3. `.aceskey` 格式（每行 `key=value`）：
   ```
   api_key=你的ACES_KEY
   base_url=https://your-aces-gateway.example.com
   ```
   - `api_key`：必填，即你在 ACES 网页「我的 KEY」里看到的账户 KEY。
   - `base_url`：**必填**。本仓库不内置网关地址，换域名/测试服都在此改。
4. 文件权限应设为 600（创建后 `chmod 600`）。本 skill 不读取对话历史中的 KEY。

## 三、更新 / 升级本技能

## 🔧 如何更新本技能（用户可直接让 D-STATION 执行，无需走 PC 网页）

用户说「更新 ACES 技能 / 升级 ACES 技能 / 拉最新版」时，按本流程执行：

1. **下载**：从你所用 ACES 平台的技能分发地址取最新压缩包到临时目录。
2. **解压到本技能目录**（= `os.path.dirname(aces_client.KEY_FILE)`；目录不存在则创建）。
3. **🔴 .aceskey 保护（最高优先级）**：解压时**严禁覆盖用户已配置的 `.aceskey`**。
   - 若目标 `.aceskey` 已存在且**非空** → 跳过解压该文件（或先 `cp` 备份再还原），保住用户 KEY 不丢。
   - 仅当目标 `.aceskey` 不存在（首次安装）才从压缩包写入空模板。
   - 执行顺序建议：先解压除 `.aceskey` 外的全部文件；再判断目标 `.aceskey` 是否存在非空，不存在才写入压缩包里的 `.aceskey`。
4. **🔴 本地补丁保护**：本目录含**本地补丁**，官方 zip 不含，覆盖后必须重新打上（见下节「本地补丁记录」）。
   更新后请检查 `aces_save.py` 是否还在、`aces_client.py` 里是否还有判空补丁；缺失就按补丁记录重打。
5. **告知用户**：更新完成，**请新开一个会话**才能使新的 `SKILL.md` 生效（D-STATION 在会话启动时加载技能）。

> 说明：本流程与 ACES 网页「安装技能」按钮同源（同一 zip、同一目标目录），区别仅是**此处由 D-STATION 在对话中直接执行**，且强制保护 `.aceskey`。升级不会丢失用户的 KEY 配置。
