/* ============================================================================
 * core-util.js —— 纯逻辑，Worker 与主线程共用（不碰 DOM，可 importScripts）
 * 全部是 HTML + JS，没有后端、没有构建依赖。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var CU = {};

  /* ---------------- 编码探测 ---------------- */
  /* 先试 UTF-8；切片末尾可能切断一个汉字，所以失败时往前退 1~3 字节再试。
     这个坑很关键：本语料里 100 多个 UTF-8 文件会被误判成 GBK。 */
  CU.sniffEncoding = function (bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
    var probe = bytes.subarray(0, Math.min(bytes.length, 65536));
    for (var cut = 0; cut <= 3; cut++) {
      var end = probe.length - cut;
      if (end <= 0) break;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(probe.subarray(0, end));
        return 'utf-8';
      } catch (e) { /* 继续往前退 */ }
    }
    return 'gb18030';
  };

  /* ---------------- 关键词匹配器 ---------------- */
  CU.escapeRegExp = function (s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  /* 返回 (line) -> 该行出现次数（0 表示不匹配）。字面量走 indexOf，最快。 */
  CU.buildTester = function (kw, ci, rx) {
    if (rx) {
      var re = new RegExp(kw, ci ? 'gi' : 'g');
      return function (line) {
        re.lastIndex = 0;
        var n = 0, m;
        while ((m = re.exec(line)) !== null) {
          if (m[0] === '') { re.lastIndex++; continue; }
          n++;
          if (n > 5000) break;
        }
        return n;
      };
    }
    if (ci) {
      var k = kw.toLowerCase();
      var kl = k.length;
      return function (line) {
        var t = line.toLowerCase();
        var n = 0, i = t.indexOf(k);
        while (i >= 0) { n++; i = t.indexOf(k, i + kl); if (n > 5000) break; }
        return n;
      };
    }
    var k2 = kw, kl2 = kw.length;
    return function (line) {
      var n = 0, i = line.indexOf(k2);
      while (i >= 0) { n++; i = line.indexOf(k2, i + kl2); if (n > 5000) break; }
      return n;
    };
  };

  /* 把一段文本按行切开并逐行匹配。返回 [已处理行数, 残留尾巴] */
  CU.scanText = function (text, carry, lineNo, tester, cap, hits) {
    var parts = text.split('\n');
    var tail = parts.pop();
    var n = parts.length;
    for (var i = 0; i < n; i++) {
      var line = parts[i];
      if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      lineNo++;
      var c = tester(line);
      if (c) {
        hits.occ += c;
        if (hits.list.length < cap) hits.list.push([lineNo, line, c]);
        else { hits.truncated = true; return [lineNo, tail]; }
      }
    }
    return [lineNo, tail];
  };

  /* ---------------- 流式搜索一个文件 ---------------- */
  /**
   * getStream: () => Promise<ReadableStream<Uint8Array>>
   * opts: {kw, ci, rx, cap}
   * hooks: {onProgress(bytes), onEncoding(enc)}
   * 返回 {hits:[[行号,整行文字,出现次数]], occ, truncated, lines, bytes, enc}
   *
   * 行号规则与 reader 完全一致：以 \n 分行，文件末尾的换行不额外算一行。
   */
  CU.searchOne = function (getStream, opts, hooks) {
    hooks = hooks || {};
    var cap = opts.cap > 0 ? opts.cap : 1000000;
    var hits = { list: [], occ: 0, truncated: false };
    var bytes = 0, lineNo = 0, carry = '', enc = 'utf-8';
    var tester = CU.buildTester(opts.kw, opts.ci, opts.rx);

    return Promise.resolve(getStream()).then(function (body) {
      var reader = body.getReader();
      return reader.read().then(function first(r0) {
        if (r0.done) {
          return { hits: [], occ: 0, truncated: false, lines: 0, bytes: 0, enc: enc };
        }
        enc = opts.enc || CU.sniffEncoding(r0.value);
        if (hooks.onEncoding) hooks.onEncoding(enc);
        var dec = new TextDecoder(enc);
        var chunk = r0.value;

        function step() {
          bytes += chunk.byteLength;
          var text = carry + dec.decode(chunk, { stream: true });
          var res = CU.scanText(text, carry, lineNo, tester, cap, hits);
          lineNo = res[0]; carry = res[1];
          if (hooks.onProgress) hooks.onProgress(bytes);
          if (hits.truncated) { try { reader.cancel(); } catch (e) {} return null; }
          return reader.read().then(function (r) {
            if (r.done) return null;
            chunk = r.value;
            return step();
          });
        }
        return step();
      }).then(function () {
        if (!hits.truncated && carry !== '') {
          var line = carry;
          if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
          lineNo++;
          var c = tester(line);
          if (c) {
            hits.occ += c;
            if (hits.list.length < cap) hits.list.push([lineNo, line, c]);
            else hits.truncated = true;
          }
        }
        return {
          hits: hits.list, occ: hits.occ, truncated: hits.truncated,
          lines: lineNo, bytes: bytes, enc: enc
        };
      });
    });
  };

  /* ---------------- 在内存里扫出所有命中行（阅读器用） ---------------- */
  /* 分片 + 让出主线程，避免大文件卡住界面 */
  CU.findMatchLines = function (bytes, total, kw, ci, rx, onProgress) {
    var offs = arguments[6];
    var tester = CU.buildTester(kw, ci, rx);
    var out = [];
    var enc = arguments[7] || 'utf-8';
    var dec = new TextDecoder(enc);
    var CH = 4000;
    var i = 1;
    function slice() {
      var end = Math.min(total, i + CH - 1);
      for (; i <= end; i++) {
        var s = offs[i - 1];
        var e = (i < total) ? offs[i] - 1 : bytes.length;
        var line = dec.decode(bytes.subarray(s, e));
        if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
        if (tester(line)) out.push(i);
      }
      if (onProgress) onProgress(i, total);
      if (i <= total) return new Promise(function (r) { setTimeout(r, 0); }).then(slice);
      return out;
    }
    return Promise.resolve().then(slice);
  };

  /* ---------------- 杂项 ---------------- */
  CU.fmtBytes = function (b) {
    if (b == null) return '—';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  };
  CU.fmtNum = function (n) {
    return (n == null ? '—' : String(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  /* 路径分段编码，中文/空格/括号都能正确取到 */
  CU.fileUrl = function (root, path, bust) {
    var segs = String(path).split('/').map(encodeURIComponent);
    var u = (root ? encodeURIComponent(root) + '/' : '') + segs.join('/');
    return bust ? u + '?v=' + bust : u;
  };

  global.CU = CU;
})(typeof self !== 'undefined' ? self : this);
