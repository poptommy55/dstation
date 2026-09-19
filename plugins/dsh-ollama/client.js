/**
 * dsh-ollama 浏览器半。
 *
 * 职责：
 *  1. **证据**：把构建号与宿主状态写进 <html data-ollama-*>（agent 看不见用户窗口，
 *     状态"跑到哪一步"必须变成可查的 DOM 事实）。
 *  2. **卡片 + 编辑器**：在「设置 → 模型 → Ollama（本地）」那张卡片里显示连接状态、
 *     版本、本地模型清单，并**直接编辑配置** —— 不必去手改 settings.yaml。
 *
 * 编辑器为什么自己实现，而不是复用模型页那个"编辑"按钮：
 *   那个编辑器是**为 pi-ai / deepseek 的 profile 手写的**（API 密钥 + baseURL +
 *   模型目录 + 协议），对插件自定义的 settings 命名空间渲染不出字段。
 *   所以这里的表单按宿主返回的**字段定义**动态渲染 —— 以后加一个配置项，界面自动就有。
 *
 * 约束照抄 dsh-plugin-dev 骨架：手写 DSH 模块格式、只 inject ['slots']、
 * React 元素必须由 require('react') 产出（返回原生 DOM 节点会被静默丢弃）。
 */

(function () {
  var HOST = 'dsh-ollama';
  var BUILD = 'v3-20260914-fold-launch';
  var SLOT = 'settings.models.provider-card';
  var ENTRY_ID = 'dsh-ollama:card';
  var ENTRY_KEY = 'ollama';

  var ReactRef = null;

  function mark(key, value) {
    try { document.documentElement.dataset[key] = String(value); } catch (e) { /* 忽略 */ }
  }

  /** 用 XHR + 超时请求 JSON（不用 fetch：回环场景下 fetch 可能既不 resolve 也不 reject）。 */
  function request(method, path, body, timeoutMs, cb) {
    var done = false;
    var finish = function (payload) { if (!done) { done = true; cb(payload); } };
    try {
      var xhr = new XMLHttpRequest();
      xhr.open(method, path, true);
      xhr.timeout = timeoutMs || 20000;
      if (body !== undefined && body !== null) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        var parsed = null;
        try { parsed = JSON.parse(xhr.responseText); } catch (e) { parsed = null; }
        if (xhr.status >= 200 && xhr.status < 300) finish({ ok: true, data: parsed });
        else finish({ ok: false, error: (parsed && (parsed.error || JSON.stringify(parsed.rejected || parsed))) || ('HTTP ' + xhr.status) });
      };
      xhr.onerror = function () { finish({ ok: false, error: '请求失败' }); };
      xhr.ontimeout = function () { finish({ ok: false, error: '请求超时' }); };
      xhr.send(body === undefined || body === null ? null : JSON.stringify(body));
    } catch (e) {
      finish({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    setTimeout(function () { finish({ ok: false, error: '看门狗超时' }); }, (timeoutMs || 20000) + 1000);
  }

  function bytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }

  var labelStyle = { display: 'block', fontSize: '11px', opacity: 0.7, marginBottom: '2px' };
  var inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px',
    borderRadius: '4px', border: '1px solid rgba(127,127,127,0.35)',
    background: 'rgba(127,127,127,0.08)', color: 'inherit',
  };
  var btnStyle = {
    padding: '3px 10px', fontSize: '12px', borderRadius: '5px',
    border: '1px solid rgba(127,127,127,0.4)', background: 'transparent',
    color: 'inherit', cursor: 'pointer',
  };

  /** 「设置 → 模型」里那张 Ollama 卡片（含配置编辑器）。 */
  function OllamaCard() {
    var React = ReactRef;
    var s = React.useState({ phase: 'loading', data: null, error: null, refreshing: false, toggling: false, launching: false });
    var view = s[0];
    var setView = s[1];

    var e = React.useState({ open: false, fields: null, draft: {}, saving: false, message: null, error: null });
    var editor = e[0];
    var setEditor = e[1];

    var load = React.useCallback(function (force) {
      setView(function (v) { return Object.assign({}, v, { refreshing: !!force }); });
      request('GET', '/dsh-ollama/status' + (force ? '?refresh=1' : ''), null, force ? 90000 : 15000, function (r) {
        if (r.ok) setView({ phase: 'ready', data: r.data, error: null, refreshing: false });
        else setView({ phase: 'error', data: null, error: r.error, refreshing: false });
      });
    }, []);

    React.useEffect(function () {
      load(false);
      var timer = setInterval(function () { load(false); }, 15000);
      return function () { clearInterval(timer); };
    }, [load]);

    var openEditor = React.useCallback(function () {
      request('GET', '/dsh-ollama/config', null, 15000, function (r) {
        if (!r.ok) { setEditor(function (v) { return Object.assign({}, v, { open: true, fields: null, error: r.error, message: null }); }); return; }
        var values = r.data.values || {};
        var draft = {};
        Object.keys(r.data.fields || {}).forEach(function (k) { draft[k] = values[k]; });
        setEditor({ open: true, fields: r.data.fields, draft: draft, saving: false, message: null, error: null });
      });
    }, []);

    var save = React.useCallback(function () {
      setEditor(function (v) { return Object.assign({}, v, { saving: true, message: null, error: null }); });
      request('POST', '/dsh-ollama/config', { patch: editor.draft }, 30000, function (r) {
        if (r.ok) {
          setEditor(function (v) { return Object.assign({}, v, { saving: false, message: '已保存并生效', error: null }); });
          load(true);
        } else {
          setEditor(function (v) { return Object.assign({}, v, { saving: false, message: null, error: r.error }); });
        }
      });
    }, [editor.draft, load]);

    var reset = React.useCallback(function () {
      setEditor(function (v) { return Object.assign({}, v, { saving: true, message: null, error: null }); });
      request('POST', '/dsh-ollama/config', { reset: true }, 30000, function (r) {
        if (!r.ok) { setEditor(function (v) { return Object.assign({}, v, { saving: false, message: null, error: r.error }); }); return; }
        request('GET', '/dsh-ollama/config', null, 15000, function (r2) {
          var draft = {};
          if (r2.ok) Object.keys(r2.data.fields || {}).forEach(function (k) { draft[k] = r2.data.values[k]; });
          setEditor(function (v) { return Object.assign({}, v, { saving: false, message: '已恢复默认值', error: null, draft: draft, fields: (r2.ok ? r2.data.fields : v.fields) }); });
          load(true);
        });
      });
    }, [load]);

    /** 启用/禁用开关：复用后端已有的 enabled 配置 + POST /config 接口。 */
    var setEnabled = React.useCallback(function (next) {
      setView(function (v) { return Object.assign({}, v, { toggling: true }); });
      request('POST', '/dsh-ollama/config', { patch: { enabled: next } }, 30000, function (r) {
        if (r.ok) {
          // 成功后重新拉状态，让开关/详情/已禁用横幅同步
          load(true);
          setView(function (v) { return Object.assign({}, v, { toggling: false }); });
        } else {
          setView(function (v) { return Object.assign({}, v, { toggling: false, phase: 'error', error: '切换启用状态失败：' + r.error }); });
        }
      });
      }, [load]);

    /** 一键拉起本机 Ollama（后端 /dsh-ollama/launch 负责探测与启动）。 */
    var launchOllama = React.useCallback(function () {
      setView(function (v) { return Object.assign({}, v, { launching: true }); });
      request('POST', '/dsh-ollama/launch', null, 30000, function (r) {
        setView(function (v) { return Object.assign({}, v, { launching: false }); });
        // 无论成功失败都重新读状态，让"已启动/仍不可达"同步
        load(true);
      });
    }, [load]);

    var children = [];
    var cfgEnabled = !!(view.data && view.data.config && view.data.config.enabled !== false);
    children.push(React.createElement('div', {
      key: 'title',
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
    },
      React.createElement('span', { style: { fontWeight: 600, fontSize: '13px' } }, 'Ollama 本地模型'),
      React.createElement('label', {
        key: 'toggle',
        style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', userSelect: 'none' },
      },
        React.createElement('span', { style: { opacity: 0.7 } }, cfgEnabled ? '已启用' : '已禁用'),
        React.createElement('input', {
          type: 'checkbox',
          checked: cfgEnabled,
          disabled: view.phase !== 'ready' || view.toggling,
          onChange: function (ev) { setEnabled(ev.target.checked); },
        }),
      ),
    ));

    if (!cfgEnabled) {
      // ★ 禁用态折叠：只保留一句话提示，不再展开任何技术细节（之前全展开太难看）
      children.push(React.createElement('div', {
        key: 'disabledNotice',
        style: { marginBottom: '6px', fontSize: '12px', color: '#e5484d', background: 'rgba(229,72,77,0.1)', padding: '4px 8px', borderRadius: '4px' },
      }, '⏻ 该供应商已禁用：模型不会出现在模型选择器，发起对话会被拒绝。点击上方开关重新启用。'));
    } else if (view.phase === 'loading') {
      children.push(React.createElement('div', { key: 'l', style: { opacity: 0.7, fontSize: '12px' } }, '正在读取 Ollama 状态…'));
    } else if (view.phase === 'error') {
      children.push(React.createElement('div', { key: 'e', style: { color: '#e5484d', fontSize: '12px' } }, '宿主状态不可用：' + view.error));
    } else {
      var d = view.data || {};
      var o = d.ollama || {};
      if (o.reachable) {
        // ── 已启用 + 已连接：展开技术细节与本地模型清单 ─────────────────────
        var rows = [
          ['连接', o.reachable ? '已连接' : '不可达'],
          ['地址', o.baseUrl],
          ['版本', o.version || '—'],
          ['本地模型数', d.modelCount + (d.visionCount ? '（' + d.visionCount + ' 个可读图）' : '')],
          ['已载入显存', (o.runningModels && o.runningModels.length) ? o.runningModels.join('、') : '无'],
          ['提示词模式', d.config && d.config.promptMode],
          ['上下文 num_ctx', d.config && d.config.contextSize],
        ];
        if (o.error) rows.push(['错误', o.error]);

        children.push(React.createElement('div', {
          key: 'rows',
          style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: '12px' },
        }, rows.reduce(function (acc, pair, i) {
          acc.push(React.createElement('div', { key: 'k' + i, style: { opacity: 0.65 } }, pair[0]));
          acc.push(React.createElement('div', {
            key: 'v' + i,
            style: { wordBreak: 'break-all', color: (pair[0] === '连接' && !o.reachable) || pair[0] === '错误' ? '#e5484d' : 'inherit' },
          }, String(pair[1] == null ? '—' : pair[1])));
          return acc;
        }, [])));

        if (Array.isArray(d.models) && d.models.length > 0) {
          children.push(React.createElement('div', { key: 'ml', style: { marginTop: '8px', fontSize: '12px' } },
            React.createElement('div', { style: { opacity: 0.65, marginBottom: '3px' } }, '可在模型选择器中选用的本地模型：'),
            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
              d.models.map(function (m, i) {
                return React.createElement('div', { key: 'm' + i, style: { wordBreak: 'break-all' } },
                  React.createElement('code', null, m.id),
                  m.vision ? React.createElement('span', { style: { color: '#3fb950' } }, '  🖼 可读图') : null,
                  m.capabilities && m.capabilities.length
                    ? React.createElement('span', { style: { opacity: 0.6 } }, '  (' + m.capabilities.join('/') + ')')
                    : null);
              }))));
        }
      } else {
        // ── 已启用但不可达：给安装/启动引导，不堆技术错误 ───────────────────
        if (d.installed) {
          children.push(React.createElement('div', {
            key: 'nrun', style: { fontSize: '12px', color: '#e5a548', background: 'rgba(229,165,72,0.1)', padding: '6px 8px', borderRadius: '4px' },
          }, '检测到本机已安装 Ollama，但服务未运行。'));
          children.push(React.createElement('button', {
            key: 'launch', type: 'button', style: Object.assign({}, btnStyle, { marginTop: '6px' }),
            disabled: view.launching, onClick: function () { launchOllama(); },
          }, view.launching ? '启动中…' : '启动 Ollama'));
        } else {
          children.push(React.createElement('div', {
            key: 'nodl', style: { fontSize: '12px', lineHeight: 1.5 },
          }, '未检测到 Ollama 服务。请前往 ',
            React.createElement('a', { href: 'https://ollama.com/download', target: '_blank', rel: 'noopener noreferrer', style: { color: '#4a9eff' } }, 'ollama.com/download'),
            ' 下载并安装，然后运行 ',
            React.createElement('code', null, 'ollama pull qwen3.5'),
            ' 等命令拉取模型。'));
        }
      }
    }

    // ── 配置编辑器（按字段定义动态渲染）────────────────────────────────────
    var editorNodes = [];
    if (editor.open) {
      if (!editor.fields) {
        editorNodes.push(React.createElement('div', { key: 'ee', style: { color: '#e5484d', fontSize: '12px', marginTop: '8px' } },
          '读取配置失败：' + (editor.error || '未知错误')));
      } else {
        var keys = Object.keys(editor.fields);
        editorNodes.push(React.createElement('div', {
          key: 'grid',
          style: { marginTop: '10px', display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) 1fr', gap: '8px 10px', alignItems: 'start' },
        }, keys.reduce(function (acc, key) {
          var def = editor.fields[key] || {};
          var value = editor.draft[key];
          acc.push(React.createElement('div', { key: 'l-' + key },
            React.createElement('div', { style: labelStyle }, key),
            def.description ? React.createElement('div', { style: { fontSize: '10px', opacity: 0.5, lineHeight: 1.25 } }, def.description) : null));

          var onChange = function (v) {
            setEditor(function (prev) {
              var draft = Object.assign({}, prev.draft);
              draft[key] = v;
              return Object.assign({}, prev, { draft: draft, message: null });
            });
          };

          if (def.type === 'boolean') {
            acc.push(React.createElement('label', { key: 'f-' + key, style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
              React.createElement('input', { type: 'checkbox', checked: !!value, onChange: function (ev) { onChange(ev.target.checked); } }),
              React.createElement('span', { style: { opacity: 0.7 } }, value ? '开' : '关')));
          } else if (key === 'chatPersona') {
            acc.push(React.createElement('textarea', {
              key: 'f-' + key, rows: 3, value: value == null ? '' : String(value),
              onChange: function (ev) { onChange(ev.target.value); },
              style: Object.assign({}, inputStyle, { resize: 'vertical', fontFamily: 'inherit' }),
            }));
          } else {
            acc.push(React.createElement('input', {
              key: 'f-' + key,
              type: def.type === 'number' ? 'number' : 'text',
              value: value == null ? '' : String(value),
              onChange: function (ev) { onChange(ev.target.value); },
              style: inputStyle,
            }));
          }
          return acc;
        }, [])));

        if (editor.message) {
          editorNodes.push(React.createElement('div', { key: 'msg', style: { color: '#3fb950', fontSize: '12px', marginTop: '6px' } }, editor.message));
        }
        if (editor.error) {
          editorNodes.push(React.createElement('div', { key: 'err', style: { color: '#e5484d', fontSize: '12px', marginTop: '6px' } }, '保存失败：' + editor.error));
        }
        editorNodes.push(React.createElement('div', { key: 'acts', style: { marginTop: '8px' } },
          React.createElement('button', { type: 'button', style: btnStyle, disabled: editor.saving, onClick: save },
            editor.saving ? '保存中…' : '保存'),
          React.createElement('button', { type: 'button', style: Object.assign({}, btnStyle, { marginLeft: '8px' }), disabled: editor.saving, onClick: reset },
            '恢复默认')));
      }
    }

    var actions = [];
    if (cfgEnabled) {
      actions.push(React.createElement('button', {
        key: 'refresh', type: 'button', disabled: view.refreshing,
        onClick: function () { load(true); }, style: btnStyle,
      }, view.refreshing ? '刷新中…' : '刷新模型列表'));
    }
    actions.push(React.createElement('button', {
      key: 'edit', type: 'button', style: Object.assign({}, btnStyle, cfgEnabled ? { marginLeft: '8px' } : {}),
      onClick: function () { if (editor.open) setEditor(function (v) { return Object.assign({}, v, { open: false }); }); else openEditor(); },
    }, editor.open ? '收起配置' : '编辑配置'));

    return React.createElement('div', {
      'data-ollama-card': BUILD,
      style: { marginTop: '10px', padding: '10px 12px', border: '1px solid rgba(127,127,127,0.25)', borderRadius: '8px' },
    }, children.concat([
      React.createElement('div', { key: 'actions', style: { marginTop: '8px' } }, actions),
      React.createElement('div', { key: 'editor' }, editorNodes),
    ]));
  }

  function apply(ctx) {
    mark('ollamaBuild', BUILD);
    mark('ollamaPhase', 'apply:start');

    request('GET', '/dsh-ollama/status', null, 15000, function (r) {
      mark('ollamaHost', r.ok ? 'ok' : 'fail');
      if (r.ok && r.data) {
        mark('ollamaReachable', !!(r.data.ollama && r.data.ollama.reachable));
        mark('ollamaModelCount', r.data.modelCount);
        mark('ollamaRegistered', r.data.registered);
        mark('ollamaNamespace', r.data.namespaceRegistered);
      }
    });

    try {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
        mark('ollamaPhase', 'apply:no-slots');
        return;
      }
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, key: ENTRY_KEY, entryKey: ENTRY_KEY, order: 100, label: 'Ollama 本地模型' },
          OllamaCard,
        );
      });
      mark('ollamaPhase', 'apply:ok');
    } catch (e) {
      mark('ollamaPhase', 'apply:slot-error');
      mark('ollamaSlotError', (e && e.message) || String(e));
    }
  }

  window.__ModuleLoader__.load({
    id: HOST,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      try { ReactRef = require('react'); } catch (e) { ReactRef = null; }
      if (!ReactRef && typeof window !== 'undefined' && window.React) ReactRef = window.React;

      exports.name = HOST;
      exports.inject = ['slots'];
      exports.apply = apply;
      exports.__internals = { BUILD: BUILD, bytes: bytes };
      return module.exports;
    },
  });
})();
