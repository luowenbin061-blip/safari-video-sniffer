(function () {
  'use strict';

  var B = (typeof browser !== 'undefined' && browser.runtime) ? browser
        : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome
        : null;

  var countEl = document.getElementById('count');
  var statusEl = document.getElementById('status');
  var openBtn = document.getElementById('open');
  var rescanBtn = document.getElementById('rescan');

  if (!B) {
    statusEl.textContent = '当前环境没有扩展 API。';
    return;
  }

  function currentTab(done) {
    try {
      B.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        done(tabs && tabs[0] ? tabs[0] : null);
      });
    } catch (e) {
      done(null);
    }
  }

  function tell(type, done) {
    currentTab(function (tab) {
      if (!tab || typeof tab.id !== 'number') {
        done(null);
        return;
      }
      try {
        B.tabs.sendMessage(tab.id, { type: type }, function (res) {
          if (B.runtime && B.runtime.lastError) {
            done(null);
            return;
          }
          done(res || null);
        });
      } catch (e) {
        done(null);
      }
    });
  }

  function paint(res) {
    if (res && typeof res.count === 'number') {
      countEl.textContent = String(res.count);
      statusEl.textContent = res.count > 0
        ? '已嗅到 ' + res.count + ' 个候选地址。'
        : '还没嗅到视频 —— 让视频播放几秒再试，或重新扫描。';
      openBtn.disabled = false;
    } else {
      countEl.textContent = '—';
      statusEl.textContent = '这个页面注入不进去（浏览器内置页或受限站点）。';
      openBtn.disabled = true;
    }
  }

  tell('vsn-count', paint);

  openBtn.addEventListener('click', function () {
    tell('vsn-open', function () {
      window.close();
    });
  });

  rescanBtn.addEventListener('click', function () {
    statusEl.textContent = '正在重新扫描…';
    tell('vsn-rescan', paint);
  });
})();
