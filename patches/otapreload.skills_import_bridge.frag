  /** 导入压缩包技能：{ buffer|data: base64 } -> { ok, name, path, files, warnings } */
  importZip: function (payload) {
    return ipcRenderer.invoke('dstation:skills:import-zip', payload);
  },

  /** 导入松散文件技能（.md 当 SKILL.md，其余当资源）：{ items:[{name,data:base64}] } -> { ok, name, path, files, warnings } */
  importFiles: function (payload) {
    return ipcRenderer.invoke('dstation:skills:import-files', payload);
  },

  /** 导出技能为 .zip（主进程弹「另存为」对话框选路径并写出文件）：name -> { ok, path, name, count } */
  exportSkill: function (name) {
    return ipcRenderer.invoke('dstation:skills:export', name);
  }
