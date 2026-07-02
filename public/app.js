(() => {
  const QUEUE_KEY = 'uranus-scanner-queue';

  const state = {
    mode: 'sale',
    scanning: false,
    codeReader: null,
  };

  const els = {
    connectionStatus: document.getElementById('connection-status'),
    modeBtns: document.querySelectorAll('.mode-btn'),
    cameraSection: document.getElementById('camera-section'),
    manualSection: document.getElementById('manual-section'),
    qtySection: document.getElementById('qty-section'),
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
  };

  // ---------- Offline detection & queue ----------

  function getQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
      return [];
    }
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
    logEntry(`キュー追加: ${scan.barcode} (${modeLabel(scan.mode)} / ${scan.quantity})`, 'queued');
  }

  async function flushQueue() {
    const queue = getQueue();
    if (queue.length === 0 || !navigator.onLine) return;

    els.flushQueue.disabled = true;
    try {
      const res = await fetch('/api/scan/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scans: queue }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error('batch failed');

      const failedIds = new Set();
      for (const r of data.results) {
        if (r.ok) {
          logEntry(`同期完了: ${r.result.barcode} → 在庫 ${r.result.newStock}`, 'ok');
        } else {
          failedIds.add(r.clientId);
          logEntry(`同期失敗: ${r.clientId} - ${r.error}`, 'error');
        }
      }
      saveQueue(queue.filter((s) => failedIds.has(s.clientId)));
    } catch (err) {
      logEntry(`同期エラー: ${err.message}`, 'error');
      els.flushQueue.disabled = queue.length === 0 || !navigator.onLine;
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

  // ---------- Logging ----------

  function logEntry(text, cls) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString('ja-JP')}] ${text}`;
    if (cls === 'error') li.classList.add('error');
    if (cls === 'queued') li.classList.add('queued');
    els.logList.prepend(li);
  }

  function modeLabel(mode) {
    return { sale: '販売', restock: '補充', manual: '手動' }[mode] || mode;
  }

  // ---------- Mode switching ----------

  els.modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      els.modeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;

      const isManual = state.mode === 'manual';
      els.cameraSection.classList.toggle('hidden', isManual);
      els.qtySection.classList.toggle('hidden', isManual);
      els.manualSection.classList.toggle('hidden', !isManual);

      if (isManual) stopScanning();
    });
  });

  // ---------- Submitting a scan ----------

  async function submitScan(barcode, mode, quantity) {
    const scan = { barcode, mode, quantity };

    if (!navigator.onLine) {
      enqueue(scan);
      return;
    }

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scan),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '不明なエラー');
      logEntry(`${modeLabel(mode)}: ${data.result.name || barcode} → 在庫 ${data.result.newStock}`, 'ok');
    } catch (err) {
      // Network-level failure even though navigator.onLine was true (e.g. flaky connection).
      enqueue(scan);
    }
  }

  // ---------- Manual mode ----------

  els.manualSubmit.addEventListener('click', () => {
    const barcode = els.manualBarcode.value.trim();
    const qty = Number(els.manualQty.value);
    if (!barcode) return logEntry('バーコードを入力してください', 'error');
    if (!Number.isFinite(qty) || qty < 0) return logEntry('数量が不正です', 'error');
    submitScan(barcode, 'manual', qty);
    els.manualBarcode.value = '';
    els.manualBarcode.focus();
  });

  // ---------- Camera scanning (ZXing) ----------

  function stopScanning() {
    if (state.codeReader) {
      state.codeReader.reset();
    }
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

      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      const deviceId = devices.length ? devices[devices.length - 1].deviceId : undefined;

      state.codeReader.decodeFromVideoDevice(deviceId, els.video, (result, err) => {
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

  // ---------- Init ----------

  saveQueue(getQueue());
  updateConnectionStatus();
})();
