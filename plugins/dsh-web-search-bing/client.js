/**
 * dsh-web-search-bing — browser half (client bundle)
 *
 * Registered into the DSH client module system as
 * `window.__ModuleLoader__.load({ id, factory })`. The host's
 * `dsh-client-modules` scan discovers this bundle through
 * `package.json` -> `dsh.client.platform === "web"` + `exports["./client"]`,
 * then serves it as a boot-manifest graph row.
 *
 * What this half does and nothing more: claim the settings namespace that the
 * server half registered via `settings.installSection(..., "web-search-bing")`,
 * by publishing a card into the host's keyed `settings.plugin.item` slot under
 * the SAME key. A served namespace with no card is simply not rendered.
 *
 * Reads and writes go through the host's `settingsScope` service — never a
 * private fetch — so the card shares the document with every other surface and
 * inherits revision fencing, validation and persistence decisions.
 *
 * Registration mirrors the in-repo cards in `@deepseek-ai/dsh-client-ui-settings-plugins`:
 *   - `slots` is a host-provided global service (NOT declared per-plugin), so
 *     `ctx.slots` is available directly in `apply`.
 *   - `settingsScope` is declared in this bundle's `inject` and reached via
 *     `ctx.settingsScope.bind({ namespace })`.
 *   - `ctx.slots.inject(slot, function* () { yield ctx.slots.register({...}, Comp) })`
 *     is the exact generator signature the slot system consumes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-bing',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var jsxRuntime = require('react/jsx-runtime');
    var render = jsxRuntime.jsx;

    /** jsx(type, props, children...) — jsx-runtime takes children on props. */
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      var cfg = props ? Object.assign({}, props) : {};
      if (children.length === 1) cfg.children = children[0];
      else if (children.length > 1) cfg.children = children;
      return render(type, cfg);
    }

    /** Must equal the namespace the server half passed to installSection. */
    var NAMESPACE = 'web-search-bing';

    /** Mirrors the schemastery defaults on the server; only used pre-first-read. */
    var FALLBACK = {
      endpoint: 'https://cn.bing.com/search',
      maxResults: 8,
      timeoutMs: 20000
    };

    var FIELDS = [
      {
        key: 'endpoint',
        label: '搜索端点',
        hint: '默认 cn.bing.com/search；一般不需要改。',
        type: 'text'
      },
      {
        key: 'maxResults',
        label: '返回结果数',
        hint: '1 - 20，默认 8。',
        type: 'number',
        min: 1,
        max: 20
      },
      {
        key: 'timeoutMs',
        label: '超时（毫秒）',
        hint: '3000 - 60000，默认 20000。',
        type: 'number',
        min: 3000,
        max: 60000
      }
    ];

    /**
     * Theme-agnostic on purpose: every surface is translucent grey over the
     * host's own background and text inherits `currentColor`, so the card reads
     * correctly in both light and dark without guessing token names.
     */
    var S = {
      card: {
        border: '1px solid rgba(128,128,128,0.22)',
        borderRadius: 10,
        marginBottom: 10,
        background: 'rgba(128,128,128,0.06)',
        overflow: 'hidden'
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 12px',
        cursor: 'pointer',
        userSelect: 'none'
      },
      headText: { display: 'flex', flexDirection: 'column', gap: 2 },
      title: { fontSize: 13, fontWeight: 600 },
      desc: { fontSize: 11, opacity: 0.62 },
      chevron: { fontSize: 11, opacity: 0.55, transition: 'transform .15s' },
      body: { padding: '2px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 12, opacity: 0.85 },
      hint: { fontSize: 11, opacity: 0.5, lineHeight: 1.5 },
      input: {
        background: 'rgba(128,128,128,0.10)',
        border: '1px solid rgba(128,128,128,0.25)',
        borderRadius: 6,
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        padding: '5px 8px',
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box'
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 },
      button: {
        background: 'rgba(59,130,246,0.18)',
        border: '1px solid rgba(59,130,246,0.45)',
        borderRadius: 6,
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px'
      },
      buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      note: { fontSize: 11, opacity: 0.62, lineHeight: 1.5 },
      error: { fontSize: 11, color: '#e5484d', lineHeight: 1.5 }
    };

    /** A failed render must not blank the whole settings dialog. */
    var Boundary = class extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      render() {
        if (this.state.error) {
          return h('div', { style: S.card },
            h('div', { style: S.head },
              h('div', { style: S.headText },
                h('div', { style: S.title }, 'Bing 免密钥搜索'),
                h('div', { style: S.error }, '卡片渲染失败：' + String((this.state.error && this.state.error.message) || this.state.error))
              )
            )
          );
        }
        return this.props.children;
      }
    };

    /**
     * The card itself. `scope` is the namespace-bound settings scope, so the
     * component never learns where the document lives. The returned function is
     * cached once in `apply` so React keeps a stable component identity across
     * re-renders (required for hooks to work).
     */
    function createCard(scope) {
      return function BingSearchCard() {
        var _snap = react.useState(function () { return scope.getSnapshot(); });
        var snap = _snap[0], setSnap = _snap[1];
        var _draft = react.useState(null);
        var draft = _draft[0], setDraft = _draft[1];
        var _busy = react.useState(false);
        var busy = _busy[0], setBusy = _busy[1];
        var _error = react.useState(null);
        var error = _error[0], setError = _error[1];
        var _open = react.useState(false);
        var open = _open[0], setOpen = _open[1];

        react.useEffect(function () {
          return scope.subscribe(function () { setSnap(scope.getSnapshot()); });
        }, []);

        var value = (snap && snap.value) || FALLBACK;
        var writable = !snap || snap.writable !== false;
        var shown = draft || value;

        function onField(key, raw) {
          var next = Object.assign({}, shown);
          next[key] = raw;
          setDraft(next);
        }

        function onSave() {
          setBusy(true);
          setError(null);
          var ops = [
            { op: 'set', path: ['endpoint'], value: String(shown.endpoint || FALLBACK.endpoint) },
            { op: 'set', path: ['maxResults'], value: Number(shown.maxResults) || FALLBACK.maxResults },
            { op: 'set', path: ['timeoutMs'], value: Number(shown.timeoutMs) || FALLBACK.timeoutMs }
          ];
          Promise.resolve(scope.mutate(ops))
            .then(function () { setDraft(null); })
            .catch(function (cause) {
              setError(String((cause && cause.message) || cause));
            })
            .then(function () { setBusy(false); });
        }

        var statusNote = null;
        if (!snap || snap.status === 'loading') statusNote = '正在读取配置…';
        else if (snap.status === 'unavailable') statusNote = '此配置当前不可写入（仅本进程生效）。';

        return h('div', { style: S.card },
          h('div', {
            style: S.head,
            onClick: function () { setOpen(!open); }
          },
            h('div', { style: S.headText },
              h('div', { style: S.title }, 'Bing 免密钥搜索'),
              h('div', { style: S.desc }, '无需 API Key 的网页搜索 · 当前返回 ' + String(value.maxResults) + ' 条')
            ),
            h('span', {
              style: Object.assign({}, S.chevron, open ? { transform: 'rotate(180deg)' } : {})
            }, '▾')
          ),
          open
            ? h('div', { style: S.body },
                FIELDS.map(function (field) {
                  return h('div', { style: S.field, key: field.key },
                    h('div', { style: S.label }, field.label),
                    h('input', {
                      style: S.input,
                      type: field.type,
                      min: field.min,
                      max: field.max,
                      value: String(shown[field.key] === undefined ? '' : shown[field.key]),
                      disabled: !writable || busy,
                      onChange: function (event) { onField(field.key, event.target.value); }
                    }),
                    h('div', { style: S.hint }, field.hint)
                  );
                }),
                h('div', { style: S.row },
                  h('button', {
                    type: 'button',
                    style: Object.assign({}, S.button, busy || !writable ? S.buttonDisabled : {}),
                    disabled: busy || !writable,
                    onClick: onSave
                  }, busy ? '保存中…' : '保存'),
                  statusNote ? h('span', { style: S.note }, statusNote) : null
                ),
                error ? h('div', { style: S.error }, error) : null,
                h('div', { style: S.hint }, '保存后立即生效，下一次搜索就会用新设置。')
              )
            : null
        );
      };
    }

    /** Services this browser plugin waits for before `apply` runs. */
    var inject = ['slots', 'settingsScope'];
    var name = 'web-search-bing';

    function apply(ctx) {
      // Bind the namespace scope first; if the settings transport is unavailable
      // the card simply stays disabled instead of taking the whole plugin down.
      var scope;
      try {
        scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      } catch (cause) {
        console.warn('[dsh-web-search-bing] settingsScope unavailable — card disabled', cause);
        return;
      }

      // Cache the component so React preserves its identity across renders
      // (hooks rely on a stable function reference).
      var BingSearchCard = createCard(scope);

      // Register into the host's keyed `settings.plugin.item` slot. The tab
      // iterates served namespaces and renders whatever card is registered
      // under each namespace key — so our key MUST equal the server namespace.
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NAMESPACE,
            locale: NAMESPACE,
            inject: function () {
              return h(Boundary, null, h(BingSearchCard, null));
            }
          },
          BingSearchCard
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
