/**
 * dsh-wallpaper —— 浏览器半（client.js）
 *
 * 这条路为什么是「官方槽位」而不是「DOM 后处理」：
 *   DSH 自带 @deepseek-ai/dsh-client-ui-theme，它在「设置 → 通用」分区里注册了
 *   「外观」（light/dark/system）与「正文字号」两行，注册点就是槽位
 *   settings.general.item（该槽位由 ui-settings 在自己的 settings.section
 *   注册项里用 children 声明的**子槽位**，不是顶层槽位）。本插件用同一个槽位
 *   加第三行，视觉上就是官方功能的一部分，也不存在抢 DOM 的问题（坑 #24/#36）。
 *
 * 样式为什么由宿主生成、客户端只负责取：
 *   首屏要「第一帧就带壁纸」，只能靠宿主往 <head> 注入 —— 那时候插件还没跑。
 *   若客户端再各写一份 CSS，两份实现必然漂移。所以宿主提供
 *   GET /dsh-wallpaper/style.css，客户端改了配置就把这份文本重新拉一遍，
 *   写回**宿主注入的那个 <style> 元素**（不新建，避免两份样式打架）。
 *
 * 为什么不用 ctx.theme.overrideTokens()：
 *   它是官方扩展点，但只在客户端加载后才生效 ⇒ 每次打开页面都会先闪一下
 *   没有壁纸的界面。DSH 自己的主题为了同样的原因也是走宿主注入
 *   （见 ui-theme 的 bootThemeInjection）。本插件与官方保持同一条路径。
 *   注入的选择器用 `html body`（而不是 `body`）来保证特异性高于官方样式表，
 *   从而不依赖文档顺序 —— 细节见 index.js 的 buildCss。
 *
 * ⚠️ 已知行为：本组件只在**设置面板打开、且停在「通用」分区**时才挂载。
 *    所以页面刚加载时它不会跑，此时完全由宿主注入的那份 CSS 负责。
 *
 * 构建标识：改代码必须 +1（同时改 index.js 的 BUILD）。
 */

(function () {
  'use strict';

  var BUILD = 'v9-20260914-1.0.1';
  var PLUGIN = 'dsh-wallpaper';
  var SLOT = 'settings.general.item';
  var ROW_ID = 'wallpaper';
  var API = '/dsh-wallpaper';
  var STYLE_ID = 'dsh-wallpaper-boot';

  /** 滑杆去抖：拖动时不要每像素打一次宿主。 */
  var SAVE_DEBOUNCE_MS = 220;

  /** 自检用：把阶段写进 DOM，出问题时一眼看出停在哪一步。 */
  function phase(value) {
    try {
      document.documentElement.dataset.dshWallpaperPhase = String(value);
    } catch (_) {
      /* DOM 不可用时静默 */
    }
  }

  /** 把宿主给的 CSS 写进那个既有的 <style> 元素（没有就建一个）。 */
  function applyCss(css) {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.dataset.dshWallpaper = BUILD;
    if (el.textContent !== css) el.textContent = css;
    try {
      document.documentElement.dataset.dshWallpaperCss = String(css.length);
    } catch (_) {
      /* 忽略 */
    }
    return css.length;
  }

  /**
   * 把浏览器侧的状态报回宿主 —— 我看不到 DOM，这是唯一能让状态可查的通道。
   * source 必须带：宿主按它分槽存，否则会把注入探针的读数整个冲掉。
   */
  function report(payload) {
    try {
      fetch(API + '/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ build: BUILD, source: 'client' }, payload))
      }).catch(function () {
        /* 上报失败不该影响功能 */
      });
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

      /* ── 插件自有样式：随插件装卸，不污染 DSH 全局样式 ─────────────── */

      var css =
        '._dwRow{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding:16px 0;display:flex}' +
        '._dwHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}' +
        '._dwTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}' +
        '._dwState{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code,monospace)}' +
        '._dwState[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}' +
        '._dwCubeRow{flex-wrap:wrap;align-items:stretch;gap:8px;display:flex}' +
        '._dwCube{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:20px;flex:1 1 84px;justify-content:center;align-items:center;padding:12px 16px;font-size:13px;line-height:20px;display:flex}' +
        '._dwCube:hover:not(._dwSelected){background:var(--dsw-alias-interactive-bg-hover)}' +
        '._dwSelected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}' +
        '._dwPanel{display:flex;flex-direction:column;gap:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}' +
        '._dwLine{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
        '._dwLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;min-width:96px}' +
        '._dwVal{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}' +
        '._dwSwatch{width:36px;height:26px;padding:0;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:0 0;cursor:pointer}' +
        '._dwHex{width:92px;box-sizing:border-box;padding:3px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}' +
        '._dwRange{flex:1 1 140px;min-width:120px;accent-color:var(--dsw-alias-brand-primary)}' +
        '._dwBtn{box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:6px 14px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)}' +
        '._dwBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
        '._dwBtn:disabled{opacity:.5;cursor:default}' +
        '._dwBtnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}' +
        '._dwThumb{width:88px;height:48px;border-radius:8px;object-fit:cover;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}' +
        '._dwEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}';

      var tagId = PLUGIN + '/row.css';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        var tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN;
        tag.dataset.pluginCss = tagId;
        tag.dataset.pluginBuild = BUILD;
        tag.textContent = css;
        document.head.appendChild(tag);
      }

      var MODES = [
        { id: 'none', label: '\u65E0' },
        { id: 'solid', label: '\u7EAF\u8272' },
        { id: 'gradient', label: '\u6E10\u53D8' },
        { id: 'image', label: '\u56FE\u7247' }
      ];
      var FITS = [
        { id: 'cover', label: '\u94FA\u6EE1' },
        { id: 'contain', label: '\u5B8C\u6574' },
        { id: 'tile', label: '\u5E73\u94FA' }
      ];

      var h = React.createElement;

      /** 一个「色板 + 十六进制输入」的组合控件。 */
      function ColorField(props) {
        return h(
          'div',
          { className: '_dwLine' },
          h('div', { className: '_dwLabel' }, props.label),
          h('input', {
            className: '_dwSwatch',
            type: 'color',
            value: props.value,
            'aria-label': props.label,
            onChange: function (e) {
              props.onChange(e.target.value);
            }
          }),
          h('input', {
            className: '_dwHex',
            type: 'text',
            spellCheck: false,
            value: props.value,
            'aria-label': props.label + ' hex',
            onChange: function (e) {
              var v = e.target.value.trim();
              if (/^#[0-9a-fA-F]{6}$/.test(v)) props.onChange(v.toLowerCase());
            }
          })
        );
      }

      /** 一个「标签 + 滑杆 + 数值」的组合控件。 */
      function RangeField(props) {
        return h(
          'div',
          { className: '_dwLine' },
          h('div', { className: '_dwLabel' }, props.label),
          h('input', {
            className: '_dwRange',
            type: 'range',
            min: props.min,
            max: props.max,
            step: 1,
            value: props.value,
            'aria-label': props.label,
            onChange: function (e) {
              props.onChange(Number(e.target.value));
            }
          }),
          h('div', { className: '_dwVal' }, String(props.value) + (props.unit || ''))
        );
      }

      /**
       * 设置行主体。
       * ⚠️ 槽位是 React 渲染的：必须返回 React 元素，返回原生 DOM 节点会静默失败（坑 #15）。
       */
      function WallpaperRow() {
        var cfgState = React.useState(null);
        var cfg = cfgState[0];
        var setCfg = cfgState[1];

        var statusState = React.useState('\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026');
        var status = statusState[0];
        var setStatus = statusState[1];

        var toneState = React.useState('muted');
        var tone = toneState[0];
        var setTone = toneState[1];

        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];

        var meta = React.useRef({ loaded: false, lastSaved: null, timer: null });
        var fileRef = React.useRef(null);

        /** 局部打补丁：只改提供的字段。 */
        function patch(part) {
          setCfg(function (prev) {
            return Object.assign({}, prev, part);
          });
        }

        function fail(message) {
          setBusy(false);
          setStatus(message);
          setTone('error');
          report({ phase: 'error', error: String(message) });
        }

        /* 初次加载：拿配置 + 拿样式，并把样式套上去。 */
        React.useEffect(function () {
          var cancelled = false;
          fetch(API + '/config', { credentials: 'omit' })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (cancelled) return;
              if (!j || !j.ok) throw new Error((j && j.error) || 'bad response');
              meta.current.loaded = true;
              meta.current.lastSaved = JSON.stringify(j.config);
              setCfg(j.config);
              return fetch(API + '/style.css', { credentials: 'omit' })
                .then(function (r) {
                  return r.text();
                })
                .then(function (text) {
                  if (cancelled) return;
                  var n = applyCss(text);
                  setBusy(false);
                  setStatus('\u5DF2\u52A0\u8F7D \u00B7 ' + j.config.mode + ' \u00B7 ' + n + ' \u5B57\u8282 CSS');
                  setTone('muted');
                  phase('ready');
                  report({ phase: 'ready', mode: j.config.mode, cssBytes: n });
                });
            })
            .catch(function (err) {
              if (cancelled) return;
              fail('\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF1A' + String((err && err.message) || err));
            });
          return function () {
            cancelled = true;
          };
        }, []);

        /* 配置变化 → 去抖保存到宿主 → 重新取样式并套用。 */
        React.useEffect(function () {
          if (!cfg || !meta.current.loaded) return undefined;
          var serialized = JSON.stringify(cfg);
          if (serialized === meta.current.lastSaved) return undefined;

          if (meta.current.timer) clearTimeout(meta.current.timer);
          meta.current.timer = setTimeout(function () {
            meta.current.timer = null;
            setBusy(true);
            fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: serialized
            })
              .then(function (r) {
                return r.json().then(function (j) {
                  return { status: r.status, body: j };
                });
              })
              .then(function (res) {
                var j = res.body;
                if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
                meta.current.lastSaved = JSON.stringify(j.config);
                /* 用回读到的权威值回填，避免本地状态和磁盘漂移。 */
                setCfg(function (prev) {
                  return JSON.stringify(prev) === JSON.stringify(j.config) ? prev : j.config;
                });
                return fetch(API + '/style.css', { credentials: 'omit' }).then(function (r) {
                  return r.text();
                });
              })
              .then(function (text) {
                var n = applyCss(text);
                setBusy(false);
                setStatus('\u5DF2\u4FDD\u5B58 \u00B7 ' + n + ' \u5B57\u8282 CSS');
                setTone('muted');
                report({ phase: 'saved', mode: cfg.mode, cssBytes: n });
              })
              .catch(function (err) {
                fail('\u4FDD\u5B58\u5931\u8D25\uFF1A' + String((err && err.message) || err));
              });
          }, SAVE_DEBOUNCE_MS);

          return function () {
            if (meta.current.timer) {
              clearTimeout(meta.current.timer);
              meta.current.timer = null;
            }
          };
        }, [cfg]);

        function onPickFile(e) {
          var file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          setStatus('\u6B63\u5728\u4E0A\u4F20\u2026');
          setTone('muted');
          file
            .arrayBuffer()
            .then(function (buf) {
              return fetch(API + '/upload', {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: buf
              });
            })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || !j.ok) throw new Error((j && j.error) || 'upload failed');
              setBusy(false);
              /* 上传成功顺带切到图片模式，符合直觉。 */
              patch({ mode: 'image', image: j.name });
            })
            .catch(function (err) {
              fail('\u4E0A\u4F20\u5931\u8D25\uFF1A' + String((err && err.message) || err));
            });
        }

        function reset() {
          setBusy(true);
          fetch(API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'none' })
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || !j.ok) throw new Error((j && j.error) || 'reset failed');
              meta.current.lastSaved = JSON.stringify(j.config);
              setCfg(j.config);
              return fetch(API + '/style.css', { credentials: 'omit' }).then(function (r) {
                return r.text();
              });
            })
            .then(function (text) {
              applyCss(text);
              setBusy(false);
              setStatus('\u5DF2\u5173\u95ED\u80CC\u666F');
              setTone('muted');
            })
            .catch(function (err) {
              fail('\u91CD\u7F6E\u5931\u8D25\uFF1A' + String((err && err.message) || err));
            });
        }

        if (!cfg) {
          return h(
            'div',
            { className: '_dwRow', 'data-dsh-wallpaper-row': ROW_ID },
            h('div', { className: '_dwTitle' }, '\u7A97\u53E3\u80CC\u666F'),
            h('div', { className: '_dwState', 'data-tone': tone }, status)
          );
        }

        var mode = cfg.mode;
        var children = [
          h(
            'div',
            { className: '_dwHead', key: 'head' },
            h('div', { className: '_dwTitle' }, '\u7A97\u53E3\u80CC\u666F'),
            h(
              'div',
              { className: '_dwState', 'data-tone': tone, 'data-dsh-wallpaper-diag': '1' },
              status
            )
          ),
          h(
            'div',
            { className: '_dwCubeRow', key: 'cubes' },
            MODES.map(function (m) {
              return h(
                'button',
                {
                  key: m.id,
                  type: 'button',
                  className: '_dwCube' + (mode === m.id ? ' _dwSelected' : ''),
                  'data-dsh-wallpaper-mode': m.id,
                  'aria-pressed': mode === m.id,
                  disabled: busy,
                  onClick: function () {
                    patch({ mode: m.id });
                  }
                },
                m.label
              );
            })
          )
        ];

        /* ── 各模式自己的参数面板 ─────────────────────────────────── */
        if (mode === 'solid') {
          children.push(
            h(
              'div',
              { className: '_dwPanel', key: 'solid' },
              h(ColorField, {
                key: 'c',
                label: '\u80CC\u666F\u8272',
                value: cfg.color,
                onChange: function (v) {
                  patch({ color: v });
                }
              })
            )
          );
        } else if (mode === 'gradient') {
          children.push(
            h(
              'div',
              { className: '_dwPanel', key: 'gradient' },
              h(ColorField, {
                key: 'from',
                label: '\u8D77\u8272',
                value: cfg.gradientFrom,
                onChange: function (v) {
                  patch({ gradientFrom: v });
                }
              }),
              h(ColorField, {
                key: 'to',
                label: '\u6B62\u8272',
                value: cfg.gradientTo,
                onChange: function (v) {
                  patch({ gradientTo: v });
                }
              }),
              h(RangeField, {
                key: 'angle',
                label: '\u89D2\u5EA6',
                min: 0,
                max: 360,
                unit: '\u00B0',
                value: cfg.gradientAngle,
                onChange: function (v) {
                  patch({ gradientAngle: v });
                }
              })
            )
          );
        } else if (mode === 'image') {
          var thumb = cfg.image
            ? h('img', {
                key: 'thumb',
                className: '_dwThumb',
                alt: '\u5F53\u524D\u58C1\u7EB8',
                src: API + '/file/' + cfg.image
              })
            : h('div', { key: 'empty', className: '_dwEmpty' }, '\u5C1A\u672A\u9009\u62E9\u56FE\u7247');
          children.push(
            h(
              'div',
              { className: '_dwPanel', key: 'image' },
              h(
                'div',
                { className: '_dwLine' },
                h('div', { className: '_dwLabel' }, '\u56FE\u7247'),
                thumb,
                h(
                  'button',
                  {
                    type: 'button',
                    className: '_dwBtn _dwBtnPrimary',
                    disabled: busy,
                    onClick: function () {
                      if (fileRef.current) fileRef.current.click();
                    }
                  },
                  '\u9009\u62E9\u56FE\u7247\u2026'
                ),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp',
                  style: { display: 'none' },
                  onChange: onPickFile
                })
              ),
              h(
                'div',
                { className: '_dwLine' },
                h('div', { className: '_dwLabel' }, '\u586B\u5145\u65B9\u5F0F'),
                h(
                  'select',
                  {
                    className: '_dwHex',
                    value: cfg.imageFit,
                    onChange: function (e) {
                      patch({ imageFit: e.target.value });
                    }
                  },
                  FITS.map(function (f) {
                    return h('option', { key: f.id, value: f.id }, f.label);
                  })
                )
              ),
              h(RangeField, {
                key: 'blur',
                label: '\u6A21\u7CCA',
                min: 0,
                max: 60,
                unit: 'px',
                value: cfg.blur,
                onChange: function (v) {
                  patch({ blur: v });
                }
              })
            )
          );
        }

        /* ── 通用调节：只要不是「无」就显示 ───────────────────────── */
        if (mode !== 'none') {
          children.push(
            h(
              'div',
              { className: '_dwPanel', key: 'common' },
              h(RangeField, {
                key: 'panel',
                label: '\u9762\u677F\u4E0D\u900F\u660E\u5EA6',
                min: 0,
                max: 100,
                unit: '%',
                value: cfg.panelOpacity,
                onChange: function (v) {
                  patch({ panelOpacity: v });
                }
              }),
              h(RangeField, {
                key: 'dim',
                label: '\u80CC\u666F\u538B\u6697',
                min: 0,
                max: 90,
                unit: '%',
                value: cfg.dim,
                onChange: function (v) {
                  patch({ dim: v });
                }
              })
            )
          );
        }

        children.push(
          h(
            'div',
            { className: '_dwLine', key: 'actions' },
            h(
              'button',
              {
                type: 'button',
                className: '_dwBtn',
                disabled: busy || mode === 'none',
                onClick: reset
              },
              '\u5173\u95ED\u80CC\u666F'
            ),
            h(
              'div',
              { className: '_dwEmpty' },
              '\u9762\u677F\u4E0D\u900F\u660E\u5EA6\u8D8A\u4F4E\uFF0C\u4FA7\u680F\u4E0E\u5361\u7247\u8D8A\u900F\uFF1B\u62C9\u5230 100% \u5C31\u56DE\u5230\u5B98\u65B9\u539F\u6837 \u00B7 v1.0.1'
            )
          )
        );

        return h('div', { className: '_dwRow', 'data-dsh-wallpaper-row': ROW_ID }, children);
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
                id: ROW_ID,
                order: 12
              },
              WallpaperRow
            );
          });

          try {
            document.documentElement.dataset.dshWallpaperBuild = BUILD;
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
