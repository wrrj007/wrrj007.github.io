/* ============================================================================
 * common.js —— 主线程公用：本机缓存（IndexedDB）、取文件、高亮、防误触点击
 * ==========================================================================*/
(function (global) {
  'use strict';

  var C = {};
  var DB_NAME = 'txtsearch';
  var DB_VER = 2;

  /* ===================== IndexedDB 本机缓存 ===================== */
  var _db = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { rej(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function tx(db, stores, mode) { return db.transaction(stores, mode); }
  function wrap(request) {
    return new Promise(function (res, rej) {
      request.onsuccess = function () { res(request.result); };
      request.onerror = function () { rej(request.error); };
    });
  }

  C.cacheEnabled = true;
  C.cacheBudget = 400 * 1024 * 1024;      // 默认最多占 400 MB 本机空间

  C.cacheGet = function (path, size) {
    if (!C.cacheEnabled) return Promise.resolve(null);
    return openDB().then(function (db) {
      var t = tx(db, ['meta', 'data'], 'readonly');
      return Promise.all([
        wrap(t.objectStore('meta').get(path)),
        wrap(t.objectStore('data').get(path))
      ]).then(function (r) {
        var meta = r[0], rec = r[1];
        if (!meta || !rec || (size && meta.size !== size)) return null;
        meta.ts = Date.now();
        try { tx(db, ['meta'], 'readwrite').objectStore('meta').put(meta); } catch (e) {}
        return new Uint8Array(rec.data);
      });
    }).catch(function () { return null; });
  };

  C.cachePut = function (path, size, bytes) {
    if (!C.cacheEnabled || !size) return Promise.resolve();
    var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return openDB().then(function (db) {
      var t = tx(db, ['meta', 'data'], 'readwrite');
      t.objectStore('meta').put({ k: path, size: size, ts: Date.now() });
      t.objectStore('data').put({ k: path, data: buf });
      return new Promise(function (res) { t.oncomplete = res; t.onerror = function () { res(); }; t.onabort = function () { res(); }; });
    }).then(function () { return C.cacheEvict(); }).catch(function () {});
  };

  C.cacheStats = function () {
    return openDB().then(function (db) {
      var t = tx(db, ['meta'], 'readonly');
      var store = t.objectStore('meta');
      var total = 0, count = 0;
      return new Promise(function (res) {
        var cur = store.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) { res({ bytes: total, count: count }); return; }
          total += c.value.size || 0; count++;
          c.continue();
        };
        cur.onerror = function () { res({ bytes: 0, count: 0 }); };
      });
    }).catch(function () { return { bytes: 0, count: 0 }; });
  };

  /* 一次读出所有缓存条目的 path->size，便于预估本次要下载多少 */
  C.cacheIndex = function () {
    var map = {};
    if (!C.cacheEnabled) return Promise.resolve(map);
    return openDB().then(function (db) {
      var t = tx(db, ['meta'], 'readonly');
      return new Promise(function (res) {
        var cur = t.objectStore('meta').openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) { res(map); return; }
          map[c.value.k] = c.value.size || 0;
          c.continue();
        };
        cur.onerror = function () { res(map); };
      });
    }).catch(function () { return map; });
  };

  C.cacheEvict = function () {    return openDB().then(function (db) {
      var t = tx(db, ['meta'], 'readonly');
      var rows = [];
      return new Promise(function (res) {
        var cur = t.objectStore('meta').openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) { res(rows); return; }
          rows.push({ k: c.value.k, size: c.value.size || 0, ts: c.value.ts || 0 });
          c.continue();
        };
        cur.onerror = function () { res(rows); };
      }).then(function (rows) {
        var total = rows.reduce(function (s, r) { return s + r.size; }, 0);
        if (total <= C.cacheBudget) return 0;
        rows.sort(function (a, b) { return a.ts - b.ts; });
        var del = [];
        for (var i = 0; i < rows.length && total > C.cacheBudget; i++) {
          total -= rows[i].size; del.push(rows[i].k);
        }
        if (!del.length) return 0;
        var t2 = tx(db, ['meta', 'data'], 'readwrite');
        var ms = t2.objectStore('meta'), ds = t2.objectStore('data');
        del.forEach(function (k) { ms.delete(k); ds.delete(k); });
        return new Promise(function (r) { t2.oncomplete = function () { r(del.length); }; t2.onerror = function () { r(0); }; });
      });
    }).catch(function () { return 0; });
  };

  C.cacheClear = function () {
    return openDB().then(function (db) {
      var t = tx(db, ['meta', 'data'], 'readwrite');
      t.objectStore('meta').clear();
      t.objectStore('data').clear();
      return new Promise(function (r) { t.oncomplete = function () { r(true); }; t.onerror = function () { r(false); }; });
    }).catch(function () { return false; });
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
        if (!res.body || !res.body.getReader) return res.arrayBuffer().then(function (b) { return new Uint8Array(b); });
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
