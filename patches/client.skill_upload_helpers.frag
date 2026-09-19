    // ---- 上传技能：支持 .zip 压缩包，或单独的 .md/.markdown/.txt + .json/.yaml/.yml 等文件 ----
    function abToBase64(buf) {
      var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    /** 调外壳桥导入：zip 走 importZip，其余走 importFiles（.md 当 SKILL.md，其余当资源） */
    function importSkillFiles(ctx, setS, patch, fileList) {
      var br = skillBridge();
      if (!br) { patch({ msg: '技能库通道不可用，请重启 D-STATION 后再试', msgKind: 'err' }); return; }
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      patch({ msg: '正在导入 ' + files.length + ' 个文件…', msgKind: '' });
      Promise.all(files.map(function (f) {
        return new Promise(function (res, rej) {
          var r = new FileReader();
          r.onerror = function () { rej(new Error('读取失败：' + f.name)); };
          r.onload = function () { res({ name: f.name, data: abToBase64(r.result) }); };
          r.readAsArrayBuffer(f);
        });
      })).then(function (items) {
        var zipItem = items.find(function (it) { return /\.zip$/i.test(it.name); });
        var call = zipItem ? br.importZip({ data: zipItem.data }) : br.importFiles({ items: items });
        Promise.resolve(call).then(function (r) {
          if (r && r.ok) {
            var warn = (r.warnings && r.warnings.length) ? ('（' + r.warnings.length + ' 个文件被跳过，见控制台）') : '';
            patch({ msg: '已导入技能「' + r.name + '」' + warn, msgKind: 'ok' });
            if (r.warnings && r.warnings.length) console.warn('[skill-panel] 导入跳过的文件：', r.warnings);
            setTimeout(function () { loadDisk(setS); loadCatalog(ctx, setS); }, 350);
          } else {
            patch({ msg: '导入失败：' + ((r && r.error) || '未知错误'), msgKind: 'err' });
          }
        }).catch(function (e) {
          patch({ msg: '导入异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
        });
      }).catch(function (e) {
        patch({ msg: '读取文件异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
      });
    }

    /** 弹出系统文件选择框（多选），accept 覆盖 .zip/.md/.markdown/.txt/.json/.yaml/.yml */
    function openImportPicker(ctx, setS, patch) {
      try {
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.zip,.md,.markdown,.txt,.json,.yaml,.yml';
        input.style.display = 'none';
        input.onchange = function () {
          if (input.files && input.files.length) importSkillFiles(ctx, setS, patch, input.files);
          if (input.parentNode) input.parentNode.removeChild(input);
        };
        input.onerror = function () { if (input.parentNode) input.parentNode.removeChild(input); };
        document.body.appendChild(input);
        input.click();
      } catch (e) {
        patch({ msg: '无法打开文件选择框：' + (e && e.message ? e.message : e), msgKind: 'err' });
      }
    }

    // 导出技能：调桥 -> 主进程弹「另存为」写出 .zip -> 提示路径
    function exportSkill(ctx, setS, patch, name) {
      var br = skillBridge();
      if (!br) { patch({ msg: SP.diskErr || '技能库文件通道不可用', msgKind: 'warn' }); return; }
      patch({ msg: '正在导出 ' + name + ' …', msgKind: '' });
      Promise.resolve(br.exportSkill(name)).then(function (r) {
        if (r && r.ok) {
          patch({ msg: '已导出 ' + name + '.zip（' + (r.count || 0) + ' 个文件）→ ' + (r.path || ''), msgKind: 'ok' });
        } else if (r && r.cancelled) {
          patch({ msg: '已取消导出', msgKind: '' });
        } else {
          patch({ msg: '导出失败：' + ((r && r.error) || '未知错误'), msgKind: 'err' });
        }
      }).catch(function (e) {
        patch({ msg: '导出失败：' + (e && e.message ? e.message : e), msgKind: 'err' });
      });
    }
