  function importZip(buffer, opts) {
    const buf = toBytesLocal(buffer);
    if (!buf) return { ok: false, error: '压缩包内容无法识别（期望 Uint8Array / Buffer / base64 对象）' };
    if (buf.byteLength === 0) return { ok: false, error: '压缩包为空' };
    if (buf.byteLength > SKILL_IMPORT_ZIP_MAX) {
      return { ok: false, error: '压缩包过大（' + (buf.byteLength / 1048576).toFixed(1) + ' MB，上限 ' + (SKILL_IMPORT_ZIP_MAX / 1048576) + ' MB）' };
    }
    const fl = loadFflate();
    if (!fl || typeof fl.unzipSync !== 'function') {
      return { ok: false, error: '解压库不可用（fflate 未安装）' };
    }
    let unzipped;
    try { unzipped = fl.unzipSync(buf); }
    catch (e) { return { ok: false, error: 'zip 解压失败：' + String(e && e.message) }; }

    // 归一化为 { 相对路径(去除前导 ./ 与反斜杠): Uint8Array }
    const map = {};
    Object.keys(unzipped).forEach(function (k) {
      const n = String(k).replace(/^\.?\//, '').replace(/\\/g, '/');
      if (n && !n.endsWith('/')) map[n] = unzipped[k];
    });
    const entries = Object.keys(map);
    if (!entries.length) return { ok: false, error: '压缩包内没有文件' };

    // 顶层文件夹分布：>1 视为多技能包，拒绝
    const tops = new Set(entries.map(function (n) { return n.includes('/') ? n.slice(0, n.indexOf('/')) : ''; }));
    if (tops.size > 1) {
      return { ok: false, error: '不支持一次导入多个技能（压缩包含多个顶层目录），请一次只打一个技能' };
    }
    const sharedTop = (tops.size === 1 && [...tops][0] !== '') ? [...tops][0] : null;

    const skillRel = entries.find(function (n) { return /(^|\/)SKILL\.md$/i.test(n); });
    if (!skillRel) return { ok: false, error: '压缩包内未找到 SKILL.md' };

    const skillBytes = map[skillRel];
    const skillBody = (typeof skillBytes === 'string') ? skillBytes : Buffer.from(skillBytes).toString('utf8');
    const pf = parseFrontmatter(skillBody);
    const name0 = (pf.front && pf.front.name) ? String(pf.front.name) : null;
    const cn = name0 ? checkName(name0) : { ok: false, error: 'SKILL.md 的 frontmatter 缺少 name（必填，且须为 kebab-case）' };
    if (!cn.ok) return { ok: false, error: cn.error };
    const name = cn.name;

    if (fs.existsSync(path.join(ROOT, name))) {
      return { ok: false, error: '同名技能已存在：' + name + '，请先删除再导入' };
    }

    // 总大小 / 单文件上限
    let total = 0;
    for (const n of entries) {
      const len = bytesLen(map[n]);
      if (len > SKILL_IMPORT_ENTRY_MAX) return { ok: false, error: '文件过大：' + n + '（' + (len / 1048576).toFixed(1) + ' MB，上限 ' + (SKILL_IMPORT_ENTRY_MAX / 1048576) + ' MB）' };
      total += len;
      if (total > SKILL_IMPORT_TOTAL_MAX) return { ok: false, error: '解压后总大小超限（上限 ' + (SKILL_IMPORT_TOTAL_MAX / 1048576) + ' MB）' };
    }

    const written = [];
    const warnings = [];
    for (const n of entries) {
      let rel = n;
      if (sharedTop && rel.startsWith(sharedTop + '/')) rel = rel.slice(sharedTop.length + 1);
      // 全部落进 <ROOT>/<name>/ 下（技能专属目录），name 来自 frontmatter，已 checkName 校验
      const target = safeTarget(path.join(name, rel));
      if (!target) { warnings.push('已跳过非法路径：' + n); continue; }
      const b = map[n];
      const bytes = (typeof b === 'string') ? Buffer.from(b, 'utf8') : Buffer.from(b);
      try { atomicWrite(target, bytes); written.push(rel); }
      catch (e) { warnings.push('写入失败 ' + n + '：' + (e && e.message)); }
    }
    if (!written.length) return { ok: false, error: '没有可写入的文件' };
    log('[SKILLS] 已导入(zip) ' + name + '（' + written.length + ' 个文件）');
    return { ok: true, name: name, path: path.join(ROOT, name), files: written, warnings: warnings };
  }

  /**
   * 从一组松散文件（每项 { name, data: base64 }）导入一个技能：
   *   · 必须恰好一个 .md/.markdown/.txt 作为 SKILL.md（优先 frontmatter.name，缺则取文件名）
   *   · 其余 .json/.yaml/.yml/.txt 等作为资源原样落盘
   * 支持 MD 等格式直接上传，无需先打包成 zip。
   */
  function importFiles(items, opts) {
    if (!Array.isArray(items) || !items.length) return { ok: false, error: '未收到任何文件' };
    const parsed = [];
    for (const it of items) {
      const rawName = String((it && it.name) || '');
      const data = it && it.data;
      if (!rawName || !data) continue;
      let bytes;
      try { bytes = Buffer.from(String(data), 'base64'); }
      catch (e) { return { ok: false, error: '文件 ' + rawName + ' 数据无法解码（期望 base64）' }; }
      if (bytes.length > SKILL_IMPORT_ENTRY_MAX) return { ok: false, error: '文件过大：' + rawName + '（上限 ' + (SKILL_IMPORT_ENTRY_MAX / 1048576) + ' MB）' };
      parsed.push({ name: rawName, bytes: bytes });
    }
    if (!parsed.length) return { ok: false, error: '没有可识别的文件' };

    const skillItems = parsed.filter(function (p) { return /\.(md|markdown|txt)$/i.test(p.name); });
    if (skillItems.length !== 1) {
      return { ok: false, error: skillItems.length
        ? ('只支持一个 SKILL.md（检测到 ' + skillItems.length + ' 个文本文件）；请把其余文件作为资源一起选，或打包成 zip')
        : '缺少 SKILL.md（请选择 .md / .markdown / .txt 文件）' };
    }
    const skill = skillItems[0];
    const body = skill.bytes.toString('utf8');
    const pf = parseFrontmatter(body);
    const name0 = (pf.front && pf.front.name) ? String(pf.front.name) : toKebab(skill.name.replace(/\.[^.]+$/, ''));
    const cn = checkName(name0);
    if (!cn.ok) return { ok: false, error: cn.error };
    const name = cn.name;

    if (fs.existsSync(path.join(ROOT, name))) {
      return { ok: false, error: '同名技能已存在：' + name + '，请先删除再导入' };
    }

    const finalBody = ensureFrontmatter(body, name, name);
    try {
      atomicWrite(path.join(ROOT, name, 'SKILL.md'), Buffer.from(finalBody, 'utf8'));
    } catch (e) { return { ok: false, error: '写入 SKILL.md 失败：' + (e && e.message) }; }

    const written = ['SKILL.md'];
    const warnings = [];
    for (const p of parsed) {
      if (p === skill) continue;
      const safe = sanitizeName(p.name);
      // 资源落进 <ROOT>/<name>/ 下（与 SKILL.md 同目录）
      const target = safeTarget(path.join(name, safe));
      if (!target) { warnings.push('已跳过非法文件名：' + p.name); continue; }
      try { atomicWrite(target, p.bytes); written.push(safe); }
      catch (e) { warnings.push('写入失败 ' + p.name + '：' + (e && e.message)); }
    }
    log('[SKILLS] 已导入(files) ' + name + '（' + written.length + ' 个文件）');
    return { ok: true, name: name, path: path.join(ROOT, name), files: written, warnings: warnings };
  }

  /** 导出技能为 .zip（base64）：目录形态 <name>/ 与单文件形态 <name>.md 都支持；
   *  统一打包成单层顶目录 <name>/...，与 importZip 的「单顶层目录」分支完全兼容（导出即可被他人导入）。 */
  function exportSkill(name) {
    const c = checkName(name);
    if (!c.ok) return { ok: false, error: c.error };
    const dirPath = path.join(ROOT, c.name);
    const filePath = path.join(ROOT, c.name + '.md');
    let files = [];   // { rel: '<name>/xxx', full: 绝对路径 }
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      // 递归遍历（技能目录一般扁平，但允许嵌套资源）
      const walk = function (dir, base) {
        const ents = fs.readdirSync(dir);
        for (let i = 0; i < ents.length; i++) {
          const full = path.join(dir, ents[i]);
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full, path.join(base, ents[i]));
          else if (st.isFile()) files.push({ rel: path.join(base, ents[i]).replace(/\\/g, '/'), full: full });
        }
      };
      walk(dirPath, c.name);
    } else if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      files.push({ rel: c.name + '/SKILL.md', full: filePath });
    } else {
      return { ok: false, error: '技能不存在：' + c.name };
    }
    if (!files.length) return { ok: false, error: '技能目录为空，无可导出文件：' + c.name };

    const fflate = loadFflate();
    if (!fflate || !fflate.zipSync) return { ok: false, error: '压缩库不可用（fflate 未安装）' };

    const obj = {};
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const data = fs.readFileSync(files[i].full);
      total += data.length;
      if (total > SKILL_EXPORT_TOTAL_MAX) {
        return { ok: false, error: '技能过大（' + (total / 1048576).toFixed(1) + ' MB，上限 ' + (SKILL_EXPORT_TOTAL_MAX / 1048576) + ' MB）' };
      }
      obj[files[i].rel] = new Uint8Array(data);
    }
    let zipped;
    try { zipped = fflate.zipSync(obj, { level: 6 }); }
    catch (e) { return { ok: false, error: '压缩失败：' + String(e && e.message ? e.message : e) }; }
    return {
      ok: true, name: c.name, zip: Buffer.from(zipped).toString('base64'),
      count: files.length, bytes: zipped.length
    };
  }
