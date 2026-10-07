/* Worker：流式下载 + 逐行搜索。不依赖任何后端。 */
importScripts('core-util.js');

var lastPost = 0;

self.onmessage = function (e) {
  var m = e.data;
  if (!m || m.type !== 'job') return;

  var getStream = m.file
    ? function () { return m.file.stream(); }
    : function () {
        return fetch(m.url, { cache: 'default' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.body;
        });
      };

  CU.searchOne(getStream, m.opts, {
    onProgress: function (b) {
      var now = Date.now();
      if (now - lastPost > 120) {          // 节流，避免海量小消息
        lastPost = now;
        self.postMessage({ type: 'progress', id: m.id, bytes: b });
      }
    }
  }).then(function (res) {
    self.postMessage({
      type: 'result', id: m.id, path: m.path, size: m.size,
      hits: res.hits, occ: res.occ, truncated: res.truncated,
      lines: res.lines, bytes: res.bytes, enc: res.enc
    });
  }).catch(function (err) {
    self.postMessage({ type: 'failed', id: m.id, path: m.path, error: String((err && err.message) || err) });
  });
};
