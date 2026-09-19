// ==================== 技能导入（压缩包 / 松散文件） ====================
const SKILL_IMPORT_ZIP_MAX = 30 * 1024 * 1024;    // zip 原始字节上限
const SKILL_IMPORT_ENTRY_MAX = 5 * 1024 * 1024;    // 解压后单文件上限
const SKILL_IMPORT_TOTAL_MAX = 25 * 1024 * 1024;  // 解压后总大小上限
const SKILL_EXPORT_TOTAL_MAX = 25 * 1024 * 1024;  // 导出技能总大小上限（目录形态时遍历累加）

/** 任意字符串转 kebab-case（小写、空白/下划线转连字符、去非法字符） */
function toKebab(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 若 SKILL.md 的 frontmatter 缺 name/description，补上以保证导入后即生效（与 list 生效口径一致） */
function ensureFrontmatter(body, name, description) {
  const pf = parseFrontmatter(body);
  const front = pf.front || {};
  const need = {};
  if (!front.name) need.name = name;
  if (!front.description) need.description = description || name;
  if (!Object.keys(need).length) return body;
  const keys = Object.keys(front).concat(Object.keys(need));
  let block = '---\n';
  keys.forEach(function (k) { block += k + ': ' + (front[k] || need[k]) + '\n'; });
  block += '---\n';
  return block + (pf.body || '');
}
