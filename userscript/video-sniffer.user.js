// ==UserScript==
// @name         视频嗅探（长按视频看地址）
// @namespace    safari-video-sniffer
// @version      1.2.0
// @description  长按网页里的视频，列出这个页面上真实的视频地址；MP4 直链可以走 iOS 系统菜单直接下载
// @author       -
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* 说明
 *
 * 为什么做成用户脚本而不是 Safari 扩展：
 *   TrollStore 装的 App，其 PlugIns 里的 app extension 不会被 iOS 注册，
 *   所以侧载的 Safari 扩展永远不会出现在「设置 → Safari → 扩展」里。
 *   用户脚本走的是另一条路（Stay 已经是一个正常的商店 App），不受这个限制。
 *
 * 嗅探怎么做的：
 *   1) performance.getEntriesByType('resource') —— 主力。它能回溯页面「已经发生过」
 *      的全部资源请求，正好覆盖「视频已经在播」这个最常见的时机。
 *   2) DOM 扫描 —— 读 <video> / <source> 的 currentSrc 和 src。
 *   3) hook XHR / fetch / createObjectURL —— 抓之后发生的请求和 blob 信号。
 */

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  if (W.__vsnUserScript) {
    // 重复执行（同一页面注入两次）就只切换面板
    W.__vsnUserScript();
    return;
  }

  var EXT_RE = /\.(mp4|m4v|mov|webm|flv|f4v|mkv|ts|m4s|m3u8|mpd)([?#]|$)/i;
  var BAD_RE = /^(javascript|data|about|mailto):/i;
  var ORDER = { direct: 0, hls: 1, dash: 2, blob: 3, other: 4, segment: 9 };
  var LABEL = { direct: 'MP4', hls: 'M3U8', dash: 'MPD', blob: 'BLOB', other: 'FILE', segment: 'TS' };

  var store = {};
  var maskEl = null, listEl = null, countEl = null, ballEl = null;
  var toastEl = null, toastTimer = null, opened = false;

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
      item = store[key] = { url: url, kind: kind, t: Date.now(), size: 0 };
    }
    item.t = Date.now();
    if (opened) render();
  }

  function scanDom() {
    var nodes = document.querySelectorAll('video, audio, source');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      try {
        if (el.currentSrc) remember(el.currentSrc, 'DOM');
        if (el.src) remember(el.src, 'DOM');
      } catch (e) {}
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
      var item = store[e.name.split('#')[0]];
      if (item && e.transferSize > 0) item.size = e.transferSize;
    }
  }

  function installHooks() {
    if (W.__vsnUserScriptHooked) return;
    W.__vsnUserScriptHooked = true;

    try {
      var rawOpen = W.XMLHttpRequest.prototype.open;
      W.XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (url && EXT_RE.test(String(url))) remember(String(url), 'XHR');
        } catch (e) {}
        return rawOpen.apply(this, arguments);
      };
    } catch (e) {}

    try {
      var rawFetch = W.fetch;
      if (typeof rawFetch === 'function') {
        W.fetch = function (input) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url);
            if (u && EXT_RE.test(String(u))) remember(String(u), 'FETCH');
          } catch (e) {}
          return rawFetch.apply(this, arguments);
        };
      }
    } catch (e) {}

    try {
      var rawCreate = W.URL.createObjectURL;
      if (typeof rawCreate === 'function') {
        W.URL.createObjectURL = function (obj) {
          var out = rawCreate.apply(this, arguments);
          remember(out, 'BLOB');
          return out;
        };
      }
    } catch (e) {}

    try {
      new PerformanceObserver(function (payload) {
        var es = payload.getEntries();
        for (var i = 0; i < es.length; i++) {
          if (es[i].name && EXT_RE.test(es[i].name)) remember(es[i].name, 'NET');
        }
      }).observe({ entryTypes: ['resource'] });
    } catch (e) {}
  }

  /* -------------------------------------------------------------------- 列表 */

  function collected() {
    var arr = [];
    for (var k in store) arr.push(store[k]);

    // 已经拿到播放列表或直链时，碎分片就不展示了（它们只在 MSE 场景里有意义）
    var hasStrong = false;
    for (var i = 0; i < arr.length; i++) {
      var kd = arr[i].kind;
      if (kd === 'direct' || kd === 'hls' || kd === 'dash') { hasStrong = true; break; }
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

  var CSS = [
    '.vsn-mask{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483600;',
    'background:rgba(0,0,0,.5);display:none;align-items:flex-end;',
    'font:15px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;color:#e8edf5;',
    '-webkit-text-size-adjust:100%}',
    '.vsn-mask.vsn-on{display:flex}',
    '.vsn-panel{width:100%;max-height:78vh;background:#16181d;border-radius:16px 16px 0 0;',
    'display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;',
    'padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));',
    'box-shadow:0 -4px 24px rgba(0,0,0,.45)}',
    '.vsn-head{display:flex;align-items:center;justify-content:space-between;',
    'padding:14px 16px 10px;border-bottom:1px solid #272b34;flex:none}',
    '.vsn-title{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600}',
    '.vsn-count{min-width:20px;padding:1px 7px;border-radius:10px;background:#2b3a52;',
    'color:#7fb3ff;font-size:12px;font-weight:600;text-align:center}',
    '.vsn-close{appearance:none;-webkit-appearance:none;border:0;border-radius:8px;',
    'padding:7px 14px;background:#232833;color:#9fb0c7;font-family:inherit;font-size:14px;line-height:1}',
    '.vsn-list{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;',
    'padding:4px 0;min-height:0}',
    '.vsn-item{display:block;padding:11px 16px;border-bottom:1px solid #1e222a;',
    'color:#e8edf5;text-decoration:none;-webkit-tap-highlight-color:transparent}',
    '.vsn-item:active{background:#232833}',
    '.vsn-row1{display:flex;align-items:center;gap:8px;margin-bottom:3px}',
    '.vsn-badge{flex:none;padding:2px 6px;border-radius:4px;background:#2b3a52;',
    'color:#7fb3ff;font-size:11px;font-weight:700}',
    '.vsn-badge.direct{background:#14301f;color:#5fd68a}',
    '.vsn-badge.hls,.vsn-badge.dash{background:#3a2f14;color:#ffc44d}',
    '.vsn-badge.blob{background:#33203a;color:#c98cff}',
    '.vsn-badge.segment,.vsn-badge.other{background:#262a33;color:#8899ad}',
    '.vsn-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;',
    'white-space:nowrap;font-size:13px;color:#dbe4f0}',
    '.vsn-size{flex:none;font-size:12px;color:#8899ad}',
    '.vsn-row2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;',
    'overflow:hidden;word-break:break-all;font-size:12.5px;color:#8899ad}',
    '.vsn-empty{padding:28px 20px;text-align:center}',
    '.vsn-empty-main{font-size:14px;color:#9fb0c7;margin-bottom:6px}',
    '.vsn-empty-sub{font-size:12.5px;color:#66748a;white-space:pre-line}',
    '.vsn-foot{flex:none;padding:10px 16px 2px;border-top:1px solid #272b34;',
    'font-size:12px;color:#66748a;text-align:center}',
    '.vsn-ball{position:fixed;right:14px;bottom:calc(24px + env(safe-area-inset-bottom,0px));',
    'z-index:2147483590;width:46px;height:46px;border-radius:50%;background:#2b6cff;',
    'color:#fff;display:flex;align-items:center;justify-content:center;',
    'font-size:20px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.4);opacity:.9;',
    '-webkit-tap-highlight-color:transparent}',
    '.vsn-toast{position:fixed;left:50%;transform:translateX(-50%);',
    'bottom:calc(96px + env(safe-area-inset-bottom,0px));z-index:2147483610;',
    'padding:10px 18px;border-radius:20px;background:rgba(18,20,26,.96);color:#fff;',
    'font:13px/1.4 -apple-system,"PingFang SC",system-ui,sans-serif;white-space:nowrap;',
    'opacity:0;pointer-events:none;transition:opacity .2s}',
    '.vsn-toast.vsn-on{opacity:1}',
    '.vsn-hint{margin-top:5px;font-size:11.5px;line-height:1.4;color:#5f6d80}',
    '.vsn-hint-dl{color:#5fd68a}'
  ].join('');

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildUI() {
    if (maskEl) return;

    var style = document.createElement('style');
    style.setAttribute('data-vsn', '1');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

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
    var foot = el('div', 'vsn-foot', '点一下复制 · 长按那一行可以下载（MP4 直链）');

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
    row1.appendChild(el('span', 'vsn-badge ' + item.kind, LABEL[item.kind] || '?'));
    row1.appendChild(el('span', 'vsn-name', shortName(item.url)));

    if (item.size > 0) {
      row1.appendChild(el('span', 'vsn-size', humanSize(item.size)));
    } else if (item.kind === 'blob') {
      row1.appendChild(el('span', 'vsn-size', '需重载'));
    }

    var row2 = el('div', 'vsn-row2', item.url.replace(/^https?:\/\//, ''));

    row.appendChild(row1);
    row.appendChild(row2);

    // 行动提示：让「长按哪一行、下一步干什么」一眼可见
    var canDownload = (item.kind === 'direct');
    var hint = el('div', 'vsn-hint' + (canDownload ? ' vsn-hint-dl' : ''));
    if (canDownload) {
      hint.textContent = '长按此行 → 选「下载链接文件」';
    } else if (item.kind === 'hls' || item.kind === 'dash') {
      hint.textContent = '长按此行 → 拷贝链接（M3U8 要用电脑下载）';
    } else {
      hint.textContent = '长按此行 → 拷贝链接';
    }
    row.appendChild(hint);

    // 点 = 复制（防止误触跳走），长按 = 交给 iOS 系统菜单（含「下载链接文件」）
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
    maskEl.classList.add('vsn-on');
    if (ballEl) ballEl.style.display = 'none';
    opened = true;
  }

  function hide() {
    if (!maskEl) return;
    maskEl.classList.remove('vsn-on');
    if (ballEl) ballEl.style.display = '';
    opened = false;
  }

  function copyText(text) {
    var ok = false;

    // 老办法在 iOS 上反而更稳：不挑 HTTPS，也不挑用户手势时序
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
    toastEl.classList.add('vsn-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('vsn-on');
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

        function start() {
          clearTimeout(timer);
          timer = setTimeout(function () {
            timer = null;
            scanDom();
            show();
          }, 500);
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

        // iOS 长按 video 会弹系统菜单，这里接管掉，换成自己的面板
        video.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          scanDom();
          show();
        });
      })(v);
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  W.__vsnUserScript = function () {
    if (opened) hide();
    else show();
  };

  installHooks();
  scanPerformance();

  function boot() {
    buildUI();
    bindLongPress();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // SPA 会不断换内容，视频元素和请求都是后出现的，隔一会儿补扫一次
  setInterval(function () {
    scanPerformance();
    bindLongPress();
  }, 2500);

  try {
    new MutationObserver(function () { bindLongPress(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
