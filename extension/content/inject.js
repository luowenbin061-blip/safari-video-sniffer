/* 在页面世界（MAIN world）执行的嗅探钩子。
 *
 * content script 运行在隔离世界，够不到页面自己的 XMLHttpRequest / fetch。
 * Safari 不支持 manifest 的 world:"MAIN"，所以这里用「动态插入 <script src>」
 * 的老办法把代码送进页面世界。
 *
 * 注意：严格 CSP 的站点会拦掉这个注入，失败不影响主流程 ——
 * 主流程是 content script 里的 performance API 扫描。
 */
(function () {
  'use strict';

  if (window.__vsnInjected) return;
  window.__vsnInjected = true;

  var EXT_RE = /\.(mp4|m4v|mov|webm|flv|f4v|mkv|ts|m4s|m3u8|mpd)([?#]|$)/i;

  function report(url, src) {
    if (!url || typeof url !== 'string') return;
    if (url.length > 4000) return;
    try {
      document.dispatchEvent(new CustomEvent('__vsn_url__', {
        detail: JSON.stringify({ u: url, s: src })
      }));
    } catch (e) { /* 事件派发失败无所谓 */ }
  }

  try {
    var xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (url && EXT_RE.test(String(url))) report(String(url), 'xhr');
      } catch (e) {}
      return xhrOpen.apply(this, arguments);
    };
  } catch (e) {}

  try {
    var rawFetch = window.fetch;
    if (typeof rawFetch === 'function') {
      window.fetch = function (input) {
        try {
          var u = typeof input === 'string' ? input : (input && input.url);
          if (u && EXT_RE.test(String(u))) report(String(u), 'fetch');
        } catch (e) {}
        return rawFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  try {
    var rawCreate = URL.createObjectURL;
    if (typeof rawCreate === 'function') {
      URL.createObjectURL = function (obj) {
        var out = rawCreate.apply(this, arguments);
        // blob: 地址本身没法直接下载，但它是「这里有流媒体」的强信号，
        // 记下来提示用户需要重新加载视频才能拿到真实地址。
        report(out, 'blob');
        return out;
      };
    }
  } catch (e) {}
})();
