(() => {
  const QUEUE_KEY = 'uranus-queue-v3';
  const PIN_KEY = 'uranus-pin';

  const MODE_INFO = {
    sale:    { title: '🛒 売れたら、ピッ', sub: 'バーコードにかざすだけ。在庫が1減ります' },
    restock: { title: '📦 入荷したら、ピッ', sub: '在庫が増えます。まとめて入った時は下の数量を変えてから' },
    return:  { title: '↩️ 返品', sub: 'お客様から戻ってきた商品をピッ。在庫が1もどります' },
    promo:   { title: '🎁 プロモで渡した', sub: '売上とは別の記録で在庫が1減ります' },
    dispose: { title: '🗑 破棄した', sub: '記録を残して在庫が1減ります' },
    check:   { title: '🔍 かくにん(見るだけ)', sub: '在庫は動きません。商品情報が出ます' },
  };
  const MODE_LABEL = { sale:'販売', restock:'入荷', return:'返品', promo:'プロモ', dispose:'破棄', check:'かくにん' };

  const state = { mode: 'sale', codeReader: null, scanning: false, pending: null, candCtx: null };

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: document.querySelectorAll('.tab'),
    modeTitle: $('mode-title'),
    camera: $('camera-section'), other: $('other-section'), settings: $('settings-section'),
    video: $('video'), startScan: $('start-scan'), stopScan: $('stop-scan'),
    qtyRow: $('qty-row'), scanQty: $('scan-qty'),
    resultCard: $('result-card'), resultMain: $('result-main'), resultSub: $('result-sub'),
    logList: $('log-list'),
    queueSection: $('queue-section'), queueCount: $('queue-count'), flushQueue: $('flush-queue'),
    conn: $('connection-status'),
    pinOverlay: $('pin-overlay'), pinInput: $('pin-input'), pinSubmit: $('pin-submit'), pinError: $('pin-error'),
    photoOverlay: $('photo-overlay'), photoTake: $('photo-take'), photoCancel: $('photo-cancel'), photoInput: $('photo-input'),
    busyOverlay: $('busy-overlay'), busyText: $('busy-text'),
    candOverlay: $('cand-overlay'), candList: $('cand-list'), candNote: $('cand-note'), candCancel: $('cand-cancel'),
  };

  // ---------- 音と光 ----------
  let audioCtx = null;
  function beep(type) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      if (type === 'ok') { o.frequency.value = 880; o.type = 'sine'; g.gain.value = 0.25; o.start(); o.stop(audioCtx.currentTime + 0.12); }
      else if (type === 'info') { o.frequency.value = 600; o.type = 'sine'; g.gain.value = 0.2; o.start(); o.stop(audioCtx.currentTime + 0.1); }
      else { o.frequency.value = 180; o.type = 'square'; g.gain.value = 0.25; o.start(); o.stop(audioCtx.currentTime + 0.3); }
    } catch {}
  }
  function flash(ok) {
    document.body.classList.remove('flash-ok', 'flash-ng');
    void document.body.offsetWidth;
    document.body.classList.add(ok ? 'flash-ok' : 'flash-ng');
  }
  function showResult(ok, main, sub) {
    els.resultCard.classList.remove('hidden', 'ok', 'ng');
    els.resultCard.classList.add(ok ? 'ok' : 'ng');
    els.resultMain.textContent = main;
    els.resultSub.textContent = sub || '';
  }
  function logEntry(text, cls) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString('ja-JP')}] ${text}`;
    if (cls) li.classList.add(cls);
    els.logList.prepend(li);
    while (els.logList.children.length > 40) els.logList.removeChild(els.logList.lastChild);
  }

  // ---------- PIN ----------
  const getPin = () => localStorage.getItem(PIN_KEY) || '';
  function apiHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (getPin()) h['x-app-pin'] = getPin();
    return h;
  }
  function showPin(msg) { els.pinError.textContent = msg || ''; els.pinOverlay.classList.remove('hidden'); els.pinInput.focus(); }
  els.pinSubmit.addEventListener('click', async () => {
    const pin = els.pinInput.value.trim();
    if (!pin) return;
    localStorage.setItem(PIN_KEY, pin);
    els.pinInput.value = '';
    try {
      const r = await fetch('/api/health', { headers: apiHeaders() });
      // healthはPIN不要なので、実PIN検証は軽いAPIで
      const t = await fetch('/api/link/search', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ hinban: '___' }) });
      if (t.status === 401) return showPin('番号がちがいます。もう一度');
      els.pinOverlay.classList.add('hidden');
      beep('ok');
    } catch { els.pinOverlay.classList.add('hidden'); }
  });
  async function apiFetch(url, body) {
    const res = await fetch(url, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.status === 401) { showPin('暗証番号を入れてください'); throw Object.assign(new Error('PIN'), { pin: true }); }
    return res;
  }

  // ---------- オフラインキュー ----------
  const getQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
  function saveQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    els.queueCount.textContent = q.length;
    els.queueSection.classList.toggle('hidden', q.length === 0);
    els.flushQueue.disabled = q.length === 0 || !navigator.onLine;
  }
  function enqueue(scan) {
    const q = getQueue();
    q.push({ ...scan, clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
    saveQueue(q);
    logEntry(`電波なし→あとで送信: ${MODE_LABEL[scan.mode]} ${scan.barcode}`, 'queued');
  }
  async function flushQueue() {
    const q = getQueue();
    if (!q.length || !navigator.onLine) return;
    try {
      const res = await apiFetch('/api/scan/batch', { scans: q });
      const data = await res.json();
      const failed = new Set();
      for (const r of data.results || []) {
        if (r.ok) logEntry(`送信ずみ: ${r.result.name} → 在庫${r.result.newStock}`);
        else { failed.add(r.clientId); logEntry(`送信できず: ${r.error}`, 'error'); }
      }
      saveQueue(q.filter((s) => failed.has(s.clientId)));
    } catch (e) { if (!e.pin) logEntry('同期エラー。あとで自動再送します', 'error'); }
  }
  function updateConn() {
    const on = navigator.onLine;
    els.conn.textContent = on ? '● つながっています' : '● 電波なし(読み取りは保存されます)';
    els.conn.classList.toggle('offline', !on);
    if (on) flushQueue();
    saveQueue(getQueue());
  }
  window.addEventListener('online', updateConn);
  window.addEventListener('offline', updateConn);
  els.flushQueue.addEventListener('click', flushQueue);

  // ---------- タブ切替 ----------
  function setMode(mode) {
    state.mode = mode;
    const info = MODE_INFO[mode];
    if (info) els.modeTitle.innerHTML = `${info.title}<small>${info.sub}</small>`;
    els.qtyRow.style.display = (mode === 'restock') ? 'flex' : 'none';
    if (mode !== 'restock') els.scanQty.value = 1;
  }
  els.tabs.forEach((tab) => tab.addEventListener('click', () => {
    els.tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const m = tab.dataset.mode;
    els.camera.classList.toggle('hidden', m === 'other' || m === 'settings');
    els.other.classList.toggle('hidden', m !== 'other');
    els.settings.classList.toggle('hidden', m !== 'settings');
    if (m === 'sale' || m === 'restock') setMode(m);
    if (m === 'other') els.modeTitle.innerHTML = '🔄 その他<small>やりたいことを選んでください</small>';
    if (m === 'settings') els.modeTitle.innerHTML = '⚙️ 設定<small>ふだんは触らなくて大丈夫です</small>';
  }));
  document.querySelectorAll('.menu-btn').forEach((btn) => btn.addEventListener('click', () => {
    setMode(btn.dataset.submode);
    els.other.classList.add('hidden');
    els.camera.classList.remove('hidden');
  }));

  // ---------- スキャン本体 ----------
  let lastScan = 0;
  async function onScan(barcode) {
    const now = Date.now();
    if (now - lastScan < 1500) return;
    lastScan = now;

    const mode = state.mode;
    const qty = Number(els.scanQty.value) || 1;

    if (mode === 'check') {
      try {
        const res = await apiFetch('/api/scan', { barcode, mode: 'check' });
        const d = await res.json();
        if (!d.ok) throw Object.assign(new Error(d.error), { code: d.code });
        beep('info'); flash(true);
        showResult(true, `${d.result.name}`, `色${d.result.color} / サイズ${d.result.size} / 在庫 ${d.result.stock} / ¥${d.result.price}`);
      } catch (e) {
        if (e.pin) return;
        if (e.code === 'NOT_FOUND') return openPhoto(barcode, null);
        beep('ng'); flash(false); showResult(false, '読み取れませんでした', e.message);
      }
      return;
    }

    const scan = { barcode, mode, quantity: qty };
    if (!navigator.onLine) { enqueue(scan); beep('info'); showResult(true, '電波なし: 保存しました', 'つながったら自動で反映されます'); return; }

    try {
      const res = await apiFetch('/api/scan', scan);
      const d = await res.json();
      if (!d.ok) {
        if (d.code === 'NOT_FOUND') return openPhoto(barcode, { mode, quantity: qty });
        if (d.code === 'DUPLICATE') { beep('ng'); flash(false); showResult(false, '⚠ 同じ商品を続けて読みました', d.error); return; }
        throw new Error(d.error);
      }
      const r = d.result;
      beep('ok'); flash(true);
      showResult(true, `${MODE_LABEL[mode]}しました: ${r.name}`, `色${r.color} / サイズ${r.size} / 在庫 ${r.previousStock} → ${r.newStock}${r.clamped ? '(0で止めました)' : ''}`);
      logEntry(`${MODE_LABEL[mode]}: ${r.name} ${r.size} 在庫${r.previousStock}→${r.newStock}`);
    } catch (e) {
      if (e.pin) return;
      enqueue(scan); beep('info');
      showResult(true, '通信が不安定: 保存しました', 'つながったら自動で反映されます');
    }
  }

  // ---------- 写真フロー(はじめての商品) ----------
  function openPhoto(barcode, action) {
    state.pending = { barcode, action };
    beep('info'); 
    els.photoOverlay.classList.remove('hidden');
  }
  els.photoCancel.addEventListener('click', () => { state.pending = null; els.photoOverlay.classList.add('hidden'); });
  els.photoTake.addEventListener('click', () => els.photoInput.click());
  els.photoInput.addEventListener('change', async () => {
    const file = els.photoInput.files && els.photoInput.files[0];
    els.photoInput.value = '';
    if (!file || !state.pending) return;
    els.photoOverlay.classList.add('hidden');
    els.busyText.textContent = '値札を読み取り中...';
    els.busyOverlay.classList.remove('hidden');
    try {
      const image = await fileToBase64(file, 1280, 0.8);
      const res = await apiFetch('/api/tag-link', {
        barcode: state.pending.barcode, image, action: state.pending.action,
      });
      const d = await res.json();
      els.busyOverlay.classList.add('hidden');
      if (!d.ok) {
        if (d.code === 'VISION_OFF') { beep('ng'); showResult(false, '写真機能が未開通です', '設定タブの「品番で手さがし」を使ってください'); return; }
        throw new Error(d.error);
      }
      if (d.matched) {
        beep('ok'); flash(true);
        const ex = d.executed;
        if (ex) {
          showResult(true, `登録して${ex.modeLabel}しました: ${ex.name}`, `色${ex.color} / サイズ${ex.size} / 在庫 ${ex.previousStock} → ${ex.newStock}`);
          logEntry(`自動登録+${ex.modeLabel}: ${ex.name} ${ex.size}`);
        } else {
          showResult(true, `登録しました: ${d.linked.name}`, `色${d.linked.color} / サイズ${d.linked.size} / 在庫 ${d.linked.stock}`);
          logEntry(`自動登録: ${d.linked.name} ${d.linked.size}`);
        }
        state.pending = null;
      } else if (d.candidates && d.candidates.length) {
        showCandidates(d.candidates, d.parsed);
      } else {
        beep('ng');
        showResult(false, 'うまく読めませんでした', d.reason || 'もう一度、値札全体が明るく写るように撮ってください');
        els.photoOverlay.classList.remove('hidden');
      }
    } catch (e) {
      els.busyOverlay.classList.add('hidden');
      if (e.pin) return;
      beep('ng'); showResult(false, '読み取りに失敗しました', e.message);
    }
  });

  function showCandidates(cands, parsed) {
    els.candNote.textContent = parsed && parsed.hinban ? `値札の品番: ${parsed.hinban}` : '当てはまるものをタップ';
    els.candList.innerHTML = '';
    cands.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'cand-btn';
      b.innerHTML = `${c.name}<small>品番 ${c.hinban} / 色 ${c.color} / サイズ ${c.size} / 在庫 ${c.stock}${c.barcode ? ' / ⚠登録済み' : ''}</small>`;
      b.addEventListener('click', async () => {
        els.candOverlay.classList.add('hidden');
        els.busyText.textContent = '登録中...';
        els.busyOverlay.classList.remove('hidden');
        try {
          const res = await apiFetch('/api/tag-link/confirm', {
            row: c.row, barcode: state.pending.barcode, action: state.pending.action,
          });
          const d = await res.json();
          els.busyOverlay.classList.add('hidden');
          if (!d.ok) throw new Error(d.error);
          beep('ok'); flash(true);
          const ex = d.executed;
          if (ex) showResult(true, `登録して${ex.modeLabel}しました: ${ex.name}`, `在庫 ${ex.previousStock} → ${ex.newStock}`);
          else showResult(true, `登録しました: ${d.linked.name}`, `サイズ${d.linked.size} / 在庫 ${d.linked.stock}`);
          logEntry(`登録: ${d.linked.name} ${d.linked.size}`);
          state.pending = null;
        } catch (err) {
          els.busyOverlay.classList.add('hidden');
          if (!err.pin) { beep('ng'); showResult(false, '登録できませんでした', err.message); }
        }
      });
      els.candList.appendChild(b);
    });
    els.candOverlay.classList.remove('hidden');
  }
  els.candCancel.addEventListener('click', () => { state.pending = null; els.candOverlay.classList.add('hidden'); });

  function fileToBase64(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ---------- カメラ ----------
  function stopScanning() {
    if (state.codeReader) state.codeReader.reset();
    state.scanning = false;
    els.startScan.classList.remove('hidden');
    els.stopScan.classList.add('hidden');
  }
  els.startScan.addEventListener('click', () => {
    if (!window.ZXing) return logEntry('カメラ部品の読み込みに失敗。ページを開き直してください', 'error');
    try {
      const { BrowserMultiFormatReader } = window.ZXing;
      state.codeReader = new BrowserMultiFormatReader();
      state.scanning = true;
      els.startScan.classList.add('hidden');
      els.stopScan.classList.remove('hidden');
      state.codeReader.decodeFromConstraints({ video: { facingMode: 'environment' } }, 'video', (result) => {
        if (result) onScan(result.getText());
      });
    } catch (e) {
      logEntry(`カメラを起動できません: ${e.message}`, 'error');
      stopScanning();
    }
  });
  els.stopScan.addEventListener('click', stopScanning);

  // ---------- 設定 ----------
  $('reset-pin').addEventListener('click', () => { localStorage.removeItem(PIN_KEY); showPin('新しい暗証番号を入れてください'); });
  $('manual-search').addEventListener('click', async () => {
    const hinban = $('manual-hinban').value.trim();
    const box = $('manual-results');
    box.innerHTML = '検索中...';
    try {
      const res = await apiFetch('/api/link/search', { hinban });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      box.innerHTML = '';
      d.candidates.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'cand-btn';
        b.style.color = '#0f172a';
        b.innerHTML = `${c.name}<small>${c.hinban} / 色${c.color} / サイズ${c.size} / 在庫${c.stock}${c.barcode ? ' / 登録済み' : ' / 未登録'}</small>`;
        b.addEventListener('click', () => {
          const code = prompt('この行に登録するバーコード番号(タグの13桁)を入力');
          if (!code) return;
          apiFetch('/api/link/bind', { row: c.row, barcode: code.trim() })
            .then((r) => r.json())
            .then((dd) => { if (dd.ok) { beep('ok'); logEntry(`手動登録: ${dd.result.name}`); box.innerHTML = '✅ 登録しました'; } else { beep('ng'); alert(dd.error); } });
        });
        box.appendChild(b);
      });
      if (!d.candidates.length) box.innerHTML = '見つかりませんでした';
    } catch (e) { if (!e.pin) box.innerHTML = 'エラー: ' + e.message; }
  });
  $('fix-submit').addEventListener('click', async () => {
    const barcode = $('fix-barcode').value.trim();
    const qty = Number($('fix-qty').value);
    if (!barcode || !Number.isFinite(qty)) return alert('バーコードと在庫数を入れてください');
    try {
      const res = await apiFetch('/api/scan', { barcode, mode: 'manual', quantity: qty, force: true });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      beep('ok'); logEntry(`手動修正: ${d.result.name} → 在庫${d.result.newStock}`);
      alert('直しました');
    } catch (e) { if (!e.pin) { beep('ng'); alert(e.message); } }
  });

  // ---------- 初期化 ----------
  setMode('sale');
  saveQueue(getQueue());
  updateConn();
  fetch('/api/health').then((r) => r.json()).then((d) => {
    if (getPin() === '' ) showPin('');
  }).catch(() => {});
})();
