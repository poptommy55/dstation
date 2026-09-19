---
name: aces-patches
description: ACES 技能本地补丁台账（原 SKILL.md「本地补丁记录」）。仅在用户要求更新/升级技能、或需要确认补丁是否在位时读取。
---

# ACES 本地补丁台账

> 用途：官方 zip 每次覆盖后，这些本地补丁需要重打。**平时不要读本文件**——
> 每次技能启动注入本文件等于白白烧 token。仅以下两种情况才读：
> ① 用户说「更新/升级 ACES 技能」；② 怀疑某条补丁丢失、需要核对。
> 快速自检（一条命令，无需读本文件）：
> ```
> python -c "import sys;sys.path.insert(0,r'<repo-root>\build\dist\home\skills\aces-system');import aces_client as a;print('RATIO',a.VIDEO_RATIO_NODE);print('HASKEY_BOOL',type(a.ACESClient.from_keyfile().has_key()).__name__)"
> ```

## 🩹 本地补丁记录（官方 zip 不含，更新后需重打）

补丁的起因、改法与验证方式记在这里，避免"更新一次就丢一次、下次又从头查"。

### 补丁 1：`aces_save.py`（新增文件，落盘模块）

- **起因**：创作接口只返回远端 URL，不落盘；宿主预览链路需要本地绝对路径。
- **内容**：`save_outputs()` / `print_paths()` / `extract_task_id()` / `resolve_out_dir()`。
- **丢了怎么办**：这一段是纯新增文件，如果被 zip 覆盖删掉，按本 SKILL.md
  「🔴🔴 生成物必须落盘到工作区」一节的用法重写即可（逻辑很短，不依赖任何第三方库）。

### 补丁 2：`aces_client.py` 的 `DefaultGatewayAdapter.run()` 判空

- **起因**：网关有时返回 `"data": null`，原写法 `res.get("data", {}).get("taskId")`
  会抛 `AttributeError: 'NoneType' object has no attribute 'get'`，表现为一提交就崩、拿不到 taskId。
- **改法**：显式取出 `data` 并 `isinstance(data, dict)` 判空后再取 `taskId`。
- **丢了怎么办**：在 `run()` 里搜 `res.get("data", {})`，按同样方式改成判空即可。

### 补丁 3：本文档内的路径与流程修正

- KEY 路径由过期的 `~/.workbuddy/skills/...` 改为**运行时由 `aces_client.KEY_FILE` 推导**。
- 新增「生成物必须落盘到工作区」一节。
- **丢了怎么办**：这三处是文档级修正，重读一遍本文档即可发现缺口（KEY 判定是否走实际路径、
  是否有落盘硬性要求、更新流程里是否有补丁保护）。

### 补丁 4：`aces_client.py` 的 `DefaultGatewayAdapter.upload()` 鉴权重试

- **起因**：网关对**上传端点**也会间歇性拒鉴权。实测 `/task/openapi/upload` 返回
  `HTTP 401 {"code": -1, "msg": "ApiKey verification failed"}`，
  而**同一 KEY 的文生图刚刚成功、且隔几秒重试上传 4/4 成功** → 属于间歇性，不是 KEY 失效。
  表现：文生图正常，但一上图生图/图生视频就整轮报废（`_ref()` 第一步就抛）。
- **改法**：把 `run()` 里已有的「只重试鉴权类拒绝」思路照搬到 `upload()`：
  401/403/含 `apikey` 的 `RuntimeError` 以及 `code in (301, 811)` 重试 4 次、每次间隔 2s；
  业务错误直接抛出，不重试（被拒的请求没有产生任务，重试不会重复提交）。
  顺带把原来 `res.get("data", {}).get("fileName")` 的写法改成 `isinstance(data, dict)` 判空
  （与补丁 2 同一类 `data: null` 崩溃）。
- **验证**：连续调用 `c.upload(png)` 四次，4/4 返回 `api/<hash>.png`。
- **丢了怎么办**：搜 `def upload(`，确认里面有 `for _attempt in range(4)` 的重试循环即可。

### 补丁 5：`aces_client.py` 的 `VIDEO_RATIO_NODE` 与比例取值（图生视频必坏项）

- **起因**：图生视频的「画面比例」节点信息全错，**不修就无法使用图生视频**。实测提交报：
  ```
  803 NODE_INFO_MISMATCH(nodeId=115, fieldName=aspect_ratio,
                         reason=node_not_found_in_workflow)
  ```
- **真身来源**：`get_app_info(VIDEO_WEBAPP)["data"]["nodeInfoList"]`（这才是权威节点表），得到：
  | 项 | 旧值（错） | 真值 |
  |---|---|---|
  | 比例节点 id | `115` | `150:5` |
  | 比例取值 | `16:9` | `16:9 (Widescreen)`（COMBO 下拉全称） |
  | 参考图 / 提示词 / 时长 | `114` / `149` / `152` | 未变，正确 |
- **改法**：`VIDEO_RATIO_NODE = "150:5"`；新增 `VIDEO_RATIO_MAP` 把用户友好的
  `"16:9"` 映射为 `"16:9 (Widescreen)"`（已是全称的原样透传），并在 `image_to_video()` 里
  提交前做一次 `map.get(...)`。
- **适用比例**：`1:1` / `2:3` / `3:2` / `3:4` / `4:3` / `9:16` / `16:9` / `21:9`。
- **排查方法论**：遇到 `NODE_INFO_MISMATCH` **不要猜节点**，一律先拉
  `get_app_info(webapp_id).data.nodeInfoList` 对照；该接口同时给出 `fieldData`（COMBO 选项全集），
  取值格式问题也一并可见。文生图/图生图/背景音乐的节点 id 本次核对无误。
- **丢了怎么办**：搜 `VIDEO_RATIO_NODE`，确认是 `"150:5"` 且 `image_to_video()` 里走了
  `VIDEO_RATIO_MAP`；缺了就用上面的 `get_app_info` 重新核对再改。

### 补丁 6：`aces_save.py` 的 `extract_task_id()` 支持裸字符串 taskId

- **起因**：`DefaultGatewayAdapter.run()` **成功时直接返回 taskId 字符串**
  （实测 `image_to_video()` 返回 `"2098947148363292673"`），而原 `extract_task_id()`
  开头就 `if not isinstance(raw, dict): return None`，对字符串一律返回 None。
- **后果（很贵）**：调用方看到「没拿到 taskId」，但**任务其实已经提交成功、正在跑**。
  既容易被误判为失败而重复提交（白烧额度），也可能因为没落盘 taskId 而丢掉任务。
  本次就是这么踩到的：第一次提交返回的裸 id 被当成 None。
- **改法**：补上 `str` 直通（strip 后非空即返回）、`int` 转字符串；
  dict 分支再兼容 `data` 本身是字符串/数字的情况；`taskId` 统一转成字符串返回。
- **验证**：`extract_task_id('209...')` → 原样返回；`{'data':{'taskId':'T1'}}` → `T1`；
  `{'data':None,'taskId':'T2'}` → `T2`；`{'data':None}` → `None`；`None` → `None`。
- **正确用法提醒**：`run()` 和 `image_to_video()` / `text_to_image()` 等**返回的就是 taskId**，
  落盘时直接 `str(task_id)` 即可，不要再无条件套 `extract_task_id`；
  只有网关异常形态（dict）才需要它兜底。更稳的写法：`tid = extract_task_id(raw) or (raw if isinstance(raw, str) else None)`。
- **丢了怎么办**：搜 `def extract_task_id(`，确认开头有 `isinstance(raw, str)` 直通分支。

### 补丁 7：`aces_client.py` 的 `DefaultGatewayAdapter.query()` 鉴权重试

- **起因**：`query()` 是**唯一还没打鉴权重试补丁**的端点，而它同样会被网关间歇性拒签。
  实测对**同一个早已 SUCCESS 的任务** taskId 连查 3 次，得到：
  `SUCCESS` / `811 CORPAPIKEY_INVALID` / `SUCCESS` —— 同一 KEY，间隔数秒，纯间歇性。
- **危害**：用户说「查 ACES 任务 <id>」时，若恰好撞上那一次拒签，单次查询会把
  「KEY 失效 / 任务异常」直接报给用户，而任务其实早就成功、产物就在那儿。
  （注：`submit_and_wait()` 的轮询本身**自愈**——被拒时 status 为空、不落终态、下一轮继续查，
  所以本补丁修的主要是**单次查询**这条对外路径，不会改变等待行为。）
- **改法**：照搬 `run()` / `upload()` 的思路，对 `code`/`errorCode` ∈ {301, 811, 401, 403000}
  或消息含 `apikey` 的响应重试 4 次（间隔 1.5s / 3s / 4.5s）；
  **只要已拿到真实 `status` 就立即返回**，非鉴权类业务错误也原样返回（不吞真实报错）。
- **验证**：同一 taskId 连查 8 次 → 8/8 `SUCCESS`、0 次鉴权泄漏；
  伪造 taskId `"1"` → 原样返回业务错误 `1004 Task not found`（确认业务错误未被重试吞掉）。
- **丢了怎么办**：搜 `def query(`, 确认函数体里有 `AUTH_REJECT` 与 `for attempt in range(4)` 循环。

### 补丁 8：`aces_client.py` 的 `has_key()` 返回 bool（凭证泄漏修复）

- **起因**：原实现 `return bool(self.api_key) and self.api_key.strip()` —— Python 的 `and`
  在左侧为真时**返回右侧的值本身**，所以 `has_key()` 返回的是**去空白的 KEY 明文**，不是 True。
- **后果**：任何一句诊断式 `print(c.has_key())` 都会把凭证原样打进对话记录、日志、截图。
  本次会话排查时就真实发生了（KEY 被打印进对话）。这不是理论风险，是已发生的事实。
- **改法**：`return bool(self.api_key and self.api_key.strip())`，显式 bool，真值语义不变
  （下游 `if c.has_key():` 全部照常工作）。
- **验证**：有 KEY → `True`（`type: bool`）；空 KEY → `False`；`ensure_key()` 仍照常抛指引且不含 KEY。
- **丢了怎么办**：搜 `def has_key(`, 确认函数体是 `return bool(self.api_key and self.api_key.strip())`。
  看到 `and self.api_key.strip()` 结尾（没有外层 `bool(...)`）就说明补丁丢了。
