/* ============================================================================
 * common.js —— 主线程公用：本机缓存、取文件、高亮、防误触点击
 * 缓存实体在 js/idb.js（Worker 也要用），这里只做转发 + 存储配额自动伸缩。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var C = {};

  /* ===================== 本机缓存：转发到 IDB ===================== */
  C.cacheGet = function (path, size) { return IDB.get(path, size); };
  C.cachePut = function (path, size, bytes) { return IDB.put(path, size, bytes); };
  C.cacheStats = function () { return IDB.stats(); };
  C.cacheIndex = function () { return IDB.index(); };
  C.cacheEvict = function (force) { return IDB.evict(force); };
  C.cacheClear = function () { return IDB.clear(); };
  C.kvGet = function (k) { return IDB.kvGet(k); };
  C.kvSet = function (k, v) { return IDB.kvSet(k, v); };
  C.kvDel = function (k) { return IDB.kvDel(k); };

  Object.defineProperty(C, 'cacheEnabled', {
    get: function () { return IDB.enabled; },
    set: function (v) { IDB.enabled = !!v; }
  });
  Object.defineProperty(C, 'cacheBudget', {
    get: function () { return IDB.budget; },
    set: function (v) { IDB.budget = v; }
  });

  /* 按浏览器给的配额自动定缓存上限：目标是放得下整个语料，
     但不超过浏览器实际可用空间的 60%，也不超过 1.5 GB。 */
  C.tuneBudget = function (corpusBytes) {
    return C.storageEstimate().then(function (est) {
      var MAX = 1500 * 1024 * 1024, MIN = 200 * 1024 * 1024, FLOOR = 300 * 1024 * 1024;
      var want = Math.max(corpusBytes ? corpusBytes * 1.15 : 0, FLOOR);
      var hard = MAX;
      if (est && est.quota) hard = Math.min(hard, Math.floor(est.quota * 0.6));
      IDB.budget = Math.max(MIN, Math.min(want, hard));
      return { budget: IDB.budget, quota: est && est.quota, usage: est && est.usage };
    }).catch(function () { return { budget: IDB.budget }; });
  };

  C.askPersist = function () {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persisted().then(function (p) {
          return p ? true : navigator.storage.persist();
        }).catch(function () { return false; });
      }
    } catch (e) {}
    return Promise.resolve(false);
  };

  C.storageEstimate = function () {
    try {
      if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
    } catch (e) {}
    return Promise.resolve(null);
  };

  /* ===================== 取文件内容 ===================== */
  /* 先看本机缓存，再走网络；网络时报告进度。返回 Uint8Array */
  C.getBytes = function (url, path, size, opts) {
    opts = opts || {};
    return C.cacheGet(path, size).then(function (hit) {
      if (hit) {
        if (opts.onProgress) opts.onProgress(hit.length, size, true);
        return hit;
      }
      return fetch(url, { cache: 'default' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var total = parseInt(res.headers.get('content-length') || '0', 10) || size || 0;
        if (!res.body || !res.body.getReader) {
          return res.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        }
        var reader = res.body.getReader();
        var chunks = [], got = 0;
        function step() {
          return reader.read().then(function (r) {
            if (r.done) return null;
            chunks.push(r.value); got += r.value.byteLength;
            if (opts.onProgress) opts.onProgress(got, total, false);
            return step();
          });
        }
        return step().then(function () {
          var out = new Uint8Array(got), o = 0;
          for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].byteLength; }
          if (!opts.noCache && !opts.truncated) C.cachePut(path, size || got, out);
          return out;
        });
      });
    });
  };

  /* ===================== 高亮 ===================== */
  C.makeHighlighter = function (kw, ci, rx) {
    if (!kw) return null;
    var src = rx ? kw : CU.escapeRegExp(kw);
    var flags = 'g' + (ci ? 'i' : '');
    try { return new RegExp(src, flags); } catch (e) { return null; }
  };

  C.highlight = function (text, re) {
    var frag = document.createDocumentFragment();
    if (!re) { frag.appendChild(document.createTextNode(text)); return frag; }
    re.lastIndex = 0;
    var last = 0, m, guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 2000) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var mk = document.createElement('mark');
      mk.textContent = m[0];
      frag.appendChild(mk);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  };

  /* ===================== 手机防误触点击 ===================== */
  /* 必须是「按下与抬起几乎在同一点、且 700ms 内」的干净轻点；
     滑动 / 拖动 / 长按选字都不会触发。 */
  C.bindTap = function (el, fn) {
    var down = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    });
    el.addEventListener('pointermove', function (e) {
      if (!down || down.id !== e.pointerId) return;
      if (Math.abs(e.clientX - down.x) > 12 || Math.abs(e.clientY - down.y) > 12) down = null;
    });
    el.addEventListener('pointercancel', function () { down = null; });
    el.addEventListener('pointerup', function (e) {
      if (!down || down.id !== e.pointerId) return;
      var ok = Math.abs(e.clientX - down.x) <= 10 &&
               Math.abs(e.clientY - down.y) <= 10 &&
               (Date.now() - down.t) <= 700;
      down = null;
      if (ok) { e.preventDefault(); fn(e); }
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
    });
  };

  /* ===================== 文件清单来源：本地文件夹 ===================== */
  /* 兜底/离线模式：直接读本机文件夹，不上传任何数据 */
  C.collectFromInput = function (fileList, stripTop) {
    var out = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rel = f.webkitRelativePath || f.name;
      if (!/\.txt$/i.test(rel)) continue;
      if (stripTop) {
        var p = rel.split('/');
        if (p.length > 1) rel = p.slice(1).join('/');
      }
      out.push({ path: rel, size: f.size, file: f });
    }
    out.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    return out;
  };

  global.C = C;
})(this);
