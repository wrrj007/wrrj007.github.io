/* Worker 的三种取数方式：
 *   1) 本机文件夹（File / FileSystemFileHandle）—— 直接读硬盘，一次性读完，最快，不联网也不用缓存
 *   2) 本机缓存（IndexedDB）—— 网络文件读过一次后，第二次不再下载
 *   3) 网络（fetch）—— 边下边搜，整本读完的写回缓存
 */
importScripts('core-util.js', 'idb.js');

var lastPost = 0;
var LOCAL_CHUNK = 4 * 1024 * 1024;   // 本机文件用大块，省掉小块流的开销

/* 把字节切成小块喂给搜索器（和流式下载同一条代码路径） */
function bytesStream(bytes, size) {
  var off = 0;
  return new ReadableStream({
    pull: function (c) {
      if (off >= bytes.length) { c.close(); return; }
      var end = Math.min(bytes.length, off + size);
      c.enqueue(bytes.subarray(off, end));
      off = end;
    }
  });
}

function netStream(url) {
  return fetch(url, { cache: 'default' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!r.body || !r.body.getReader) {
      return r.arrayBuffer().then(function (b) { return bytesStream(new Uint8Array(b), 262144); });
    }
    return r.body;
  });
}

/* 本机文件：一次读完再搜，比按小块流式读快；不是本机文件则返回 null */
function readLocal(m) {
  if (m.file) {
    return Promise.resolve(m.file.arrayBuffer()).then(function (b) { return new Uint8Array(b); });
  }
  if (m.handle) {
    return Promise.resolve(m.handle.getFile())
      .then(function (f) { return f.arrayBuffer(); })
      .then(function (b) { return new Uint8Array(b); });
  }
  return null;
}

function fail(id, path, err) {
  self.postMessage({ type: 'failed', id: id, path: path, error: String((err && err.message) || err) });
}

function postResult(m, res, fromCache, local) {
  var raw = res.raw;
  var out = {
    type: 'result', id: m.id, path: m.path, size: m.size,
    fromCache: !!fromCache, local: !!local,
    hits: res.hits, occ: res.occ, truncated: res.truncated,
    lines: res.lines, bytes: res.bytes, enc: res.enc
  };
  // 先把缓存写好再上报结果：否则下一次搜索可能赶在写入之前开始，
  // 用户会看到「刚搜完却显示没缓存」。
  if (raw && raw.length) {
    IDB.put(m.path, m.size || raw.length, raw).then(function () { self.postMessage(out); });
  } else {
    self.postMessage(out);
  }
}

self.onmessage = function (e) {
  var m = e.data;
  if (!m) return;

  /* ---------- 只下载并缓存，不搜索（「缓存整个书库」用） ---------- */
  if (m.type === 'warm') {
    if (!IDB.enabled || m.file || m.handle) {      // 本机文件本来就在本机，不用缓存
      self.postMessage({ type: 'warmed', id: m.id, path: m.path, bytes: 0, skipped: true });
      return;
    }
    IDB.getMeta(m.path).then(function (meta) {
      if (meta && (!m.size || meta.size === m.size)) {
        self.postMessage({ type: 'warmed', id: m.id, path: m.path, bytes: 0, cached: true });
        return;
      }
      return fetch(m.url, { cache: 'default' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var u8 = new Uint8Array(buf);
        self.postMessage({ type: 'warmed', id: m.id, path: m.path, bytes: u8.length });
        return IDB.put(m.path, m.size || u8.length, u8);
      });
    }).catch(function (err) { fail(m.id, m.path, err); });
    return;
  }

  if (m.type !== 'job') return;

  /* ---------- 1) 本机文件夹：直接读盘，不走网络也不查缓存 ---------- */
  var localP = readLocal(m);
  if (localP) {
    m.opts.collect = false;
    localP.then(function (u8) {
      return CU.searchOne(function () { return Promise.resolve(bytesStream(u8, LOCAL_CHUNK)); },
        m.opts, null).then(function (res) {
          if (!m.size) m.size = u8.length;
          postResult(m, res, false, true);
        });
    }).catch(function (err) { fail(m.id, m.path, err); });
    return;
  }

  /* ---------- 2/3) 缓存优先，其次网络 ---------- */
  var fromCache = false;
  IDB.get(m.path, m.size).then(function (hit) {
    fromCache = !!hit;
    m.opts.collect = !fromCache;         // 只有真的从网络下的才值得写缓存

    var getStream = hit
      ? function () { return Promise.resolve(bytesStream(hit, 262144)); }
      : function () { return netStream(m.url); };

    return CU.searchOne(getStream, m.opts, {
      onProgress: fromCache ? null : function (b) {
        var now = Date.now();
        if (now - lastPost > 120) {
          lastPost = now;
          self.postMessage({ type: 'progress', id: m.id, bytes: b });
        }
      }
    }).then(function (res) { postResult(m, res, fromCache, false); });
  }).catch(function (err) { fail(m.id, m.path, err); });
};
