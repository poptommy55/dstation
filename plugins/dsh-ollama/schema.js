/**
 * 极简 schema 工厂：**刻意不用 `@deepseek-ai/schemastery`**。
 *
 * 为什么（实测教训，来自上一个插件的返工）：
 *   插件真实路径在 `%DSH_HOME%\plugins\<plugin>\`，Node 沿真实路径向上解析依赖，
 *   而 `@deepseek-ai/*` 只存在于 app / profile 的 node_modules 里，**解析不到**。
 *   实测报错：`request for '@deepseek-ai/schemastery' is not in cache`。
 *   而它的失败**完全安静**：schema 拿不到 → `ctx.settings.register()` 没执行 →
 *   设置命名空间不存在 → 设置页那一行没有可解析的设置地址 →
 *   用户看到的现象是"设置里根本找不到这个模型"，而宿主侧注册看起来一切正常。
 *
 * 为什么自实现是安全的（读 dsh-settings 源码确认，不是猜）：
 *   `register()` 只把 schema 存下来，之后仅两处使用：
 *     · `resolve()`  → `schema(mergeLayers(base, section))`  只是把它当函数调用
 *     · `describe()` → `registration.schema.toJSON()`        只是序列化给设置页渲染表单
 *   **没有任何 instanceof / 类型校验**。
 */

function coerce(raw, def) {
  if (raw === undefined || raw === null) return def.default;
  switch (def.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === 'false' || raw === '0' || raw === 0) return false;
      return def.default;
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return def.default;
      if (typeof def.min === 'number' && n < def.min) return def.min;
      if (typeof def.max === 'number' && n > def.max) return def.max;
      return n;
    }
    case 'string':
    default:
      return typeof raw === 'string' ? raw : String(raw ?? def.default);
  }
}

function fieldToJson(def) {
  const meta = { default: def.default };
  if (def.description) meta.description = def.description;
  if (typeof def.min === 'number') meta.min = def.min;
  if (typeof def.max === 'number') meta.max = def.max;
  return { type: def.type, meta };
}

/**
 * 构造一个对象 schema。
 * @param fields - { 字段名: {type, default, description?, min?, max?} }
 */
export function objectSchema(fields) {
  const defaults = {};
  for (const [key, def] of Object.entries(fields)) defaults[key] = def.default;

  const schema = (data) => {
    const source = data && typeof data === 'object' ? data : {};
    const out = {};
    for (const [key, def] of Object.entries(fields)) out[key] = coerce(source[key], def);
    return out;
  };

  const dict = {};
  for (const [key, def] of Object.entries(fields)) dict[key] = fieldToJson(def);

  schema.toJSON = () => ({ type: 'object', meta: { default: defaults }, dict });
  schema.meta = { default: defaults };
  schema.type = 'object';
  schema.dict = dict;
  return schema;
}

/**
 * 校验并归一一个**局部补丁**（只含用户实际改动的字段）。
 *
 * 用途：把「界面改配置」经 HTTP 写回设置层时的把关口。之所以需要它，
 * 而不是直接把请求体丢给 settings.update()：
 *   · 未知字段必须**拒绝**（否则任何本地进程都能往设置里塞任意键）；
 *   · 类型要按声明归一（界面传来的是字符串，number/boolean 需要转换）；
 *   · 非法值必须**报错而不是静默取默认**（"改了没生效"比报错更难查）。
 *
 * @param fields - 与 objectSchema 相同的字段定义
 * @param patch - 待写入的部分配置
 * @returns { patch, rejected } — 归一后的补丁，以及被拒绝字段的原因
 */
export function validatePatch(fields, patch) {
  const out = {};
  const rejected = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { patch: out, rejected: { _: '请求体必须是对象' } };
  }

  for (const [key, raw] of Object.entries(patch)) {
    const def = fields[key];
    if (!def) { rejected[key] = '未知配置项'; continue; }
    if (raw === undefined) continue;

    switch (def.type) {
      case 'boolean': {
        if (typeof raw === 'boolean') { out[key] = raw; break; }
        if (raw === 'true' || raw === '1' || raw === 1) { out[key] = true; break; }
        if (raw === 'false' || raw === '0' || raw === 0) { out[key] = false; break; }
        rejected[key] = '需要布尔值';
        break;
      }
      case 'number': {
        if (raw === '' || raw === null) { out[key] = def.default; break; } // 清空 = 回默认
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) { rejected[key] = '需要数字'; break; }
        if (typeof def.min === 'number' && n < def.min) { rejected[key] = `不能小于 ${def.min}`; break; }
        if (typeof def.max === 'number' && n > def.max) { rejected[key] = `不能大于 ${def.max}`; break; }
        out[key] = n;
        break;
      }
      default: {
        if (typeof raw !== 'string') { rejected[key] = '需要字符串'; break; }
        out[key] = raw;
        break;
      }
    }
  }
  return { patch: out, rejected };
}
