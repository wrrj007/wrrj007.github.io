/* Worker：先查本机缓存，没有才下载；边下边搜；整本读完的写回缓存。
   这样第一次搜索付下载的代价，之后同一本书再搜就是纯本地扫描。 */
importScripts('core-util.js', 'idb.js');

var lastPost = 0;

/* 把已缓存的字节切成小块喂给搜索器，和流式下载走同一条代码路径 */
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

function fail(id, path, err) {
  self.postMessage({ type: 'failed', id: id, path: path, error: String((err && err.message) || err) });
}

self.onmessage = function (e) {
  var m = e.data;
  if (!m) return;

  /* ---------- 只下载并缓存，不搜索（「缓存整个书库」用） ---------- */
  if (m.type === 'warm') {
    if (!IDB.enabled || m.file) {
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

  /* ---------- 搜索：缓存优先 ---------- */
  var fromCache = false;
  IDB.get(m.path, m.size).then(function (hit) {
    fromCache = !!hit;
    // 只有「真的从网络下的、而且整本读完了」才值得写缓存；本机文件夹模式不用缓存
    m.opts.collect = !fromCache && !m.file;

    var getStream;
    if (fromCache) getStream = function () { return Promise.resolve(bytesStream(hit, 262144)); };
    else if (m.file) getStream = function () { return m.file.stream(); };
    else getStream = function () { return netStream(m.url); };

    return CU.searchOne(getStream, m.opts, {
      onProgress: fromCache ? null : function (b) {
        var now = Date.now();
        if (now - lastPost > 120) {
          lastPost = now;
          self.postMessage({ type: 'progress', id: m.id, bytes: b });
        }
      }
    }).then(function (res) {
      var raw = res.raw;
      var out = {
        type: 'result', id: m.id, path: m.path, size: m.size, fromCache: fromCache,
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
    });
  }).catch(function (err) { fail(m.id, m.path, err); });
};
