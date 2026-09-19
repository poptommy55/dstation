  // 导入技能：压缩包（base64 字节）或一组松散文件（每项 { name, data: base64 }）
  ipcMain.handle('dstation:skills:import-zip', function (_event, payload) {
    const g = guard(); if (g) return g;
    try {
      const p = payload || {};
      return skills.importZip(p.buffer != null ? p.buffer : p.data);
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle('dstation:skills:import-files', function (_event, payload) {
    const g = guard(); if (g) return g;
    try {
      const p = payload || {};
      return skills.importFiles(p.items || p.files);
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  // 导出技能：内核打包为 base64 zip -> 弹「另存为」对话框让用户选路径 -> 写出文件
  ipcMain.handle('dstation:skills:export', function (_event, name) {
    const g = guard(); if (g) return g;
    return Promise.resolve()
      .then(function () { return skills.exportSkill(name); })
      .then(function (r) {
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '导出失败' };
        const opts = {
          title: '导出技能为 .zip',
          defaultPath: (r.name || 'skill') + '.zip',
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
        };
        const dlg = liveWin() ? dialog.showSaveDialog(liveWin(), opts) : dialog.showSaveDialog(opts);
        return Promise.resolve(dlg).then(function (res) {
          if (!res || res.canceled || !res.filePath) return { ok: false, cancelled: true };
          try {
            fs.writeFileSync(res.filePath, Buffer.from(r.zip, 'base64'));
          } catch (e) { return { ok: false, error: '写入文件失败：' + String(e && e.message ? e.message : e) }; }
          return { ok: true, path: res.filePath, name: r.name, count: r.count, bytes: r.bytes };
        });
