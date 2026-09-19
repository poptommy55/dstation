/**
 * dsh-dstation-market —— 浏览器半（client.js）
 *
 * 两个视图：
 *   · 「已安装」——列出本机插件，热停用/启用（2 秒生效，不用重启）、卸载
 *   · 「可下载」——从索引源拉列表，一键安装（带下载进度）
 *
 * 挂载点：`settings.plugins.tab`（官方「插件清单」用的同一个槽位）。
 *
 * ⚠️ 槽位是 React 渲染的：必须返回 React 元素，返回原生 DOM 节点会静默失败。
 * ⚠️ 停用/启用热生效；**安装与卸载要重启**。
 * ⚠️ 本文件只有中文**字面量**、不 import 任何新文件 —— 改它不会动
 *    package.json 的 files 白名单，也不需要宿主重启（客户端半是热重载的）。
 */

(function () {
  'use strict';

  var BUILD = 'v9-20260915-stage5f';
  var PLUGIN = 'dsh-dstation-market';
  var SLOT = 'settings.plugins.tab';
  var API = '/dstation-market';

  function phase(value) {
    try {
      document.documentElement.dataset.dshMarketPhase = String(value);
    } catch (_) {
      /* 忽略 */
    }
  }

  phase('module:loaded');

  window.__ModuleLoader__.load({
    id: PLUGIN,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      var React = require('react');
      var h = React.createElement;

      var css =
        '._dmRoot{display:flex;flex-direction:column;gap:12px;padding:4px 0}' +
        '._dmBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
        '._dmTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;flex:1;min-width:120px}' +
        '._dmHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}' +
        '._dmErr{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;word-break:break-all}' +
        '._dmOk{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}' +
        '._dmTabs{display:flex;gap:6px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:8px}' +
        '._dmTab{box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:4px 14px;border-radius:16px;cursor:pointer;border:.5px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary)}' +
        '._dmTab:hover:not(._dmTabOn){background:var(--dsw-alias-interactive-bg-hover)}' +
        '._dmTabOn{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-color:var(--dsw-static-neutral-bluish-400)}' +
        '._dmList{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}' +
        '._dmRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 12px;border-top:.5px solid var(--dsw-alias-border-l2)}' +
        '._dmRow:first-child{border-top:0}' +
        /* ⚠️ 名字必须有一个**最小宽度**，否则按钮一多就会被 flex 压到接近 0 宽，
              长包名会变成一列一个字（真发生过：一个插件挂了三个入口按钮之后，
              @michengai/dsh-archive-manager 被压成竖排）。
              配合上面的 flex-wrap，位置不够时按钮换行，而不是去挤名字。
              overflow-wrap:anywhere 只在真的放不下时才断词，比 word-break:break-all 温和。 */
        '._dmName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;flex:1 1 180px;min-width:180px;overflow-wrap:anywhere}' +
        /* flex:0 0 auto —— 标签与按钮**不许被压缩**。
           不加的话宽按钮会把旁边的文字挤扁（它们的 white-space:nowrap 只会让内容溢出）。 */
        '._dmVer{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto}' +
        '._dmTag{font-size:11px;line-height:16px;padding:1px 7px;border-radius:9px;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);flex:0 0 auto}' +
        '._dmTagOn{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);border-color:transparent}' +
        '._dmTagOff{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border-color:transparent}' +
        '._dmTagLock{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}' +
        '._dmTagOwner{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}' +
        '._dmBtn{box-sizing:border-box;font:inherit;font-size:12px;line-height:18px;padding:4px 12px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);white-space:nowrap;flex:0 0 auto}' +
        '._dmBtnSm{font-size:11px;padding:3px 9px}' +
        '._dmBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
        '._dmBtn:disabled{opacity:.5;cursor:default}' +
        '._dmBtnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}' +
        '._dmBtnDanger{color:var(--dsw-alias-state-error-primary)}' +
        '._dmMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:var(--ds-font-family-code,monospace);word-break:break-all}' +
        '._dmCard{display:flex;gap:12px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;margin-bottom:8px;align-items:flex-start}' +
        '._dmCardMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}' +
        '._dmCardName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:500}' +
        '._dmCardDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-word}' +
        '._dmCardTags{display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
        '._dmCardSide{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:0 0 auto}' +
        '._dmInput{flex:1;min-width:180px;box-sizing:border-box;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}' +
        '._dmProg{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}' +
        '._dmProgFill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s}' +
        '._dmPanel{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1)}';

      var tagId = PLUGIN + '/client.css';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        var tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN;
        tag.dataset.pluginCss = tagId;
        tag.dataset.pluginBuild = BUILD;
        tag.textContent = css;
        document.head.appendChild(tag);
      }

      function post(path, body) {
        return fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {})
        }).then(function (r) {
          return r.json().then(function (j) {
            return { status: r.status, body: j };
          });
        });
      }

      /**
       * 给一个插件的多个入口算「能区分它们」的短名。
       *
       * 多个入口的 id 往往共享一长串由包名派生的后缀，
       * 比如 @michengai/dsh-archive-manager 的三个入口：
       *     workspace-archive-manager
       *     session-projection-cache-archive-manager
       *     ui-workspace-archive-manager
       * 去掉公共后缀后的 workspace / session-projection-cache / ui-workspace
       * 才是有信息量的部分。
       *
       * ⚠️ 必须**按分隔符切词**，在词边界上裁。
       *    直接按字符求公共后缀会多切一位（上面三个连 "-archive-manager"
       *    前面的那个 "e" 都是共有的），切出来是 "workspac" / "…-cach" 这种半个词。
       *
       * @returns {string[]|null} 与 entries 一一对应的短名；只有一个入口时返回 null
       */
      function entryLabels(entries) {
        if (!entries || entries.length < 2) return null;
        var ids = entries.map(function (e) {
          return String(e.id);
        });
        var parts = ids.map(function (id) {
          return id.split(/[-_.]+/).filter(Boolean);
        });

        /* 从尾部数：一共有多少段是大家共有的 */
        var common = 0;
        for (;;) {
          var at = function (p) {
            return p.length - 1 - common;
          };
          if (parts.some(function (p) { return at(p) < 0; })) break;
          var tok = parts[0][at(parts[0])];
          if (!parts.every(function (p) { return p[at(p)] === tok; })) break;
          common += 1;
        }

        return ids.map(function (id, i) {
          var kept = parts[i].slice(0, parts[i].length - common);
          var s = kept.length ? kept.join('-') : id;   /* 全被切光就退回完整 id */
          return s.length > 18 ? s.slice(0, 17) + '…' : s;
        });
      }

      function fmtSize(n) {
        var b = Number(n) || 0;
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1024 / 1024).toFixed(2) + ' MB';
      }

      function MarketTab() {
        var stateS = React.useState(null);
        var state = stateS[0];
        var setState = stateS[1];

        var viewS = React.useState('installed');
        var view = viewS[0];
        var setView = viewS[1];

        var catS = React.useState(null);
        var catalog = catS[0];
        var setCatalog = catS[1];

        var catErrS = React.useState('');
        var catError = catErrS[0];
        var setCatError = catErrS[1];

        /* 备份计数：pkg -> 份数。用来决定要不要显示「回滚」按钮。 */
        var bkS = React.useState({});
        var backups = bkS[0];
        var setBackups = bkS[1];
        function backupCount(pkg) {
          return backups[pkg] || 0;
        }

        var srcS = React.useState('');
        var sourceDraft = srcS[0];
        var setSourceDraft = srcS[1];

        var opS = React.useState(null);
        var operation = opS[0];
        var setOperation = opS[1];

        var errS = React.useState('');
        var error = errS[0];
        var setError = errS[1];

        /* 导出表单。
           ⚠️ 本来用的是 window.prompt 连问两次，**在 Electron 里完全不工作** ——
           Electron 只实现了 alert/confirm，window.prompt 会直接抛异常。
           症状是"点按钮完全没反应"：处理器第一行就炸了，连错误都来不及显示。
           所以改成页面内的表单：不依赖任何原生对话框，也能把错误显示出来。 */
        var expS = React.useState('');
        var exportFor = expS[0];
        var setExportFor = expS[1];
        var expNameS = React.useState('');
        var exportName = expNameS[0];
        var setExportName = expNameS[1];
        var expWhereS = React.useState('');
        var exportWhere = expWhereS[0];
        var setExportWhere = expWhereS[1];

        var noteS = React.useState('');
        var note = noteS[0];
        var setNote = noteS[1];

        var busyS = React.useState('');
        var busy = busyS[0];
        var setBusy = busyS[1];

        var timerRef = React.useRef(null);

        var reload = React.useCallback(function () {
          return fetch(API + '/state', { credentials: 'omit' })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || !j.ok) throw new Error((j && j.error) || 'bad response');
              setState(j);
              setError('');
              phase('state:ok');
            })
            .catch(function (e) {
              setError('状态读取失败：' + String((e && e.message) || e));
              phase('state:error');
            });
        }, []);

        var loadCatalog = React.useCallback(function () {
          setCatError('');
          /* 顺带刷新备份计数（失败不影响主流程） */
          fetch(API + '/backups', { credentials: 'omit' })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || !j.ok || !Array.isArray(j.backups)) return;
              var m = {};
              j.backups.forEach(function (b) {
                m[b.pkg] = (m[b.pkg] || 0) + 1;
              });
              setBackups(m);
            })
            .catch(function () {
              /* 拿不到备份列表就算了，不影响市场主功能 */
            });

          return fetch(API + '/catalog', { credentials: 'omit' })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j) throw new Error('bad response');
              setSourceDraft(j.indexUrl || '');
              if (j.ok === false) {
                setCatalog(null);
                setCatError(j.error || '拉取索引失败');
                return;
              }
              setCatalog(j);
            })
            .catch(function (e) {
              setCatalog(null);
              setCatError(String((e && e.message) || e));
            });
        }, []);

        React.useEffect(function () {
          reload();
        }, [reload]);

        /* 离开页面时把轮询停掉（免得组件卸载后还一直打接口） */
        React.useEffect(function () {
          return function () {
            if (timerRef.current !== null) clearInterval(timerRef.current);
          };
        }, []);

        function watchOperation(id) {
          if (timerRef.current !== null) clearInterval(timerRef.current);
          timerRef.current = setInterval(function () {
            fetch(API + '/operations?id=' + encodeURIComponent(id), { credentials: 'omit' })
              .then(function (r) {
                return r.json();
              })
              .then(function (j) {
                if (!j || !j.ok || !j.operation) return;
                setOperation(j.operation);
                if (j.operation.state !== 'running') {
                  clearInterval(timerRef.current);
                  timerRef.current = null;
                  setBusy('');
                  if (j.operation.state === 'succeeded') {
                    setNote('安装完成：' + j.operation.pkg + ' → 需要重启 DSH 才会生效');
                    loadCatalog();
                    reload();
                  } else {
                    setError('安装失败：' + (j.operation.error || '未知原因'));
                  }
                }
              })
              .catch(function () {
                clearInterval(timerRef.current);
                timerRef.current = null;
                setBusy('');
                setError('进度轮询中断');
              });
          }, 400);
        }

        function toggle(entry, next) {
          setBusy(entry);
          setNote('');
          post('/toggle', { entry: entry, enabled: next })
            .then(function (res) {
              if (!res.body || !res.body.ok) {
                throw new Error((res.body && (res.body.reason || res.body.error)) || 'HTTP ' + res.status);
              }
              setState(res.body.state);
              setBusy('');
              setNote(entry + (next ? ' 已启用' : ' 已停用') + '，约 2 秒生效');
              setError('');
            })
            .catch(function (e) {
              setBusy('');
              setError('操作失败：' + String((e && e.message) || e));
            });
        }

        function uninstall(pkg) {
          if (
            !window.confirm(
              '卸载 ' + pkg + ' ？\n\n' +
                '会从插件树里摘掉它（删链接 + 注销 bundles）。\n' +
                '文件默认**保留**在 plugins\\ 下，方便你重装。\n' +
                '卸载后需要重启 DSH。'
            )
          ) {
            return;
          }
          setBusy(pkg);
          setNote('');
          post('/uninstall', { pkg: pkg, purgeFiles: false })
            .then(function (res) {
              if (!res.body || !res.body.ok) {
                throw new Error((res.body && (res.body.error || (res.body.steps && res.body.steps.profile && res.body.steps.profile.error))) || 'HTTP ' + res.status);
              }
              setState(res.body.state);
              setBusy('');
              setNote(pkg + ' 已卸载（文件保留）—— 需要重启 DSH 才会真正生效');
              setError('');
            })
            .catch(function (e) {
              setBusy('');
              setError('卸载失败：' + String((e && e.message) || e));
            });
        }

        /**
         * 打开导出表单（**不用 window.prompt**，原因见状态声明处的注释）。
         */
        function openExport(pkg, title) {
          setExportFor(pkg);
          setExportName(title || pkg);
          setExportWhere('');
          setError('');
          setNote('');
        }

        function cancelExport() {
          setExportFor('');
          setExportName('');
          setExportWhere('');
        }

        /**
         * 真正执行导出。
         *
         * 为什么不用 window.open(url)：导出接口是 POST（要过同源闸门，
         * 且 displayName/where 是中文长文本）。所以 fetch 成 blob，
         * 再用 <a download> 触发浏览器下载 —— 落点仍然是下载目录。
         *
         * ⚠️ 整个函数体套在 try/catch 里，且 catch 里也套一层：
         *    「静默失败」是最坏的失败方式。宁可显示一句粗糙的错误，也不要什么都不显示。
         */
        function doExport() {
          var pkg = exportFor;
          if (!pkg) return;
          var displayName = String(exportName || '').trim() || pkg;
          var where = String(exportWhere || '').trim();

          setBusy('export:' + pkg);
          setNote('正在打包 ' + pkg + ' …');
          setError('');
          try {
            fetch(API + '/export', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pkg: pkg, displayName: displayName, where: where })
            })
              .then(function (r) {
                if (r.ok) {
                  var cd = r.headers.get('content-disposition') || '';
                  var m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
                  var fname = m ? decodeURIComponent(m[1]) : pkg + '-分发包.zip';
                  return r.blob().then(function (b) {
                    return { blob: b, fname: fname };
                  });
                }
                return r
                  .json()
                  .catch(function () {
                    return {};
                  })
                  .then(function (j) {
                    throw new Error((j && (j.error || j.message)) || 'HTTP ' + r.status);
                  });
              })
              .then(function (out) {
                /* 用 blob URL + <a download> 落地。
                   如果这个环境禁用了 blob:（某些沙箱/CSP 会），
                   URL.createObjectURL 会抛，下面的 catch 会把它显示出来 ——
                   不会再是"点了没反应"。 */
                var url = URL.createObjectURL(out.blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = out.fname;
                a.rel = 'noopener';
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () {
                  URL.revokeObjectURL(url);
                }, 5000);
                setBusy('');
                cancelExport();
                setNote('已导出 ' + out.fname + ' —— 去浏览器的下载目录看看。发给朋友后，他解压双击「一键安装.cmd」即可。');
              })
              .catch(function (e) {
                setBusy('');
                setError('导出失败：' + String((e && e.message) || e));
              });
          } catch (e) {
            setBusy('');
            setError('导出失败（同步异常）：' + String((e && e.message) || e));
          }
        }

        /**
         * 统一的长任务执行器：安装 / 更新 走同一条路径（都是返回 operation + 轮询进度）。
         * @param {string} path - '/install' 或 '/update'
         * @param {string} pkg
         * @param {string} verb - '安装' / '更新'
         */
        function runOp(path, pkg, verb) {
          setBusy(pkg);
          setNote('');
          setError('');
          setOperation(null);
          post(path, { pkg: pkg })
            .then(function (res) {
              var op = res.body && res.body.operation;
              if (!op) throw new Error((res.body && res.body.error) || 'HTTP ' + res.status);
              setOperation(op);
              if (op.state === 'running') {
                watchOperation(op.id);
              } else {
                setBusy('');
                if (op.state === 'succeeded') {
                  var extra = '';
                  if (verb === '更新' && op.result) {
                    extra = '（' + op.result.fromVersion + ' → ' + op.result.toVersion + '，已自动备份）';
                  }
                  setNote(verb + '完成：' + pkg + extra + ' —— 需要重启 DSH 才会生效');
                  loadCatalog();
                  reload();
                } else {
                  setError(verb + '失败：' + (op.error || '未知原因'));
                }
              }
            })
            .catch(function (e) {
              setBusy('');
              setError(verb + '失败：' + String((e && e.message) || e));
            });
        }

        function install(pkg) {
          if (
            !window.confirm(
              '安装 ' + pkg + ' ？\n\n' +
                '会从索引源下载并逐文件校验 sha256，然后放进 plugins\\ 并注册进插件树。\n' +
                '安装完成后需要重启 DSH。'
            )
          ) {
            return;
          }
          runOp('/install', pkg, '安装');
        }

        function update(pkg, from, to) {
          if (
            !window.confirm(
              '更新 ' + pkg + ' ？\n\n' +
                from + ' → ' + to + '\n\n' +
                '更新前会**自动完整备份**当前版本到 backups\\plugins\\；\n' +
                '下载或校验失败会**自动回滚**，不会留下半成品。\n' +
                '更新完成后需要重启 DSH。'
            )
          ) {
            return;
          }
          runOp('/update', pkg, '更新');
        }

        function rollback(pkg) {
          if (
            !window.confirm(
              '把 ' + pkg + ' 回滚到上一次备份？\n\n' +
                '会用 backups\\ 里最新的一份覆盖当前版本。\n' +
                '回滚后需要重启 DSH。'
            )
          ) {
            return;
          }
          setBusy(pkg);
          setNote('');
          setError('');
          post('/rollback', { pkg: pkg })
            .then(function (res) {
              if (!res.body || !res.body.ok) {
                throw new Error((res.body && res.body.result && res.body.result.error) || (res.body && res.body.error) || 'HTTP ' + res.status);
              }
              setState(res.body.state);
              setBusy('');
              setNote(pkg + ' 已回滚到备份 ' + res.body.result.restoredFrom + ' —— 需要重启 DSH 才会生效');
              loadCatalog();
            })
            .catch(function (e) {
              setBusy('');
              setError('回滚失败：' + String((e && e.message) || e));
            });
        }

        function saveSource() {
          setBusy('__source__');
          post('/source', { url: sourceDraft })
            .then(function (res) {
              if (!res.body || !res.body.ok) throw new Error((res.body && res.body.error) || 'HTTP ' + res.status);
              setBusy('');
              setNote('索引源已切换（仅本次运行有效，重启后回到默认）');
              loadCatalog();
            })
            .catch(function (e) {
              setBusy('');
              setCatError('切换索引源失败：' + String((e && e.message) || e));
            });
        }

        function restart() {
          if (
            !window.confirm(
              '重启 DSH 服务？\n\n' +
                '界面会黑 5~10 秒，然后自动恢复。\n' +
                '本次对话会中断，但记录不会丢。'
            )
          ) {
            return;
          }
          setBusy('__restart__');
          post('/restart', {})
            .then(function () {
              setNote('已排定重启，请等待界面自动恢复…');
            })
            .catch(function (e) {
              setBusy('');
              setError('重启失败：' + String((e && e.message) || e));
            });
        }

        /* ── 头部（两个视图共用） ────────────────────────────────── */
        var plugins = (state && state.plugins) || [];
        var installedCount = plugins.length;
        /* 目录总数与"其中可装几个"分开显示 ——
           只写"可下载 N"会误导：目录里有插件但都已安装时会显示 0。 */
        var catalogCount = catalog && Array.isArray(catalog.plugins) ? catalog.plugins.length : null;
        var installableCount = catalog && Array.isArray(catalog.plugins)
          ? catalog.plugins.filter(function (p) {
              return !p.installed;
            }).length
          : null;

        var head = h(
          'div',
          { className: '_dmBar' },
          h('div', { className: '_dmTitle' }, 'D-STATION 插件市场'),
          h(
            'div',
            { className: '_dmHint', 'data-dsh-market-diag': '1' },
            BUILD +
              ' · 已安装 ' + installedCount +
              (catalogCount === null ? '' : ' · 目录 ' + catalogCount + ' 个（可装 ' + installableCount + '）')
          ),
          h('button', {
            className: '_dmBtn',
            disabled: busy !== '',
            onClick: function () {
              reload();
              if (view === 'catalog') loadCatalog();
            }
          }, '刷新'),
          h('button', { className: '_dmBtn', disabled: busy !== '', onClick: restart }, '重启 DSH')
        );

        var tabs = h(
          'div',
          { className: '_dmTabs' },
          h('button', {
            className: '_dmTab' + (view === 'installed' ? ' _dmTabOn' : ''),
            onClick: function () {
              setView('installed');
              setNote('');
            }
          }, '已安装'),
          h('button', {
            className: '_dmTab' + (view === 'catalog' ? ' _dmTabOn' : ''),
            onClick: function () {
              setView('catalog');
              setNote('');
              loadCatalog();
            }
          }, '可下载')
        );

        var msgs = [
          note ? h('div', { className: '_dmOk', key: 'n' }, note) : null,
          error ? h('div', { className: '_dmErr', key: 'e' }, error) : null
        ];

        /* ── 视图：已安装 ────────────────────────────────────────── */
        function installedView() {
          if (!state) {
            return h('div', { className: '_dmHint' }, '正在读取插件状态…');
          }
          var rows = plugins.map(function (p) {
            var kids = [
              h(
                'div',
                { className: '_dmName', key: 'n' },
                p.title || p.pkg,
                p.title && p.title !== p.pkg ? h('div', { className: '_dmMeta' }, p.pkg) : null
              ),
              p.version ? h('div', { className: '_dmVer', key: 'v' }, 'v' + p.version) : null
            ];
            if (p.protected) {
              kids.push(h('span', { className: '_dmTag _dmTagLock', key: 'tag' }, '受保护'));
            } else if (p.entries.length === 0) {
              kids.push(
                h('span', { className: '_dmTag _dmTagLock', key: 'tag' }, p.present ? '未挂载' : '缺文件')
              );
            } else {
              kids.push(
                h(
                  'span',
                  { className: '_dmTag ' + (p.enabled ? '_dmTagOn' : '_dmTagOff'), key: 'tag' },
                  p.enabled ? '已启用' : '已停用'
                )
              );
              /* 一个插件可以有**多个入口**（多个 entry id）——
                 比如 @michengai/dsh-archive-manager 替换了 DSH 的三个内置服务
                 （workspace / session-projection-cache / ui-workspace），
                 于是挂了三行。三个一模一样的「停用」按钮完全分不清谁是谁，
                 所以多入口时把入口名写进按钮里。 */
              var labels = entryLabels(p.entries);
              p.entries.forEach(function (e, i) {
                kids.push(
                  h(
                    'button',
                    {
                      key: 'b' + e.id,
                      /* 多入口时用小一号的按钮：它们是次要操作，
                         而且此时按钮数量翻倍，小一号才不至于把整行撑到换行。 */
                      className: labels ? '_dmBtn _dmBtnSm' : '_dmBtn',
                      disabled: busy !== '',
                      title: (e.enabled ? '停用' : '启用') + ' 入口：' + e.id,
                      onClick: function () {
                        toggle(e.id, !e.enabled);
                      }
                    },
                    (e.enabled ? '停用' : '启用') + (labels ? ' ' + labels[i] : '')
                  )
                );
              });
              kids.push(
                h(
                  'button',
                  { key: 'u', className: '_dmBtn _dmBtnDanger', disabled: busy !== '', onClick: function () { uninstall(p.pkg); } },
                  '卸载'
                )
              );
            }
            /* 导出按钮对所有「文件在盘上」的插件都开放，**包括受保护的**：
               导出是只读操作，不该被「受保护」挡住 —— 受保护限制的是停用/卸载。
               想备份或分发 @deepseek-ai/* 之类的插件时，这个按钮是唯一入口。 */
            if (p.present) {
              kids.push(
                h(
                  'button',
                  {
                    key: 'x',
                    className: '_dmBtn',
                    disabled: busy !== '',
                    title: '打包成一个可以直接发给朋友的安装包（解压双击即可安装）',
                    onClick: function () {
                      openExport(p.pkg, p.title);
                    }
                  },
                  '导出'
                )
              );
            }
            return h('div', { className: '_dmRow', key: p.pkg }, kids);
          });
          /* 导出表单：点「导出」后在列表上方展开。
             页面内表单，不依赖 window.prompt（Electron 不支持它）。 */
          var exportForm = null;
          if (exportFor) {
            exportForm = h(
              'div',
              { className: '_dmPanel' },
              h('div', { className: '_dmHint' }, '导出自包含安装包：' + exportFor + '（发给朋友，他解压双击就能装）'),
              h(
                'div',
                { className: '_dmBar' },
                h('input', {
                  className: '_dmInput',
                  type: 'text',
                  spellCheck: false,
                  value: exportName,
                  placeholder: '给朋友看到的插件名',
                  onChange: function (e) {
                    setExportName(e.target.value);
                  }
                })
              ),
              h(
                'div',
                { className: '_dmBar' },
                h('input', {
                  className: '_dmInput',
                  type: 'text',
                  spellCheck: false,
                  value: exportWhere,
                  placeholder: '装完在哪能看到？例如：设置 → 通用 → 窗口背景（留空用通用提示）',
                  onChange: function (e) {
                    setExportWhere(e.target.value);
                  }
                })
              ),
              h(
                'div',
                { className: '_dmBar' },
                h('button', { className: '_dmBtn _dmBtnPrimary', disabled: busy !== '', onClick: doExport }, '开始导出'),
                h('button', { className: '_dmBtn', disabled: busy !== '', onClick: cancelExport }, '取消')
              )
            );
          }

          return h(
            'div',
            null,
            exportForm,
            h('div', { className: '_dmList' }, rows),
            h('div', { className: '_dmHint' }, '停用/启用立即生效（不用重启）；卸载需要重启；导出会生成一个可以直接发给朋友的安装包。'),
            state.patchPath ? h('div', { className: '_dmMeta' }, 'profile: ' + state.profile + ' · 补丁: ' + state.patchPath) : null
          );
        }

        /* ── 视图：可下载 ────────────────────────────────────────── */
        function catalogView() {
          var sourceBar = h(
            'div',
            { className: '_dmPanel' },
            h('div', { className: '_dmHint' }, '索引源（留空 = 不设置；本地目录也可）'),
            h(
              'div',
              { className: '_dmBar' },
              h('input', {
                className: '_dmInput',
                type: 'text',
                spellCheck: false,
                value: sourceDraft,
                placeholder: 'https://your-market-host/plugins/index.json',
                onChange: function (e) {
                  setSourceDraft(e.target.value);
                }
              }),
              h('button', { className: '_dmBtn', disabled: busy !== '', onClick: saveSource }, '切换'),
              h('button', { className: '_dmBtn', disabled: busy !== '', onClick: loadCatalog }, '重新拉取')
            )
          );

          var progress = null;
          if (operation) {
            var pct = operation.bytesTotal > 0
              ? Math.round((operation.bytesDone / operation.bytesTotal) * 100)
              : (operation.filesTotal > 0 ? Math.round((operation.filesDone / operation.filesTotal) * 100) : 0);
            progress = h(
              'div',
              { className: '_dmPanel' },
              h(
                'div',
                { className: '_dmBar' },
                h('div', { className: '_dmHint' }, '安装 ' + operation.pkg + '：' + operation.state + ' / ' + operation.phase),
                h('div', { className: '_dmMeta' }, operation.filesDone + '/' + operation.filesTotal + ' 文件 · ' + fmtSize(operation.bytesDone) + ' / ' + fmtSize(operation.bytesTotal))
              ),
              h('div', { className: '_dmProg' }, h('div', { className: '_dmProgFill', style: { width: pct + '%' } })),
              operation.message ? h('div', { className: '_dmMeta' }, operation.message) : null
            );
          }

          if (catError) {
            return h(
              'div',
              null,
              sourceBar,
              h('div', { className: '_dmErr' }, '拉取索引失败：' + catError),
              h('div', { className: '_dmHint' }, '市场离线不影响「已安装」里的停用/启用与卸载。')
            );
          }
          if (!catalog) {
            return h('div', null, sourceBar, h('div', { className: '_dmHint' }, '正在拉取可下载列表…'));
          }

          var items = catalog.plugins || [];
          if (items.length === 0) {
            return h('div', null, sourceBar, h('div', { className: '_dmHint' }, '索引里还没有任何插件。'));
          }

          var cards = items.map(function (p) {
            var tags = [
              h('span', { className: '_dmTag _dmTagOwner', key: 'o' }, p.owner + (p.verified ? ' · 已审' : '')),
              h('span', { className: '_dmTag _dmTagOwner', key: 'c' }, p.category),
              p.entry ? h('span', { className: '_dmTag _dmTagOwner', key: 'e' }, 'entry: ' + p.entry) : null
            ];
            var side;
            if (p.installed) {
              side = h(
                'div',
                { className: '_dmCardSide' },
                h('span', { className: '_dmTag _dmTagOn' }, '已安装 v' + (p.installedVersion || '?')),
                p.updateAvailable
                  ? h(
                      'button',
                      {
                        className: '_dmBtn _dmBtnPrimary',
                        disabled: busy !== '',
                        onClick: function () {
                          update(p.name, p.installedVersion || '?', p.version);
                        }
                      },
                      busy === p.name ? '更新中…' : '更新到 v' + p.version
                    )
                  : h('span', { className: '_dmTag _dmTagLock' }, '已是最新'),
                backupCount(p.name) > 0
                  ? h(
                      'button',
                      {
                        className: '_dmBtn',
                        disabled: busy !== '',
                        title: '用 backups\\ 里最新的一份覆盖当前版本',
                        onClick: function () {
                          rollback(p.name);
                        }
                      },
                      '回滚（' + backupCount(p.name) + ' 份备份）'
                    )
                  : null
              );
            } else {
              side = h(
                'div',
                { className: '_dmCardSide' },
                h('div', { className: '_dmMeta' }, 'v' + p.version + ' · ' + fmtSize(p.totalSize) + ' · ' + p.filesCount + ' 文件'),
                h(
                  'button',
                  { className: '_dmBtn _dmBtnPrimary', disabled: busy !== '', onClick: function () { install(p.name); } },
                  busy === p.name ? '安装中…' : '安装'
                )
              );
            }
            return h(
              'div',
              { className: '_dmCard', key: p.name },
              h(
                'div',
                { className: '_dmCardMain' },
                h('div', { className: '_dmCardName' }, p.displayName || p.name),
                p.name !== (p.displayName || p.name) ? h('div', { className: '_dmMeta' }, p.name) : null,
                p.description && p.description.zh ? h('div', { className: '_dmCardDesc' }, p.description.zh) : null,
                h('div', { className: '_dmCardTags' }, tags)
              ),
              side
            );
          });

          return h(
            'div',
            null,
            sourceBar,
            progress,
            h('div', null, cards),
            h(
              'div',
              { className: '_dmHint' },
              '安装会逐文件校验 sha256，任一文件不符即整体拒绝、不留半成品。安装后需重启 DSH。'
            ),
            catalog.updated ? h('div', { className: '_dmMeta' }, '索引更新于 ' + catalog.updated) : null
          );
        }

        return h(
          'div',
          { className: '_dmRoot', 'data-dsh-market-tab': '1' },
          head,
          tabs,
          msgs,
          view === 'catalog' ? catalogView() : installedView()
        );
      }

      exports.name = PLUGIN;
      exports.inject = ['slots'];

      exports.apply = function (ctx) {
        phase('apply:start');
        try {
          ctx.slots.inject(SLOT, function () {
            return ctx.slots.register(
              {
                name: SLOT,
                id: 'dstation-market',
                order: 40,
                label: function () {
                  return 'D-STATION 市场';
                },
                inject: function () {
                  return {};
                }
              },
              MarketTab
            );
          });
          try {
            document.documentElement.dataset.dshMarketBuild = BUILD;
          } catch (_) {
            /* 忽略 */
          }
          phase('apply:ok');
        } catch (err) {
          phase('apply:error:' + (err && err.message ? err.message : String(err)));
          throw err;
        }
      };

      return module.exports;
    }
  });
})();
