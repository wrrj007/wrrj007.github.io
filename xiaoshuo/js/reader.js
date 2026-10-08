/* ============================================================================
 * reader.js —— 阅读页：把整个文件取到内存（优先用本机缓存），
 * 建立行号索引，再按需分块渲染。67 万行的大文件也只保留视口附近的分块。
 * ==========================================================================*/
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var view = $('#view'), inner = $('#inner'),
      titleEl = $('#title'), posEl = $('#pos'), qbar = $('#qbar');

  var CHUNK = 150;          // 每块行数
  var KEEP_RADIUS = 5;      // 视口所在块前后各保留几块，其余从 DOM 回收

  var S = {
    path: '', root: '', q: '', ci: true, local: false, src: '',
    bytes: null, offs: null, total: 0, contentEnd: 0, enc: 'utf-8', dec: null,
    chunks: {}, pending: {}, maxChunk: 0,
    target: 1, matches: [], mi: -1,
    raf: 0, fontSize: 16, ready: false
  };

  /* ==================== 取内容 ==================== */
  function fail(msg) {
    inner.innerHTML = '<div class="err">' + msg + '</div>';
    titleEl.textContent = '打开失败';
    $('#pos').textContent = '—';
  }

  function getContent() {
    var wrap = document.createElement('div');
    wrap.className = 'loading';
    wrap.textContent = '正在打开…';
    inner.innerHTML = '';
    inner.appendChild(wrap);

    var path = S.path, root = S.root;

    /* 缓存 → 网络。blob 地址失败时也退到这里，两条路都走不通才报错。 */
    function fromCacheOrNet() {
      return C.cacheGet(path, null).then(function (hit) {
        if (hit && hit.length) {
          wrap.textContent = '已从本机缓存读取（' + CU.fmtBytes(hit.length) + '）';
          return hit;
        }
        if (S.local) {
          throw new Error('本机模式：这个文件还没有缓存。<br>请回到搜索页重新点一次这一行。');
        }
        wrap.textContent = '正在下载…';
        var url = CU.fileUrl(root, path);
        return C.getBytes(url, path, 0, {
          onProgress: function (got, total) {
            wrap.textContent = '正在下载 ' + CU.fmtBytes(got) + (total ? ' / ' + CU.fmtBytes(total) : '') + '…';
          }
        });
      }).then(function (bytes) {
        if (!bytes || !bytes.length) throw new Error('文件内容为空');
        return bytes;
      });
    }

    // 1) 本机文件夹模式递过来的 blob: 地址（拿不到就退回缓存/网络）
    if (S.src) {
      wrap.textContent = '正在读取本机文件…';
      return fetch(S.src).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (b) { return new Uint8Array(b); })
        .catch(function (e) {
          console.warn('blob 地址读取失败，改用缓存/网络：', e);
          return fromCacheOrNet();
        });
    }

    // 2) 本机缓存 → 3) 网络
    return fromCacheOrNet();
  }

  /* ==================== 行号索引 ==================== */
  /* 行号规则与搜索端完全一致：以 \n 分行，文件末尾的换行不额外算一行 */
  function buildOffsets(bytes) {
    var len = bytes.length, n = 0, i;
    for (i = 0; i < len; i++) if (bytes[i] === 10) n++;
    var offs = new Uint32Array(n + 1);
    var k = 0;
    offs[0] = 0;
    for (i = 0; i < len; i++) if (bytes[i] === 10) offs[++k] = i + 1;
    var total = offs.length;
    if (len > 0 && bytes[len - 1] === 10) total -= 1;
    if (len === 0) total = 0;
    return { offs: offs, total: total, contentEnd: (len > 0 && bytes[len - 1] === 10) ? len - 1 : len };
  }

  /* 取 [i0, i1]（0 基，含端点）的文本行 */
  function windowLines(i0, i1) {
    var s = S.offs[i0];
    var e = (i1 + 1 < S.total) ? S.offs[i1 + 1] - 1 : S.contentEnd;
    if (e < s) e = s;
    return S.dec.decode(S.bytes.subarray(s, e)).split('\n');
  }

  /* ==================== 分块渲染 ==================== */
  function buildChunkEl(ci) {
    var i0 = ci * CHUNK;
    var i1 = Math.min(S.total - 1, i0 + CHUNK - 1);
    var lines = windowLines(i0, i1);
    var el = document.createElement('div');
    el.className = 'chunk';
    el.dataset.chunk = ci;
    var re = C.makeHighlighter(S.q, S.ci, false);
    var frag = document.createDocumentFragment();
    for (var k = 0; k < lines.length; k++) {
      var n = i0 + k + 1;
      var row = document.createElement('div');
      row.className = 'row';
      row.id = 'L' + n;
      var ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = n;
      var tx = document.createElement('span');
      tx.className = 'tx';
      tx.appendChild(C.highlight(lines[k], re));
      row.appendChild(ln); row.appendChild(tx);
      frag.appendChild(row);
    }
    el.appendChild(frag);
    return el;
  }

  function insertChunk(ci, el) {
    var nextEl = null;
    for (var k in S.chunks) {
      var kk = +k;
      if (kk > ci && (!nextEl || kk < nextEl.k)) nextEl = { k: kk, el: S.chunks[k].el };
    }
    if (nextEl) inner.insertBefore(el, nextEl.el);
    else inner.appendChild(el);
  }

  function loadChunk(ci) {
    if (S.chunks[ci]) return Promise.resolve(S.chunks[ci]);
    if (S.pending[ci]) return S.pending[ci];
    if (ci < 0 || ci > S.maxChunk) return Promise.resolve(null);
    var pr = new Promise(function (res) { setTimeout(res, 0); }).then(function () {
      var el = buildChunkEl(ci);
      insertChunk(ci, el);
      var rec = { el: el, from: ci * CHUNK + 1, to: ci * CHUNK + CHUNK };
      S.chunks[ci] = rec;
      delete S.pending[ci];
      return rec;
    });
    S.pending[ci] = pr;
    return pr;
  }

  /* ==================== 滚动锚定 ==================== */
  function captureAnchor() {
    var vTop = view.getBoundingClientRect().top;
    var best = null;
    for (var k in S.chunks) {
      var r = S.chunks[k].el.getBoundingClientRect();
      if (r.bottom > vTop + 1 && (!best || +k < best.k)) best = { k: +k, dx: r.top - vTop };
    }
    return best;
  }
  function restoreAnchor(a) {
    if (!a || !S.chunks[a.k]) return;
    var vTop = view.getBoundingClientRect().top;
    view.scrollTop += (S.chunks[a.k].el.getBoundingClientRect().top - vTop) - a.dx;
  }
  function topVisibleChunk() {
    var vTop = view.getBoundingClientRect().top, vBot = vTop + view.clientHeight;
    var best = null;
    for (var k in S.chunks) {
      var r = S.chunks[k].el.getBoundingClientRect();
      if (r.bottom > vTop && r.top < vBot && (best === null || +k < best)) best = +k;
    }
    return best;
  }

  function updatePos() {
    var cur = topVisibleChunk();
    if (cur === null) return;
    var c = S.chunks[cur];
    var vTop = view.getBoundingClientRect().top;
    var rows = c.el.children, n = c.from;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getBoundingClientRect().bottom > vTop + 4) { n = c.from + i; break; }
    }
    posEl.textContent = '第 ' + CU.fmtNum(n) + ' 行 / 共 ' + CU.fmtNum(S.total) + ' 行';
  }

  function tick() {
    S.raf = 0;
    if (!S.ready) return;
    var cur = topVisibleChunk();
    if (cur === null) return;
    updatePos();

    var want = [], k;
    for (k = cur - 1; k <= cur + 1; k++) {
      if (k >= 0 && k <= S.maxChunk && !S.chunks[k] && !S.pending[k]) want.push(k);
    }
    var drops = [];
    for (k in S.chunks) if (Math.abs(+k - cur) > KEEP_RADIUS) drops.push(+k);
    if (!want.length && !drops.length) return;

    var anchor = captureAnchor();
    Promise.all(want.map(loadChunk)).then(function () {
      drops.forEach(function (d) {
        var c = S.chunks[d];
        if (c) { c.el.remove(); delete S.chunks[d]; }   // 必须显式移除，否则 DOM 会无限增长
      });
      restoreAnchor(anchor);
    });
  }

  view.addEventListener('scroll', function () {
    if (!S.raf) S.raf = requestAnimationFrame(tick);
  }, { passive: true });

  /* ==================== 定位 ==================== */
  function scrollToLine(n, ratio) {
    var row = document.getElementById('L' + n);
    if (!row) return false;
    var vTop = view.getBoundingClientRect().top;
    var delta = row.getBoundingClientRect().top - vTop;
    var want = view.clientHeight * (ratio == null ? 0.3 : ratio);
    view.scrollTop = Math.max(0, view.scrollTop + delta - want);
    return true;
  }

  function markTarget(n) {
    var old = inner.querySelector('.row.target');
    if (old) old.className = 'row';
    var row = document.getElementById('L' + n);
    if (!row) return;
    row.className = 'row target';
    void row.offsetWidth;
    row.className = 'row target flash';
    setTimeout(function () {
      var r = document.getElementById('L' + n);
      if (r) r.className = 'row target';
    }, 1900);
  }

  function jumpTo(n, opts) {
    opts = opts || {};
    n = Math.max(1, Math.min(n | 0, S.total || 1));
    S.target = n;
    $('#jump').value = n;
    var ci = Math.floor((n - 1) / CHUNK);
    var cur = topVisibleChunk();
    var anchor = captureAnchor();
    var need = [ci, ci - 1, ci + 1].filter(function (k) {
      return k >= 0 && k <= S.maxChunk && !S.chunks[k];
    });
    return Promise.all(need.map(loadChunk)).then(function () {
      if (cur !== null) restoreAnchor(anchor);
      requestAnimationFrame(function () {
        scrollToLine(n, opts.ratio);
        markTarget(n);
        updatePos();
        tick();
      });
    });
  }

  /* ==================== 关键词命中导航 ==================== */
  function loadMatches() {
    if (!S.q) { qbar.hidden = true; return; }
    qbar.hidden = false;
    $('#qtext').textContent = S.q;
    $('#qinfo').textContent = '正在统计…';
    var t0 = Date.now();
    CU.findMatchLines(S.bytes, S.total, S.q, S.ci, false, function (done, total) {
      $('#qinfo').textContent = '正在统计… ' + Math.round(done / total * 100) + '%';
    }, S.offs, S.enc).then(function (lines) {
      S.matches = lines;
      var idx = 0;
      for (var i = 0; i < lines.length; i++) { if (lines[i] >= S.target) { idx = i; break; } idx = i; }
      S.mi = lines.length ? idx : -1;
      updateMatchInfo();
    }).catch(function (e) {
      $('#qinfo').textContent = '统计失败';
      console.warn(e);
    });
  }
  function updateMatchInfo() {
    if (!S.matches.length) { $('#qinfo').innerHTML = '本书中没有「' + esc(S.q) + '」'; return; }
    $('#qinfo').innerHTML = '共 <span class="hitcount">' + CU.fmtNum(S.matches.length) +
      '</span> 处　当前第 ' + (S.mi + 1) + ' 处';
  }
  function stepMatch(d) {
    if (!S.matches.length) return;
    S.mi = (S.mi + d + S.matches.length) % S.matches.length;
    updateMatchInfo();
    jumpTo(S.matches[S.mi], { ratio: 0.35 });
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  /* ==================== 字号 ==================== */
  function applyFont(px) {
    S.fontSize = Math.max(12, Math.min(30, px));
    view.style.fontSize = S.fontSize + 'px';
    try { localStorage.setItem('txtReaderFont', String(S.fontSize)); } catch (e) {}
  }

  /* ==================== 启动 ==================== */
  function boot() {
    var p = new URLSearchParams(location.search);
    S.path = p.get('path') || '';
    S.root = p.get('root') || '';
    S.line = Math.max(1, parseInt(p.get('line') || '1', 10) || 1);
    S.q = p.get('q') || '';
    S.ci = p.get('ci') !== '0';
    S.local = p.get('local') === '1';
    S.src = p.get('src') || '';

    var fs = 16;
    try { fs = parseInt(localStorage.getItem('txtReaderFont') || '16', 10) || 16; } catch (e) {}
    applyFont(fs);

    if (!S.path) { fail('缺少参数 <code>path</code>。<br>请从搜索页点击某一行结果进入。'); return; }
    titleEl.textContent = S.path.split('/').pop();

    getContent().then(function (bytes) {
      var t0 = Date.now();
      S.bytes = bytes;
      S.enc = CU.sniffEncoding(bytes);
      S.dec = new TextDecoder(S.enc);
      var off = buildOffsets(bytes);
      S.offs = off.offs; S.total = off.total; S.contentEnd = off.contentEnd;
      S.maxChunk = Math.max(0, Math.floor((S.total - 1) / CHUNK));

      titleEl.textContent = S.path.split('/').pop() + '  ·  ' + CU.fmtBytes(bytes.length) +
        (S.enc === 'utf-8' ? '' : '  ·  ' + S.enc);
      $('#jump').max = S.total;

      var target = Math.max(1, Math.min(S.line, S.total));
      S.target = target;
      $('#jump').value = target;

      var ci = Math.floor((target - 1) / CHUNK);
      var need = [ci - 1, ci, ci + 1].filter(function (k) { return k >= 0 && k <= S.maxChunk; });
      return Promise.all(need.map(loadChunk)).then(function () {
        S.ready = true;
        requestAnimationFrame(function () {
          scrollToLine(target, 0.3);
          markTarget(target);
          updatePos();
          tick();
        });
        // 后台继续补块，滑动更顺
        setTimeout(function () {
          var anchor = captureAnchor();
          var rest = [ci - 2, ci + 2, ci - 3, ci + 3];
          var chain = Promise.resolve();
          rest.forEach(function (k) {
            chain = chain.then(function () {
              var a = captureAnchor();
              return loadChunk(k).then(function () {
                if (topVisibleChunk() !== null) restoreAnchor(a);
              });
            });
          });
          chain.then(function () { restoreAnchor(anchor); updatePos(); });
        }, 120);
        loadMatches();
        console.log('打开用时 ' + (Date.now() - t0) + ' ms，共 ' + S.total + ' 行，' + S.enc);
      });
    }).catch(function (e) {
      fail('无法打开：' + ((e && e.message) || e) +
        '<br><small>如果是从 GitHub Pages 打开，请确认这个 TXT 已经一起上传；' +
        '如果是本机文件夹模式，请回到搜索页重新点一次。</small>');
    });
  }

  /* ==================== 交互 ==================== */
  $('#jumpBtn').addEventListener('click', function () {
    var n = parseInt($('#jump').value, 10);
    if (n > 0) jumpTo(n, { ratio: 0.3 });
  });
  $('#jump').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#jump').blur();
      var n = parseInt($('#jump').value, 10);
      if (n > 0) jumpTo(n, { ratio: 0.3 });
    }
  });
  $('#prevM').addEventListener('click', function () { stepMatch(-1); });
  $('#nextM').addEventListener('click', function () { stepMatch(1); });
  $('#fUp').addEventListener('click', function () { applyFont(S.fontSize + 1); });
  $('#fDown').addEventListener('click', function () { applyFont(S.fontSize - 1); });
  $('#back').addEventListener('click', function () {
    if (window.opener && !window.opener.closed) window.close();
    else if (history.length > 1) history.back();
    else location.href = 'index.html';
  });
  $('#q2').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var v = $('#q2').value.trim();
    if (!v) return;
    S.q = v;
    S.matches = []; S.mi = -1;
    $('#q2').value = '';
    // 清掉已渲染的分块，让它们按新关键词重新高亮
    var keep = Object.keys(S.chunks).map(Number);
    inner.innerHTML = '';
    S.chunks = {}; S.pending = {};
    Promise.all(keep.map(loadChunk)).then(function () {
      scrollToLine(S.target, 0.3);
      tick();
    });
    loadMatches();
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'n' || e.key === ']') stepMatch(1);
    if (e.key === 'p' || e.key === '[') stepMatch(-1);
    if (e.key === '/') { e.preventDefault(); $('#jump').focus(); }
  });

  boot();
})();
