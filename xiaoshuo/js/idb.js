/* ============================================================================
 * idb.js —— 本机缓存（IndexedDB）。主线程与 Worker 共用（可 importScripts）。
 *
 * 为什么要它：GitHub Pages 从边缘节点回源拉文件时只有几十 KB/s（实测约 36 KB/s），
 * 而命中边缘缓存后有 2.6 MB/s。641 MB 的语料如果每次搜索都重新下载，
 * 用户要等十几分钟。所以下载过的书必须留在本机，第二次搜索直接读本地。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var DB_NAME = 'txtsearch';
  var DB_VER = 3;

  var IDB = {
    enabled: true,
    budget: 1200 * 1024 * 1024,   // 默认最多占 1.2 GB（够放下全部 641 MB 语料）
    _db: null,
    _opening: null,
    _evicting: null,
    _lastEvict: 0
  };

  function openDB() {
    if (IDB._db) return Promise.resolve(IDB._db);
    if (IDB._opening) return IDB._opening;
    IDB._opening = new Promise(function (res, rej) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { rej(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = function () { IDB._db = req.result; res(IDB._db); };
      req.onerror = function () { rej(req.error); };
    });
    return IDB._opening;
  }

  function tx(db, stores, mode) { return db.transaction(stores, mode); }
  function done(t) {
    return new Promise(function (res) {
      t.oncomplete = function () { res(true); };
      t.onerror = function () { res(false); };
      t.onabort = function () { res(false); };
    });
  }
  function wrap(request) {
    return new Promise(function (res, rej) {
      request.onsuccess = function () { res(request.result); };
      request.onerror = function () { rej(request.error); };
    });
  }

  /* 取一份缓存；size 对不上（文件换过）就当没缓存 */
  IDB.get = function (path, size) {
    if (!IDB.enabled) return Promise.resolve(null);
    return openDB().then(function (db) {
      var t = tx(db, ['meta', 'data'], 'readonly');
      return Promise.all([
        wrap(t.objectStore('meta').get(path)),
        wrap(t.objectStore('data').get(path))
      ]).then(function (r) {
        var meta = r[0], rec = r[1];
        if (!meta || !rec || !rec.data) return null;
        if (size && meta.size !== size) return null;
        meta.ts = Date.now();
        try { tx(db, ['meta'], 'readwrite').objectStore('meta').put(meta); } catch (e) {}
        return new Uint8Array(rec.data);
      });
    }).catch(function () { return null; });
  };

  IDB.has = function (path, size) {
    return IDB.getMeta(path).then(function (m) {
      return !!(m && (!size || m.size === size));
    });
  };

  IDB.getMeta = function (path) {
    if (!IDB.enabled) return Promise.resolve(null);
    return openDB().then(function (db) {
      var t = tx(db, ['meta'], 'readonly');
      return wrap(t.objectStore('meta').get(path));
    }).catch(function () { return null; });
  };

  IDB.put = function (path, size, bytes) {
    if (!IDB.enabled || !bytes || !bytes.length) return Promise.resolve(false);
    var buf;
    try { buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    catch (e) { return Promise.resolve(false); }
    return openDB().then(function (db) {
      var t = tx(db, ['meta', 'data'], 'readwrite');
      t.objectStore('meta').put({ k: path, size: size || bytes.length, ts: Date.now() });
      t.objectStore('data').put({ k: path, data: buf });
      return done(t);
    }).then(function () { return IDB.evict(); }).catch(function () { return false; });
  };

  /* 返回 {path: size}，用来预估本次还要下载多少 */
  IDB.index = function () {
    var map = {};
    if (!IDB.enabled) return Promise.resolve(map);
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

  IDB.stats = function () {
    return openDB().then(function (db) {
      var t = tx(db, ['meta'], 'readonly');
      var total = 0, count = 0;
      return new Promise(function (res) {
        var cur = t.objectStore('meta').openCursor();
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

  /* 超过预算就按最久没用过的先删；8 秒内不重复做（多个 Worker 会同时写） */
  IDB.evict = function (force) {
    if (IDB._evicting) return IDB._evicting;
    if (!force && Date.now() - IDB._lastEvict < 8000) return Promise.resolve(0);
    IDB._lastEvict = Date.now();
    IDB._evicting = openDB().then(function (db) {
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
        if (total <= IDB.budget) return 0;
        rows.sort(function (a, b) { return a.ts - b.ts; });
        var del = [];
        for (var i = 0; i < rows.length && total > IDB.budget; i++) {
          total -= rows[i].size; del.push(rows[i].k);
        }
        if (!del.length) return 0;
        var t2 = tx(db, ['meta', 'data'], 'readwrite');
        var ms = t2.objectStore('meta'), ds = t2.objectStore('data');
        del.forEach(function (k) { ms.delete(k); ds.delete(k); });
        return done(t2).then(function () { return del.length; });
      });
    }).catch(function () { return 0; });
    IDB._evicting.then(function () { IDB._evicting = null; });
    return IDB._evicting;
  };

  IDB.clear = function () {
    return openDB().then(function (db) {
      var t = tx(db, ['meta', 'data'], 'readwrite');
      t.objectStore('meta').clear();
      t.objectStore('data').clear();
      return done(t);
    }).catch(function () { return false; });
  };

  /* ---------- 杂项键值（用来记住上次选过的本地文件夹） ---------- */
  IDB.kvGet = function (k) {
    return openDB().then(function (db) {
      var t = tx(db, ['kv'], 'readonly');
      return wrap(t.objectStore('kv').get(k)).then(function (rec) {
        return rec ? rec.v : null;
      });
    }).catch(function () { return null; });
  };

  IDB.kvSet = function (k, v) {
    return openDB().then(function (db) {
      var t = tx(db, ['kv'], 'readwrite');
      t.objectStore('kv').put({ k: k, v: v });
      return done(t);
    }).catch(function () { return false; });
  };

  IDB.kvDel = function (k) {
    return openDB().then(function (db) {
      var t = tx(db, ['kv'], 'readwrite');
      t.objectStore('kv').delete(k);
      return done(t);
    }).catch(function () { return false; });
  };

  global.IDB = IDB;
})(typeof self !== 'undefined' ? self : this);
