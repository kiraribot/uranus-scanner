(() => {
  const QUEUE_KEY = 'uranus-scanner-queue';
  const PIN_KEY = 'uranus-scanner-pin';

  const MODE_INFO = {
    sale:    { label: '販売',   desc: 'スキャンすると在庫が1減ります(売れた時)' },
    return:  { label: '返品',   desc: 'スキャンすると在庫が1増えます(返品された時)' },
    restock: { label: '入荷',   desc: 'スキャンすると在庫が増えます(数量欄の数だけ)' },
    promo:   { label: 'プロモ', desc: '在庫が1減ります。売上とは別に「プロモ出庫」として記録' },
    dispose: { label: '破棄',   desc: '在庫が1減ります。「破棄」として記録が残ります' },
    check:   { label: '照合',   desc: '在庫は動きません。商品情報の確認だけします' },
    link:    { label: '紐付け', desc: 'タグをスキャン→帳簿の行を選んでバーコードを登録' },
    manual:  { label: '手動',   desc: 'バーコードと在庫数を手入力(在庫はこの数に上書き)' },
  };

  const state = { mode: 'sale', scanning: false, codeReader: null, linkBarcode: null };

  const els = {
    connectionStatus: document.getElementById('connection-status'),
    modeBtns: document.querySelectorAll('.mode-btn'),
    modeDesc: document.getElementById('mode-desc'),
    cameraSection: document.getElementById('camera-section'),
    manualSection: document.getElementById('manual-section'),
    qtySection: document.getElementById('qty-section'),
    linkPanel: document.getElementById('link-panel'),
    linkScanned: document.getElementById('link-scanned'),
    linkHinban: document.getElementById('link-hinban'),
    linkSearch: document.getElementById('link-search'),
    linkCandidates: document.getElementById('link-candidates'),
    video: document.getElementById('video'),
    startScan: document.getElementById('start-scan'),
    stopScan: document.getElementById('stop-scan'),
    manualBarcode: document.getElementById('manual-barcode'),
    manualQty: document.getElementById('manual-qty'),
    manualSubmit: document.getElementById('manual-submit'),
    scanQty: document.getElementById('scan-qty'),
    logList: document.getElementById('log-list'),
    queueCount: document.getElementById('queue-count'),
    flushQueue: document.getElementById('flush-queue'),
    pinOverlay: document.getElementById('pin-overlay'),
    pinInput: document.getElementById('pin-input'),
    pinSubmit: document.getElementById('pin-submit'),
    pinError: document.getElementById('pin-error'),
  };

  // ---------- 効果音(端末のマナーモードに従う) ----------
  let audioCtx = null;
  function beep(type) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      if (type === 'ok') {
        o.frequency.value = 880; o.type = 'sine';
        g.gain.setValueAtTime(0.25, audioCtx.currentTime);
        o.start(); o.stop(audioCtx.currentTime + 0.12);
      } else if (type === 'info') {
        o.frequency.value = 600; o.type = 'sine';
        g.gain.setValueAtTime(0.2, audioCtx.currentTime);
        o.start(); o.stop(audioCtx.currentTime + 0.1);
      } else {
        o.frequency.value = 180; o.type = 'square';
        g.gain.setValueAtTime(0.25, audioCtx.currentTime);
        o.start(); o.stop(audioCtx.currentTime + 0.35);
      }
    } catch { /* 音が出なくても処理は続行 */ }
  }
  function flash(ok) {
    document.body.classList.remove('flash-ok', 'flash-ng');
    void document.body.offsetWidth;
    document.body.classList.add(ok ? 'flash-ok' : 'flash-ng');
  }

  // ---------- PIN(暗証番号) ----------
  function getPin() { return localStorage.getItem(PIN_KEY) || ''; }
  function apiHeaders() {
    const h = { 'Content-Type': 'application/json' };
    const pin = getPin();
    if (pin) h['x-app-pin'] = pin;
    return h;
  }
  function showPinOverlay(msg) {
    els.pinError.textContent = msg || '';
    els.pinOverlay.classList.remove('hidden');
    els.pinInput.focus();
  }
  els.pinSubmit.addEventListener('click', async () => {
    const pin = els.pinInput.value.trim();
    if (!pin) return;
    localStorage.setItem(PIN_KEY, pin);
    els.pinInput.value = '';
    try {
      const res = await fetch('/api/link/search', {
        method: 'POST', headers: apiHeaders(), body: JSON.stringify({ hinban: '___ping___' }),
      });
      if (res.status === 401) return showPinOverlay('暗証番号が違います');
      els.pinOverlay.classList.add('hidden');
    } catch {
      els.pinOverlay.classList.add('hidden');
    }
  });

  async function apiFetch(url, body) {
    const res = await fetch(url, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.status === 401) {
      showPinOverlay('暗証番号を入力してください');
      throw Object.assign(new Error('PIN未認証'), { pin: true });
    }
    return res;
  }

  // ---------- オフラインキュー ----------
  function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
  }
  function saveQueue(queue) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    els.queueCount.textContent = queue.length;
    els.flushQueue.disabled = queue.length === 0 || !navigator.onLine;
  }
  function enqueue(scan) {
    const queue = getQueue();
    queue.push({ ...scan, clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
    saveQueue(queue);
    logEntry(`キュー追加: ${scan.barcode} (${MODE_INFO[scan.mode].label} / ${scan.quantity})`, 'queued');
  }
  async function flushQueue() {
    const queue = getQueue();
    if (queue.length === 0 || !navigator.onLine) return;
    els.flushQueue.disabled = true;
    try {
      const res = await apiFetch('/api/scan/batch', { scans: queue });
      const data = await res.json();
      if (!data.ok) throw new Error('batch failed');
      const failedIds = new Set();
      for (const r of data.results) {
        if (r.ok) logEntry(`同期完了: ${r.result.name} → 在庫 ${r.result.newStock}`, 'ok');
        else { failedIds.add(r.clientId); logEntry(`同期失敗: ${r.error}`, 'error'); }
      }
      saveQueue(queue.filter((s) => failedIds.has(s.clientId)));
    } catch (err) {
      if (!err.pin) logEntry(`同期エラー: ${err.message}`, 'error');
      els.flushQueue.disabled = getQueue().length === 0 || !navigator.onLine;
    }
  }
  function updateConnectionStatus() {
    const online = navigator.onLine;
    els.connectionStatus.textContent = online ? 'オンライン' : 'オフライン（キューに保存されます）';
    els.connectionStatus.className = `status ${online ? 'online' : 'offline'}`;
    els.flushQueue.disabled = getQueue().length === 0 || !online;
    if (online) flushQueue();
  }
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
  els.flushQueue.addEventListener('click', flushQueue);

  // ---------- ログ ----------
  function logEntry(text, cls) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString('ja-JP')}] ${text}`;
    if (cls === 'error') li.classList.add('error');
    if (cls === 'queued') li.classList.add('queued');
    els.logList.prepend(li);
  }

  // ---------- モード切替 ----------
  els.modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      els.modeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      els.modeDesc.textContent = MODE_INFO[state.mode].desc;

      const isManual = state.mode === 'manual';
      const isLink = state.mode === 'link';
      els.cameraSection.classList.toggle('hidden', isManual);
      els.qtySection.classList.toggle('hidden', isManual || isLink || state.mode === 'check');
      els.manualSection.classList.toggle('hidden', !isManual);
      els.linkPanel.classList.toggle('hidden', !isLink);
      if (!isLink) { state.linkBarcode = null; els.linkScanned.textContent = '(未スキャン)'; els.linkCandidates.innerHTML = ''; }
      if (isManual) stopScanning();
    });
  });

  // ---------- スキャン結果の処理 ----------
  async function submitScan(barcode, mode, quantity) {
    if (mode === 'check') {
      try {
        const res = await apiFetch('/api/scan', { barcode, mode: 'check' });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '不明なエラー');
        const r = data.result;
        beep('info'); flash(true);
        logEntry(`照合: ${r.hinban} | ${r.name} | 色${r.color} | サイズ${r.size} | 在庫${r.stock} | ¥${r.price}`, 'ok');
      } catch (err) {
        if (err.pin) return;
        beep('ng'); flash(false);
        logEntry(`照合失敗: ${err.message}`, 'error');
      }
      return;
    }

    if (mode === 'link') {
      state.linkBarcode = barcode;
      els.linkScanned.textContent = barcode;
      beep('info'); flash(true);
      logEntry(`紐付け用に読み取り: ${barcode} → 品番で検索してください`, 'ok');
      els.linkHinban.focus();
      return;
    }

    const scan = { barcode, mode, quantity };
    if (!navigator.onLine) { enqueue(scan); beep('info'); return; }

    try {
      const res = await apiFetch('/api/scan', scan);
      const data = await res.json();
      if (!data.ok) {
        if (data.code === 'DUPLICATE') { beep('ng'); flash(false); logEntry(`⚠ ${data.error}`, 'error'); return; }
        if (data.code === 'NOT_FOUND') { beep('ng'); flash(false); logEntry(`未登録: ${data.error}`, 'error'); return; }
        throw new Error(data.error || '不明なエラー');
      }
      const r = data.result;
      beep('ok'); flash(true);
      const clampNote = r.clamped ? '(⚠在庫がマイナスになるため0で止めました)' : '';
      logEntry(`${r.modeLabel}: ${r.name} ${r.color} ${r.size} → 在庫 ${r.previousStock}→${r.newStock} ${clampNote}`, 'ok');
    } catch (err) {
      if (err.pin) return;
      enqueue(scan); beep('info');
    }
  }

  // ---------- 紐付けモード: 検索と登録 ----------
  els.linkSearch.addEventListener('click', async () => {
    const hinban = els.linkHinban.value.trim();
    if (hinban.length < 3) return logEntry('品番を3文字以上入力してください', 'error');
    els.linkCandidates.innerHTML = '<li>検索中...</li>';
    try {
      const res = await apiFetch('/api/link/search', { hinban });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      els.linkCandidates.innerHTML = '';
      if (data.candidates.length === 0) {
        els.linkCandidates.innerHTML = '<li>見つかりませんでした。品番を確認してください</li>';
        return;
      }
      data.candidates.forEach((c) => {
        const li = document.createElement('li');
        if (c.barcode) li.classList.add('linked');
        const btn = document.createElement('button');
        btn.textContent = `${c.hinban} | ${c.name} | 色${c.color} | サイズ${c.size} | 在庫${c.stock}` +
          (c.barcode ? ` | 登録済(${c.barcode})` : ' | 未登録 ← タップで登録');
        btn.addEventListener('click', () => bindTo(c));
        li.appendChild(btn);
        els.linkCandidates.appendChild(li);
      });
    } catch (err) {
      if (!err.pin) { els.linkCandidates.innerHTML = ''; logEntry(`検索エラー: ${err.message}`, 'error'); }
    }
  });

  async function bindTo(candidate) {
    if (!state.linkBarcode) { beep('ng'); return logEntry('先にタグのバーコードをスキャンしてください', 'error'); }
    if (candidate.barcode) { beep('ng'); return logEntry('この行は登録済みです', 'error'); }
    try {
      const res = await apiFetch('/api/link/bind', { row: candidate.row, barcode: state.linkBarcode });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      beep('ok'); flash(true);
      logEntry(`✅ 紐付け完了: ${state.linkBarcode} = ${candidate.hinban} ${candidate.color} ${candidate.size}`, 'ok');
      state.linkBarcode = null;
      els.linkScanned.textContent = '(未スキャン) 次のタグをスキャン';
      els.linkCandidates.innerHTML = '';
    } catch (err) {
      if (!err.pin) { beep('ng'); flash(false); logEntry(`紐付け失敗: ${err.message}`, 'error'); }
    }
  }

  // ---------- 手動モード ----------
  els.manualSubmit.addEventListener('click', () => {
    const barcode = els.manualBarcode.value.trim();
    const qty = Number(els.manualQty.value);
    if (!barcode) return logEntry('バーコードを入力してください', 'error');
    if (!Number.isFinite(qty) || qty < 0) return logEntry('数量が不正です', 'error');
    submitScan(barcode, 'manual', qty);
    els.manualBarcode.value = '';
    els.manualBarcode.focus();
  });

  // ---------- カメラ(ZXing / iOS Safariで実績ありの方式を維持) ----------
  function stopScanning() {
    if (state.codeReader) state.codeReader.reset();
    state.scanning = false;
    els.startScan.disabled = false;
    els.stopScan.disabled = true;
  }

  let lastScanTime = 0;
  const SCAN_DEBOUNCE_MS = 1500;

  els.startScan.addEventListener('click', async () => {
    if (!window.ZXingBrowser && !window.ZXing) {
      return logEntry('ZXingライブラリの読み込みに失敗しました', 'error');
    }
    try {
      const { BrowserMultiFormatReader } = window.ZXing;
      state.codeReader = new BrowserMultiFormatReader();
      state.scanning = true;
      els.startScan.disabled = true;
      els.stopScan.disabled = false;

      const constraints = { video: { facingMode: 'environment' } };

      state.codeReader.decodeFromConstraints(constraints, 'video', (result, err) => {
        if (result) {
          const now = Date.now();
          if (now - lastScanTime < SCAN_DEBOUNCE_MS) return;
          lastScanTime = now;
          const qty = Number(els.scanQty.value) || 1;
          submitScan(result.getText(), state.mode, qty);
        }
      });
    } catch (err) {
      logEntry(`カメラ起動エラー: ${err.message}`, 'error');
      stopScanning();
    }
  });

  els.stopScan.addEventListener('click', stopScanning);

  // ---------- 初期化 ----------
  saveQueue(getQueue());
  updateConnectionStatus();
})();