/* Safari Web Extension 的 background page。
 *
 * 嗅探和界面全部在 content script 里完成，这里没有常驻逻辑 ——
 * 它存在的意义是让扩展的结构贴近 Safari 期望的形态
 * （对照过 Stay 的 manifest，它同样带一个 background）。
 *
 * 以后如果要做「把地址交给后台直接下载」这类功能，逻辑挂在这里。
 */

(function () {
  'use strict';

  var B = (typeof browser !== 'undefined' && browser.runtime) ? browser
        : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome
        : null;

  if (!B) return;

  // 故意不注册 onMessage：popup 是用 tabs.sendMessage 直接找 content script 的，
  // 不经过 background。装个空监听反而可能把消息拦掉。
})();
