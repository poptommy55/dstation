'use strict';
/**
 * D-STATION 在线升级 — 渲染进程桥（preload）
 *
 * 前端页面（dsh web UI 及其插件，如知识库面板）通过
 * window.__DSTATION_OTA__ 调用主进程能力。
 *
 * 为什么用 preload + IPC 而不是 HTTP：页面是 contextIsolation:true 的沙箱，
 * 走标准 IPC 不需要额外端口，也不受页面 CSP 的 connect-src 限制。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__DSTATION_OTA__', {
  available: true,

  /** 当前版本信息（不含网络请求） */
  getInfo: function () {
    return ipcRenderer.invoke('dstation:ota:version');
  },

  /** 检查更新：拉清单并比对版本 */
  check: function () {
    return ipcRenderer.invoke('dstation:ota:check');
  },

  /** 执行升级：下载 -> 校验 -> 启动升级器 -> 应用退出重启 */
  apply: function () {
    return ipcRenderer.invoke('dstation:ota:install');
  },

  /** Phase 2：可回滚的版本快照列表 + 事务日志（tx.phase === 'applying' 说明上次升级中断） */
  snapshots: function () {
    return ipcRenderer.invoke('dstation:ota:snapshots');
  },

  /** Phase 2：回滚到指定版本（不传则回最新的一份快照） */
  rollback: function (version) {
    return ipcRenderer.invoke('dstation:ota:rollback', version);
  },

  /** 订阅进度事件，返回取消订阅函数 */
  subscribe: function (cb) {
    const handler = function (_e, data) {
      try { cb(data); } catch (err) { /* 忽略前端回调异常 */ }
    };
    ipcRenderer.on('dstation:ota:progress', handler);
    return function () {
      try { ipcRenderer.removeListener('dstation:ota:progress', handler); } catch (e) {}
    };
  }
});

/**
 * 本地文件桥 —— 把渲染进程选中的文件写进会话工作目录。
 *
 * 为什么需要：DSH 附件通道只收光栅图片（dsh-attachment README：「通用文件、音频和
 * 视频暂不支持」），浏览器侧也没有任何写盘 API。而 DSH 给模型文件的官方机制是
 * @路径 引用（只插文本、不附内容，模型自己调工具读），前提是文件先在会话工作目录里。
 *
 * 安全边界由主进程强制（见 files.js）：目标目录必须落在 DSH 已登记工作区之内
 * （realpath + isWithin，符号链接逃逸同样拒绝）、文件名净洁、单文件 ≤ 100 MB、
 * 重名追加序号、临时文件 + rename 原子落盘、绝不覆盖既有文件。
 */
contextBridge.exposeInMainWorld('__DSTATION_FILES__', {
  available: true,

  /** 列出允许写入的根目录（排查用） */
  roots: function () {
    return ipcRenderer.invoke('dstation:files:roots');
  },

  /** 保存一个文件：{ dir, name, data:Uint8Array } -> { ok, path, dir, name, rel, size } */
  save: function (payload) {
    return ipcRenderer.invoke('dstation:files:save', payload);
  }
});

/**
 * 技能库桥 —— DSH 原生「用户级」技能根 <DSH_HOME>/skills 的读写删通道。
 *
 * 为什么单独开一个命名空间、不挂在 FILES 下：
 *   FILES 是**上传**语义（不建目录、重名自动加序号、只写不读、绝不覆盖）；
 *   技能库是**可反复覆盖写**的语义（mkdir -p、覆盖同一份、还要能读能删）。
 *   两者安全姿态不同，混在一起会让人误以为共用同一套白名单。
 *   根路径固定死在主进程侧（<BASE>/home/skills），渲染进程无法指定任意路径；
 *   name 还会被强制为 kebab-case。全部方法返回 { ok, error?, ... }，主进程内已 try/catch。
 */
contextBridge.exposeInMainWorld('__DSTATION_SKILLS__', {
  available: true,

  /** 技能根绝对路径 + 扫盘结果：{ ok, root, skills: [{name,layout,relPath,size,mtime,parsed,valid,reason}] } */
  list: function () {
    return ipcRenderer.invoke('dstation:skills:list');
  },

  /** 读原文：name -> { ok, name, path, layout, text, bytes } */
  read: function (name) {
    return ipcRenderer.invoke('dstation:skills:read', name);
  },

  /** 覆盖写（自动建目录）：{ name, text } -> { ok, name, path, layout, bytes } */
  write: function (payload) {
    return ipcRenderer.invoke('dstation:skills:write', payload);
  },

  /** 删除技能（优先移入回收站，返回 trashed 标识）：name -> { ok, name, trashed } */
  remove: function (name) {
    return ipcRenderer.invoke('dstation:skills:remove', name);
  },

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
});
