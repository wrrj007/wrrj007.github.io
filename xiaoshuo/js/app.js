/* ============================================================================
 * app.js —— 搜索页（纯静态，无后端）
 *
 * 速度上真正要紧的两件事（实测得出）：
 *  1) GitHub Pages 边缘缓存未命中时只有几十 KB/s，命中后有 MB/s 级；
 *     所以「下载过的书必须留在本机」比任何算法优化都重要。
 *  2) 641 MB 语料整本扫描的 CPU 只要约 2 秒，瓶颈从来不是扫描本身。
 * ==========================================================================*/
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var resultsEl = $('#results'), statusEl = $('#status');

  var state = {
    root: '', files: [], local: false,
    busy: false, warming: false, kw: '', cancel: null,
    blocks: {}, order: [],
    totalBytes: 0, doneBytes: 0, doneFiles: 0, totalFiles: 0,
    hitFiles: 0, hitLines: 0, cachedBytes: 0, cachedFiles: 0,
    needBytes: 0, netBytes: 0, fromCacheFiles: 0, t0: 0
  };

  function fmtTime(s) {
    if (!isFinite(s) || s <= 0) return '—';
    if (s < 60) return Math.ceil(s) + ' 秒';
    if (s < 3600) return Math.ceil(s / 60) + ' 分钟';
    return (s / 3600).toFixed(1) + ' 小时';
  }

  /* 把字节切成小块喂给搜索器（和流式下载同一条路径） */
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

  /* ==================== 载入文件清单 ==================== */
  function loadManifest() {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'manifest.js';
      s.onload = function () {
        var m = window.__TXT_MANIFEST;
        if (!m || !m.files || !m.files.length) rej(new Error('manifest.js 里没有文件'));
        else res(m);
      };
      s.onerror = function () { rej(new Error('没有找到 manifest.js')); };
      document.head.appendChild(s);
    });
  }

  function setFilesFromManifest(m) {
    state.root = m.root || '';
    state.local = false;
    state.files = m.files.map(function (f) {
      var path = Array.isArray(f) ? f[0] : f.path;
      var size = Array.isArray(f) ? f[1] : f.size;
      return { path: path, size: size, url: absUrl(CU.fileUrl(state.root, path)) };
    });
    afterFiles('清单');
  }

  /* Worker 里的相对路径是按 js/ 解析的，必须给绝对地址 */
  function absUrl(rel) {
    try { return new URL(rel, location.href).href; } catch (e) { return rel; }
  }

  function afterFiles(how) {
    var total = 0;
    state.files.forEach(function (f) { total += f.size || 0; });
    state.totalBytes = total;
    $('#corpus').textContent = state.files.length + ' 个 TXT · ' + CU.fmtBytes(total);
    buildScope();
    refreshCacheInfo();
    setStatus('已载入 ' + state.files.length + ' 个 TXT（' + CU.fmtBytes(total) + '，来源：' + how + '）');
    $('#hello').innerHTML = '在上方输入关键词开始搜索<br><small>点开某一本后，点任意一行即可在新窗口打开原文并定位到该行</small>';
    resultsEl.innerHTML = '';
    resultsEl.appendChild($('#hello'));
  }

  /* ==================== 范围下拉 ==================== */
  function buildScope() {
    var dirs = {}, i, parts, d;
    state.files.forEach(function (f) {
      parts = f.path.split('/');
      for (i = 1; i < parts.length; i++) {
        d = parts.slice(0, i).join('/');
        if (!dirs[d]) dirs[d] = { n: 0, b: 0 };
        dirs[d].n++; dirs[d].b += f.size || 0;
      }
    });
    var keys = Object.keys(dirs).sort();
    var sel = $('#scope');
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = ''; all.textContent = '全部目录（' + state.files.length + ' 本）';
    sel.appendChild(all);
    keys.forEach(function (k) {
      var depth = k.split('/').length;
      var o = document.createElement('option');
      o.value = k;
      o.textContent = new Array(depth).join('　') + k.split('/').pop() +
                      '（' + dirs[k].n + ' 本 · ' + CU.fmtBytes(dirs[k].b) + '）';
      sel.appendChild(o);
    });
  }

  function scopeFiles() {
    var sc = $('#scope').value;
    if (!sc) return state.files;
    return state.files.filter(function (f) {
      return f.path === sc || f.path.indexOf(sc + '/') === 0;
    });
  }

  /* ==================== 缓存信息 ==================== */
  function refreshCacheInfo() {
    return C.cacheIndex().then(function (idx) {
      var n = 0, b = 0;
      state.files.forEach(function (f) {
        if (idx[f.path] && (!f.size || idx[f.path] === f.size)) { n++; b += f.size || 0; }
      });
      state.cachedFiles = n; state.cachedBytes = b;
      var t = n ? ('已缓存 ' + n + '/' + state.files.length + ' 本 · ' + CU.fmtBytes(b))
                : '（暂无缓存）';
      $('#cacheInfo').textContent = t;
      return idx;
    });
  }

  /* ==================== 状态栏 ==================== */
  function setStatus(html, spin) {
    statusEl.innerHTML = (spin ? '<span class="spin"></span>' : '') + html;
  }
  function setProgress(p) {
    $('#pbarWrap').hidden = false;
    $('#pbar').style.width = Math.max(0, Math.min(100, p * 100)).toFixed(1) + '%';
  }

  /* 速度 / 剩余时间，让「慢」变得看得见 */
  function speedText() {
    var el = (Date.now() - state.t0) / 1000;
    if (el < 0.8 || state.netBytes <= 0) return '';
    var spd = state.netBytes / el;
    var s = '，' + CU.fmtBytes(spd) + '/s';
    var left = state.needBytes - state.netBytes;
    if (left > 0 && spd > 1024) s += '，剩余约 ' + fmtTime(left / spd);
    return s;
  }

  /* ==================== 搜索 ==================== */
  function doSearch() {
    if (state.busy) return;
    var kw = $('#kw').value.trim();
    if (!kw) { setStatus('请输入关键词'); $('#kw').focus(); return; }

    var cap = parseInt($('#cap').value, 10);
    if (isNaN(cap)) cap = 200;
    var opts = { kw: kw, ci: $('#ci').checked, rx: $('#rx').checked, cap: cap };

    if (opts.rx) {
      try { new RegExp(kw); } catch (e) { setStatus('正则表达式错误：' + e.message); return; }
    }

    var files = scopeFiles();
    if (!files.length) { setStatus('该范围内没有 TXT 文件'); return; }

    state.busy = true; state.warming = false; state.kw = kw;
    state.blocks = {}; state.order = [];
    state.doneBytes = 0; state.doneFiles = 0; state.hitFiles = 0; state.hitLines = 0;
    state.netBytes = 0; state.fromCacheFiles = 0;
    state.totalFiles = files.length;
    state.totalBytes = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
    state.t0 = Date.now();
    resultsEl.innerHTML = '';
    $('#go').disabled = true;
    $('#cancel').hidden = false;
    $('#foldBtn').disabled = true;
    $('#warm').disabled = true;
    $('#pbarWrap').hidden = false;
    setProgress(0);

    refreshCacheInfo().then(function (idx) {
      var need = 0, needN = 0;
      files.forEach(function (f) {
        if (!(idx[f.path] && (!f.size || idx[f.path] === f.size))) { need += f.size || 0; needN++; }
      });
      state.needBytes = need;
      var tip = '本范围内 ' + files.length + ' 本 / ' + CU.fmtBytes(state.totalBytes);
      if (needN) tip += '，其中 <b>' + needN + '</b> 本需下载（约 <b>' + CU.fmtBytes(need) + '</b>）';
      else tip += '，<b>已全部在本机缓存中，不用下载</b>';
      setStatus('开始搜索「' + escapeHtml(kw) + '」：' + tip, true);
      startScan(files, opts, state.t0);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }

  function startScan(files, opts, t0) {
    var handlers = {
      onProgress: function (f, bytes) {
        var add = bytes - (f._got || 0);
        if (add <= 0) return;
        f._got = bytes;
        state.doneBytes += add;
        state.netBytes += add;
        tickStatus();
      },
      onResult: function (f, res) {
        state.doneFiles++;
        if (res && res.fromCache) {
          state.fromCacheFiles++;
          state.doneBytes += (f.size || 0);          // 从缓存读的也算「已读取」
        } else if (res && res.bytes != null) {
          /* 进度消息被节流（每 120ms 一条），末段字节数要靠这里补上，
             否则快网络下「已读取」会少报一大截 */
          var add = res.bytes - (f._got || 0);
          if (add > 0) { state.doneBytes += add; state.netBytes += add; }
          f._got = res.bytes;
        }
        if (res.hits && res.hits.length) {
          state.hitFiles++;
          state.hitLines += res.hits.length;
          addBlock({
            path: f.path, name: f.path.split('/').pop(),
            dir: f.path.split('/').slice(0, -1).join(' / '),
            count: res.hits.length, occ: res.occ, truncated: res.truncated,
            lines: res.lines, size: f.size, hits: res.hits,
            local: !!f.file, file: f.file || null
          });
        }
        tickStatus();
      },
      onError: function (f, err) {
        state.doneFiles++;
        console.warn('读取失败', f.path, err);
        tickStatus();
      },
      onDone: function (cancelled) { finish(cancelled, t0); }
    };
    state.cancel = runPool(files, opts, handlers, 'job');
  }

  function tickStatus() {
    var p = state.totalFiles ? state.doneFiles / state.totalFiles : 0;
    setProgress(p);
    setStatus('正在扫描 <b>' + state.doneFiles + '/' + state.totalFiles + '</b> 本，命中 <b>' +
      state.hitFiles + '</b> 本 / <b>' + CU.fmtNum(state.hitLines) + '</b> 行，已读取 <b>' +
      CU.fmtBytes(state.doneBytes) + '</b>' + speedText() + '…', true);
  }

  function finish(cancelled, t0) {
    state.busy = false;
    state.cancel = null;
    $('#go').disabled = false;
    $('#cancel').hidden = true;
    $('#foldBtn').disabled = false;
    $('#warm').disabled = false;
    setProgress(1);
    setTimeout(function () { $('#pbarWrap').hidden = true; }, 800);
    sortAndRank();
    var ms = Date.now() - t0;
    var cachedNote = state.fromCacheFiles ? ('，其中 ' + state.fromCacheFiles + ' 本直接读本机缓存') : '';
    if (cancelled) {
      setStatus('已取消：扫描了 ' + state.doneFiles + '/' + state.totalFiles +
                ' 本，命中 <b>' + CU.fmtNum(state.hitLines) + '</b> 行');
    } else if (!state.hitFiles) {
      setStatus('<span class="ok">✔ 完成</span>：' + state.totalFiles + ' 本中都没有「' +
                escapeHtml(state.kw) + '」，下载 ' + CU.fmtBytes(state.netBytes) + cachedNote +
                '，用时 ' + (ms / 1000).toFixed(1) + ' 秒');
      resultsEl.innerHTML = '<div class="empty">没有找到包含「' + escapeHtml(state.kw) +
        '」的内容<br><small>可试试更短的关键词，或把范围改成「全部目录」</small></div>';
    } else {
      setStatus('<span class="ok">✔ 完成</span>：' + state.hitFiles + ' 本命中，共 <b>' +
        CU.fmtNum(state.hitLines) + '</b> 行结果，下载 ' + CU.fmtBytes(state.netBytes) + cachedNote +
        '，用时 ' + (ms / 1000).toFixed(1) + ' 秒');
    }
    refreshCacheInfo();
    $('#tip').textContent = state.hitFiles
      ? ('共 ' + state.hitFiles + ' 本命中，已按结果条数从多到少排列；点文件名展开/折叠，点任意一行在新窗口打开原文并定位。')
      : '';
  }

  /* ==================== 缓存整个书库 ==================== */
  function doWarm() {
    if (state.busy) return;
    if (state.local) { setStatus('本机文件夹模式的文件本来就在本机，不需要缓存'); return; }
    if (!C.cacheEnabled) { setStatus('请先勾上「本机缓存」'); return; }

    refreshCacheInfo().then(function (idx) {
      var todo = state.files.filter(function (f) {
        return !(idx[f.path] && (!f.size || idx[f.path] === f.size));
      });
      if (!todo.length) { setStatus('整个书库都已经在本机缓存里了，搜索不需要联网'); return; }
      var need = todo.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      if (!window.confirm('将下载 ' + todo.length + ' 本（约 ' + CU.fmtBytes(need) +
          '）存到本机。\n下载一次之后，搜索就不用再走网络了。\n\n现在开始吗？')) return;

      state.busy = true; state.warming = true;
      state.doneFiles = 0; state.totalFiles = todo.length;
      state.netBytes = 0; state.doneBytes = 0; state.t0 = Date.now(); state.needBytes = need;
      state.hitFiles = 0; state.hitLines = 0;
      $('#go').disabled = true; $('#warm').disabled = true; $('#cancel').hidden = false;
      setProgress(0);
      setStatus('正在把书库缓存到本机…', true);

      state.cancel = runPool(todo, null, {
        onProgress: function (f, bytes) {
          var add = bytes - (f._got || 0);
          if (add <= 0) return;
          f._got = bytes;
          state.doneBytes += add; state.netBytes += add;
          tickWarm();
        },
        onWarmed: function (f, m) {
          state.doneFiles++;
          if (m && m.cached) state.doneBytes += (f.size || 0);
          tickWarm();
        },
        onError: function (f, err) { state.doneFiles++; console.warn('缓存失败', f.path, err); tickWarm(); },
        onDone: function (cancelled) {
          state.busy = false; state.warming = false; state.cancel = null;
          $('#go').disabled = false; $('#warm').disabled = false; $('#cancel').hidden = true;
          setProgress(1);
          setTimeout(function () { $('#pbarWrap').hidden = true; }, 800);
          refreshCacheInfo().then(function () {
            setStatus((cancelled ? '已取消：' : '<span class="ok">✔ 缓存完成</span>：') +
              '下载 ' + CU.fmtBytes(state.netBytes) + '，用时 ' +
              ((Date.now() - state.t0) / 1000).toFixed(0) + ' 秒。之后的搜索不再需要网络。');
          });
        }
      }, 'warm');
    });
  }

  function tickWarm() {
    var p = state.totalFiles ? state.doneFiles / state.totalFiles : 0;
    setProgress(p);
    setStatus('正在缓存 <b>' + state.doneFiles + '/' + state.totalFiles + '</b> 本，已下载 <b>' +
      CU.fmtBytes(state.netBytes) + '</b>' + speedText() + '…', true);
  }

  /* ==================== 并发执行（Worker 池 / 主线程兜底） ==================== */
  function runPool(files, opts, h, jobType) {
    /* 边缘缓存未命中时单条连接只有几十 KB/s，多开几条并行才吃得满带宽；
       同时别开太多，避免手机上同时抱着十几个大文件。 */
    var hc = navigator.hardwareConcurrency || 4;
    var n = Math.max(4, Math.min(8, hc));
    var workers = [], canWorker = true, i;
    try {
      for (i = 0; i < n; i++) workers.push(new Worker('js/search-worker.js'));
    } catch (e) {
      canWorker = false;
      workers.forEach(function (w) { w.terminate(); });
      workers = [];
      console.warn('Worker 不可用，改用主线程：', e.message);
    }
    if (!canWorker || !workers.length) return runMain(files, opts, h, jobType);

    var next = 0, active = 0, done = false, cancelled = false, ids = [];

    function finishIfDone() {
      if (done) return;
      if (active === 0 && (next >= files.length || cancelled)) {
        done = true;
        workers.forEach(function (w) { w.terminate(); });
        h.onDone(cancelled);
      }
    }
    function dispatch(w) {
      if (cancelled || next >= files.length) { finishIfDone(); return; }
      var f = files[next++];
      active++;
      w.postMessage({
        type: jobType || 'job', id: next, path: f.path, size: f.size, url: f.url,
        file: f.file || null, opts: opts, enc: f.enc
      });
    }
    workers.forEach(function (w) {
      w.onmessage = function (e) {
        var m = e.data;
        var f = files[m.id - 1];
        if (!f) return;
        if (m.type === 'progress') { h.onProgress(f, m.bytes); return; }
        active--;
        if (m.type === 'result') h.onResult(f, m);
        else if (m.type === 'warmed') { if (h.onWarmed) h.onWarmed(f, m); else h.onResult(f, { hits: [], fromCache: !!m.cached }); }
        else if (m.type === 'failed') h.onError(f, m.error);
        dispatch(w);
      };
      w.onerror = function (e) { console.warn('worker error', e.message); };
      dispatch(w);
    });
    return function cancel() {
      cancelled = true;
      workers.forEach(function (w) { w.terminate(); });
      h.onDone(true);
    };
  }

  /* 没有 Worker 时（例如 file:// 打开）退化成主线程，但依然写本机缓存 */
  function runMain(files, opts, h, jobType) {
    var i = 0, cancelled = false, done = false;
    function step() {
      if (cancelled || i >= files.length) {
        if (!done) { done = true; h.onDone(cancelled); }
        return;
      }
      var f = files[i++];
      var load;
      if (f.file) {
        load = f.file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      } else {
        load = C.getBytes(f.url, f.path, f.size, {
          onProgress: function (got) { h.onProgress(f, got); }
        });
      }
      load.then(function (bytes) {
        if (jobType === 'warm') {
          if (h.onWarmed) h.onWarmed(f, { cached: true, bytes: 0 });
          return null;
        }
        return CU.searchOne(function () { return Promise.resolve(bytesStream(bytes, 262144)); },
          opts, null).then(function (res) { h.onResult(f, res); });
      }).catch(function (err) {
        h.onError(f, err);
      }).then(function () {
        return new Promise(function (r) { setTimeout(r, 0); });
      }).then(step);
    }
    step();
    return function cancel() { cancelled = true; };
  }

  /* ==================== 结果渲染 ==================== */
  function addBlock(d) {
    var el = document.createElement('details');
    el.className = 'file';

    var sum = document.createElement('summary');
    var rank = document.createElement('span');
    rank.className = 'rank'; rank.textContent = '·';
    var meta = document.createElement('span');
    meta.className = 'meta';
    var nm = document.createElement('span');
    nm.className = 'fname'; nm.textContent = d.name;
    var sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = (d.dir ? d.dir + ' · ' : '') +
      (d.truncated ? ('≥' + CU.fmtNum(d.lines)) : CU.fmtNum(d.lines)) + ' 行 · ' + CU.fmtBytes(d.size);
    meta.appendChild(nm); meta.appendChild(sub);
    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = d.truncated ? (d.count + '+ 行') : (d.count + ' 行');
    var open = document.createElement('span');
    open.className = 'openbtn';
    open.setAttribute('role', 'button');
    open.tabIndex = 0;
    open.textContent = '打开原文 ↗';
    sum.appendChild(rank); sum.appendChild(meta); sum.appendChild(badge); sum.appendChild(open);
    el.appendChild(sum);

    var wrap = document.createElement('div');
    el.appendChild(wrap);

    var blk = { data: d, el: el, built: false, wrap: wrap, rankEl: rank };
    var build = function () {
      if (blk.built) return;
      blk.built = true;
      var hits = document.createElement('div');
      hits.className = 'hits';
      var re = C.makeHighlighter(state.kw, $('#ci').checked, $('#rx').checked);
      var frag = document.createDocumentFragment();
      d.hits.forEach(function (h) {
        var line = h[0], text = h[1];
        var row = document.createElement('div');
        row.className = 'hit';
        row.tabIndex = 0;
        row.title = '第 ' + line + ' 行 · 点击在新窗口打开并定位';
        var ln = document.createElement('span');
        ln.className = 'ln'; ln.textContent = CU.fmtNum(line);
        var tx = document.createElement('span');
        tx.className = 'tx';
        tx.appendChild(C.highlight(text, re));
        var go = document.createElement('span');
        go.className = 'go'; go.textContent = '↗';
        row.appendChild(ln); row.appendChild(tx); row.appendChild(go);
        C.bindTap(row, function () { openReader(d, line); });
        frag.appendChild(row);
      });
      hits.appendChild(frag);
      if (d.truncated) {
        var more = document.createElement('div');
        more.className = 'more';
        more.textContent = '这本还有更多匹配（已提前停止读取以省流量），这里显示前 ' + d.count +
          ' 行。把「每本最多」调大后重新搜索可以看到更多。';
        hits.appendChild(more);
      }
      wrap.appendChild(hits);
    };
    el.addEventListener('toggle', function () { if (el.open) build(); });
    C.bindTap(open, function (e) { e.stopPropagation(); openReader(d, d.hits[0][0]); });
    open.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

    state.blocks[d.path] = blk;
    state.order.push(d.path);
    resultsEl.appendChild(el);
  }

  function openReader(d, line) {
    var p = new URLSearchParams();
    p.set('path', d.path);
    p.set('line', Math.max(1, line | 0));
    if (state.root) p.set('root', state.root);
    if (state.kw) p.set('q', state.kw);
    if ($('#ci').checked) p.set('ci', '1');
    if (d.file) {
      // 本机文件夹模式：新窗口拿不到 File 对象，用一个 blob: 地址递过去
      try { p.set('src', URL.createObjectURL(d.file)); }
      catch (e) { p.set('local', '1'); }
    } else if (d.local) {
      p.set('local', '1');
    }
    window.open('reader.html?' + p.toString(), '_blank');
  }

  function sortAndRank() {
    state.order.sort(function (a, b) {
      var A = state.blocks[a].data, B = state.blocks[b].data;
      return (B.count - A.count) || (B.occ - A.occ) ||
             (A.name < B.name ? -1 : A.name > B.name ? 1 : 0);
    });
    var frag = document.createDocumentFragment();
    state.order.forEach(function (p, i) {
      var b = state.blocks[p];
      b.rankEl.textContent = i + 1;
      frag.appendChild(b.el);
    });
    resultsEl.appendChild(frag);
  }

  /* ==================== 本机文件夹模式 ==================== */
  function useLocalFiles(fileList) {
    var files = C.collectFromInput(fileList, true);
    if (!files.length) { setStatus('这个文件夹里没有 .txt 文件'); return; }
    state.root = '';
    state.local = true;
    state.files = files.map(function (f) {
      return { path: f.path, size: f.size, file: f.file, url: absUrl(CU.fileUrl('', f.path)) };
    });
    afterFiles('本机文件夹');
    setStatus('已从本机文件夹读入 ' + files.length + ' 个 TXT（共 ' +
      CU.fmtBytes(files.reduce(function (s, f) { return s + f.size; }, 0)) +
      '）。数据不会上传，只在本机搜索。');
  }

  /* ==================== 事件 ==================== */
  $('#form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('#kw').blur();
    doSearch();
  });
  $('#cancel').addEventListener('click', function () {
    if (state.cancel) state.cancel();
  });
  $('#foldBtn').addEventListener('click', function () {
    var all = Array.prototype.slice.call(resultsEl.querySelectorAll('details.file'));
    if (!all.length) return;
    var anyOpen = all.some(function (d) { return d.open; });
    all.forEach(function (d) { d.open = !anyOpen; });
    $('#foldBtn').textContent = anyOpen ? '全部展开' : '全部折叠';
  });
  $('#useCache').addEventListener('change', function () {
    C.cacheEnabled = this.checked;
    refreshCacheInfo();
    setStatus(this.checked ? '本机缓存已打开（最多占用 ' + CU.fmtBytes(C.cacheBudget) + '）'
                           : '本机缓存已关闭，每次搜索都会重新下载');
  });
  $('#clearCache').addEventListener('click', function () {
    C.cacheClear().then(function () { return refreshCacheInfo(); }).then(function () {
      setStatus('本机缓存已清空');
    });
  });
  $('#warm').addEventListener('click', doWarm);
  $('#pickDir').addEventListener('click', function () { $('#dirInput').click(); });
  $('#dirInput').addEventListener('change', function () {
    if (this.files && this.files.length) useLocalFiles(this.files);
  });
  $('#kw').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });

  /* ==================== 启动 ==================== */
  loadManifest().then(function (m) {
    setFilesFromManifest(m);
    return C.tuneBudget(state.totalBytes);
  }).then(function (r) {
    return C.askPersist().then(function (ok) {
      return C.storageEstimate().then(function (est) {
        var s = '本机缓存上限 ' + CU.fmtBytes(r.budget);
        if (est && est.quota) s += '；浏览器给的可用空间约 ' + CU.fmtBytes(est.quota);
        s += ok ? '；已申请持久化（不会被自动清掉）' : '';
        $('#cacheInfo').title = s;
      });
    }).then(function () { return refreshCacheInfo(); });
  }).catch(function (err) {
    console.warn(err);
    setStatus('没有找到 <code>manifest.js</code>：请先在 <a href="builder.html">生成清单</a> 里' +
              '选择一次「娱乐」文件夹并下载 manifest.js 放到本站根目录；' +
              '也可以直接点下面的「搜索本机文件夹」。');
    $('#hello').innerHTML = '还没有文件清单。<br><small>先打开 <a href="builder.html">builder.html</a> 生成 manifest.js，' +
      '或直接点上面的「搜索本机文件夹（不上传）」。</small>';
  });
})();
