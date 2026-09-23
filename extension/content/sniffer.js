/* 视频嗅探 —— content script
 *
 * 职责：找出当前页面里所有可能是视频的地址，并用一个长按唤起的面板列出来。
 *
 * 嗅探为什么这么设计：
 *   Safari 不支持 manifest 的 world:"MAIN"，content script 跑在隔离世界，
 *   够不到页面自己的 XMLHttpRequest / fetch。所以主力是 performance API ——
 *   它能「回溯」页面已经发生过的全部资源请求，正好覆盖「视频已经在播」
 *   这个最常见的使用时机。DOM 扫描和页面世界注入作为补充。
 */
(function () {
  'use strict';

  if (window.__vsnExtension) return;
  window.__vsnExtension = true;

  var B = (typeof browser !== 'undefined' && browser.runtime) ? browser
        : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome
        : null;

  var EXT_RE = /\.(mp4|m4v|mov|webm|flv|f4v|mkv|ts|m4s|m3u8|mpd)([?#]|$)/i;
  var BAD_RE = /^(javascript|data|about|mailto):/i;
  var ORDER = { direct: 0, hls: 1, dash: 2, blob: 3, other: 4, segment: 9 };
  var LABEL = { direct: 'MP4', hls: 'M3U8', dash: 'MPD', blob: 'BLOB', other: 'FILE', segment: 'TS' };

  var store = Object.create(null);

  var maskEl = null;
  var listEl = null;
  var countEl = null;
  var toastEl = null;
  var toastTimer = null;
  var ballEl = null;
  var opened = false;

  /* ------------------------------------------------------------------ 嗅探 */

  function classify(url) {
    if (url.indexOf('blob:') === 0) return 'blob';
    if (/\.m3u8([?#]|$)/i.test(url)) return 'hls';
    if (/\.mpd([?#]|$)/i.test(url)) return 'dash';
    if (/\.(ts|m4s)([?#]|$)/i.test(url)) return 'segment';
    if (/\.(mp4|m4v|mov|webm|flv|f4v|mkv)([?#]|$)/i.test(url)) return 'direct';
    return 'other';
  }

  function remember(rawUrl, source) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    var url = rawUrl.trim();
    if (!url || BAD_RE.test(url)) return;

    var kind = classify(url);
    if (kind === 'other' && !EXT_RE.test(url)) return;

    var key = url.split('#')[0];
    if (key === location.href.split('#')[0]) return;

    var item = store[key];
    if (!item) {
      item = store[key] = { url: url, kind: kind, t: Date.now(), size: 0, from: '' };
    }
    item.t = Date.now();
    if (source && item.from.indexOf(source) < 0) {
      item.from = item.from ? item.from + '+' + source : source;
    }
    if (opened) render();
  }

  function scanDom() {
    var nodes = document.querySelectorAll('video, audio, source');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      try {
        if (el.currentSrc) remember(el.currentSrc, 'DOM');
        if (el.src) remember(el.src, 'DOM');
      } catch (e) { /* 个别元素取属性可能抛错，跳过 */ }
    }
  }

  function scanPerformance() {
    var entries;
    try {
      entries = performance.getEntriesByType('resource');
    } catch (e) {
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.name || !EXT_RE.test(e.name)) continue;
      remember(e.name, 'NET');
      var key = e.name.split('#')[0];
      var item = store[key];
      if (item && e.transferSize > 0) item.size = e.transferSize;
    }
  }

  function watchResources() {
    try {
      var obs = new PerformanceObserver(function (payload) {
        var entries = payload.getEntries();
        for (var i = 0; i < entries.length; i++) {
          var name = entries[i] && entries[i].name;
          if (name && EXT_RE.test(name)) remember(name, 'NET');
        }
      });
      obs.observe({ entryTypes: ['resource'] });
    } catch (e) { /* 不支持就靠轮询 */ }
  }

  /* 把 inject.js 送进页面世界，装上 XHR/fetch/createObjectURL 钩子。
     严格 CSP 的站点会拦，拦了也不影响 performance 那条主路。 */
  function injectPageScript() {
    if (!B || !B.runtime || !B.runtime.getURL) return;
    var src;
    try {
      src = B.runtime.getURL('content/inject.js');
    } catch (e) {
      return;
    }
    if (!src) return;
    try {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = false;
      tag.setAttribute('data-vsn', '1');
      tag.onload = function () { tag.remove(); };
      (document.head || document.documentElement).appendChild(tag);
    } catch (e) { /* 被 CSP 拦下就放弃这条路 */ }
  }

  document.addEventListener('__vsn_url__', function (ev) {
    try {
      var payload = JSON.parse(ev.detail);
      remember(payload.u, payload.s);
    } catch (e) {}
  }, true);

  /* -------------------------------------------------------------------- 列表 */

  function collected() {
    var arr = [];
    for (var key in store) arr.push(store[key]);

    // 已经拿到播放列表或直链时，碎分片就不展示了（它们只在 MSE 场景里才有用）
    var hasStrong = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].kind === 'direct' || arr[i].kind === 'hls' || arr[i].kind === 'dash') {
        hasStrong = true;
        break;
      }
    }
    if (hasStrong) {
      arr = arr.filter(function (x) { return x.kind !== 'segment'; });
    }

    arr.sort(function (a, b) {
      var d = ORDER[a.kind] - ORDER[b.kind];
      return d !== 0 ? d : b.t - a.t;
    });
    return arr;
  }

  function shortName(url) {
    try {
      var parts = url.split('?')[0].split('#')[0].split('/');
      var last = parts[parts.length - 1] || parts[parts.length - 2] || 'video';
      last = decodeURIComponent(last);
      return last.length > 42 ? last.slice(0, 40) + '…' : last;
    } catch (e) {
      return 'video';
    }
  }

  function humanSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  /* ---------------------------------------------------------------------- UI */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildUI() {
    if (maskEl) return;

    maskEl = el('div', 'vsn-mask');
    var panel = el('div', 'vsn-panel');

    var head = el('div', 'vsn-head');
    var title = el('div', 'vsn-title');
    title.appendChild(document.createTextNode('视频嗅探'));
    countEl = el('span', 'vsn-count', '0');
    title.appendChild(countEl);
    var closeBtn = el('button', 'vsn-close', '关闭');
    closeBtn.addEventListener('click', hide);
    head.appendChild(title);
    head.appendChild(closeBtn);

    listEl = el('div', 'vsn-list');
    var foot = el('div', 'vsn-foot', '点链接复制 · 长按链接可用系统菜单下载');

    panel.appendChild(head);
    panel.appendChild(listEl);
    panel.appendChild(foot);
    maskEl.appendChild(panel);

    maskEl.addEventListener('click', function (ev) {
      if (ev.target === maskEl) hide();
    });

    ballEl = el('div', 'vsn-ball');
    ballEl.textContent = '↓';
    ballEl.addEventListener('click', show);

    var root = document.body || document.documentElement;
    root.appendChild(maskEl);
    root.appendChild(ballEl);
  }

  function render() {
    if (!listEl) return;
    var items = collected();

    if (countEl) countEl.textContent = String(items.length);
    listEl.innerHTML = '';

    if (!items.length) {
      var empty = el('div', 'vsn-empty');
      empty.appendChild(el('div', 'vsn-empty-main', '还没嗅到视频'));
      empty.appendChild(el('div', 'vsn-empty-sub',
        '让视频先播放几秒，再打开这个面板。\n有些站点需要重新加载页面才能抓到地址。'));
      listEl.appendChild(empty);
      return;
    }

    for (var i = 0; i < items.length; i++) {
      listEl.appendChild(buildRow(items[i]));
    }
  }

  function buildRow(item) {
    var row = el('a', 'vsn-item');
    row.href = item.url;
    row.target = '_blank';
    row.rel = 'noreferrer';

    var row1 = el('div', 'vsn-row1');
    row1.appendChild(el('span', 'vsn-badge vsn-badge--' + item.kind, LABEL[item.kind] || '?'));

    var name = el('span', 'vsn-name', shortName(item.url));
    row1.appendChild(name);

    if (item.size > 0) {
      row1.appendChild(el('span', 'vsn-size', humanSize(item.size)));
    } else if (item.kind === 'blob') {
      row1.appendChild(el('span', 'vsn-size', '需重载'));
    }

    var row2 = el('div', 'vsn-row2', item.url.replace(/^https?:\/\//, ''));

    row.appendChild(row1);
    row.appendChild(row2);

    // 点 = 复制（避免误触跳转），长按 = 交给 iOS 系统菜单（含「下载链接文件」）
    row.addEventListener('click', function (ev) {
      ev.preventDefault();
      copyText(item.url);
    });

    return row;
  }

  function show() {
    buildUI();
    scanDom();
    scanPerformance();
    render();

    maskEl.classList.add('vsn-mask--open');
    if (ballEl) ballEl.style.display = 'none';
    opened = true;
  }

  function hide() {
    if (!maskEl) return;
    maskEl.classList.remove('vsn-mask--open');
    if (ballEl) ballEl.style.display = '';
    opened = false;
  }

  function toggle() {
    if (opened) hide();
    else show();
  }

  /* ---------------------------------------------------------------- 剪贴板 */

  function copyText(text) {
    var ok = false;

    // 老办法在 iOS 上反而更稳：不依赖 HTTPS，也不依赖用户手势时序
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-2000px;left:0;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) {}

    if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {}
    }

    toast(ok ? '已复制链接' : '复制失败，请长按链接手动拷贝');
  }

  function toast(message) {
    buildUI();
    if (!toastEl) {
      toastEl = el('div', 'vsn-toast');
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('vsn-toast--on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('vsn-toast--on');
    }, 1800);
  }

  /* -------------------------------------------------------------- 长按唤起 */

  function bindLongPress() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      if (v.__vsnBound) continue;
      v.__vsnBound = true;

      (function (video) {
        var timer = null;
        var LONG_PRESS_MS = 500;

        function start() {
          clearTimeout(timer);
          timer = setTimeout(function () {
            timer = null;
            scanDom();
            show();
          }, LONG_PRESS_MS);
        }

        function cancel() {
          clearTimeout(timer);
          timer = null;
        }

        video.addEventListener('touchstart', start, { passive: true });
        video.addEventListener('touchend', cancel);
        video.addEventListener('touchmove', cancel);
        video.addEventListener('touchcancel', cancel);
        video.addEventListener('mouseup', cancel);

        // iOS 长按 video 会弹系统菜单，这里接管掉，换成我们自己的面板
        video.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          scanDom();
          show();
        });
      })(v);
    }
  }

  /* -------------------------------------------------------------- 消息接口 */

  if (B && B.runtime && B.runtime.onMessage) {
    B.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      var type = msg && msg.type;
      if (type === 'vsn-count') {
        scanPerformance();
        sendResponse({ count: collected().length });
        return;
      }
      if (type === 'vsn-open') {
        scanDom();
        show();
        sendResponse({ ok: true, count: collected().length });
        return;
      }
      if (type === 'vsn-rescan') {
        scanDom();
        scanPerformance();
        render();
        sendResponse({ ok: true, count: collected().length });
        return;
      }
    });
  }

  /* ---------------------------------------------------------------- 启动 */

  injectPageScript();
  scanPerformance();
  watchResources();
  bindLongPress();

  // SPA 会不断换内容，视频元素和请求都是后出现的，隔一会儿补扫一次
  setInterval(function () {
    scanPerformance();
    bindLongPress();
  }, 2500);

  // DOM 变化时也给新插入的 video 挂上长按
  try {
    var mo = new MutationObserver(function () {
      bindLongPress();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    buildUI();
    bindLongPress();
  });

  if (document.readyState !== 'loading') {
    buildUI();
  }
})();
