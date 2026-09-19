// D-STATION brand injection — runs in dsh web page context
// v8: REVERTED CSS approach (pseudo-element broke layout + blocked clicks when
//     container is display:contents). Back to v6 DOM insertion, but light checks
//     now run in a coalesced microtask -> re-applied before the frame paints
//     after React re-renders, so there is no visible flash either.
//     Slow sweeps (provider id / boot HARNESS / onboarding texts) keep 300ms debounce.
(function () {
  if (window.__dstationBrand) return;
  window.__dstationBrand = true;
  var LOGO = 'data:image/png;base64,__DSTATION_LOGO_B64__';
  var start = Date.now();
  var HEAVY_UNTIL_MS = 15000;
  var slowPending = null;
  var lightPending = false;

  function mkLogo(h) {
    var i = document.createElement('img');
    i.src = LOGO;
    i.alt = 'D-STATION';
    i.setAttribute('data-dstation', '1');
    i.style.cssText = 'width:' + h + 'px;height:' + h + 'px;object-fit:contain;display:inline-block;vertical-align:middle';
    return i;
  }
  function mkText(px) {
    var s = document.createElement('span');
    s.textContent = 'D-STATION';
    s.setAttribute('data-dstation', '1');
    s.style.cssText = 'font-size:' + px + 'px;font-weight:700;letter-spacing:0.5px;color:currentColor;white-space:nowrap;font-family:inherit';
    return s;
  }
  function swapIn(container, node, replacement) {
    if (!container || !node || container.querySelector('[data-dstation]')) return;
    node.style.display = 'none';
    container.appendChild(replacement);
  }

  // light checks: brand slots + headline. Called via coalesced microtask ->
  // applied in the same task loop, BEFORE the browser paints the React
  // re-render, so the original brand never becomes visible (no flash).
  function applyLight() {
    var sm = document.querySelector('[data-slot="sidebar.brand.mark"]');
    if (sm) swapIn(sm, sm.querySelector('svg'), mkLogo(24));
    var nm = document.querySelector('[data-slot="sidebar.brand.name"]');
    if (nm) swapIn(nm, nm.querySelector('svg'), mkText(16));
    var hm = document.querySelector('[data-slot="conversation.hero.brand.mark"]');
    if (hm) swapIn(hm, hm.querySelector('svg'), mkLogo(34));
    var hl = document.querySelector('.pXSMma_headlineText');
    if (hl && hl.textContent === '探索未至之境') hl.textContent = 'D-STATION';
  }
  function applySlow() {
    // in-app boot screen wordmark (HARNESS -> D-STATION)
    var bw = document.querySelectorAll('[data-dsh-boot] *');
    for (var k = 0; k < bw.length; k++) {
      var b = bw[k];
      if (b.children.length === 0 && b.textContent === 'HARNESS') b.textContent = 'D-STATION';
    }
    // static onboarding texts mentioning DeepSeek (first 15s only)
    if (Date.now() - start < HEAVY_UNTIL_MS) {
      var leaves = document.querySelectorAll('p,span,div,h1,h2,h3');
      for (var j = 0; j < leaves.length; j++) {
        var t = leaves[j];
        if (t.children.length === 0 && /DeepSeek/.test(t.textContent || '')) {
          t.textContent = t.textContent.replace(/DeepSeek/g, 'D-STATION');
        }
      }
    }
    // hide internal provider id "deepseek-official" (display layer only)
    var bt = document.body && document.body.textContent;
    if (bt && bt.indexOf('deepseek-official') !== -1) {
      var els = document.querySelectorAll('span,div,p,small,code,label,em');
      for (var i = 0; i < els.length; i++) {
        var s = els[i];
        if (s.children.length !== 0 || s.hasAttribute('data-dstation')) continue;
        var txt = s.textContent || '';
        if (txt.indexOf('deepseek-official') === -1) continue;
        s.textContent = txt.replace(/deepseek-official/g, '').replace(/^\s*·\s*|\s*·\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
        s.setAttribute('data-dstation', '1');
      }
    }
  }
  function scheduleLight() {
    if (lightPending) return;
    lightPending = true;
    queueMicrotask(function () { lightPending = false; try { applyLight(); } catch (e) {} });
  }
  function scheduleSlow() {
    if (slowPending) return;
    slowPending = setTimeout(function () { slowPending = null; try { applySlow(); } catch (e) {} }, 300);
  }
  applyLight();
  scheduleSlow();
  new MutationObserver(function () { scheduleLight(); scheduleSlow(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
