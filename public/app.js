const $ = (selector) => document.querySelector(selector);

const fields = {
  host: $('#host'),
  port: $('#port'),
  timeoutMs: $('#timeoutMs'),
  mode: $('#mode'),
  systemPrinter: $('#systemPrinter'),
  align: $('#align'),
  cut: $('#cut'),
  feedLines: $('#feedLines'),
  printText: $('#printText'),
  fileInput: $('#fileInput')
};

const buttons = {
  save: $('#saveBtn'),
  check: $('#checkBtn'),
  test: $('#testBtn'),
  print: $('#printBtn'),
  loadFile: $('#loadFileBtn'),
  printFile: $('#printFileBtn'),
  clearLog: $('#clearLogBtn')
};

const targetLabel = $('#targetLabel');
const statusPill = $('#statusPill');
const log = $('#log');
const fileStatus = $('#fileStatus');
const printerList = $('#printerList');
const API_BASE = getApiBase();
const MAX_PRINT_FILE_BYTES = 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.csv',
  '.json',
  '.log',
  '.html',
  '.htm',
  '.xml',
  '.md',
  '.js',
  '.css',
  '.yaml',
  '.yml'
]);
const RAW_FILE_EXTENSIONS = new Set([
  '.prn',
  '.bin',
  '.raw',
  '.escpos'
]);
const UNSUPPORTED_FILE_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp'
]);

function getApiBase() {
  const params = new URLSearchParams(window.location.search);
  const apiFromUrl = params.get('api');

  if (apiFromUrl) {
    localStorage.setItem('printwifiApiBase', apiFromUrl.replace(/\/$/, ''));
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

  if (localHosts.has(window.location.hostname)) {
    return '';
  }

  if (window.location.hostname.endsWith('.pages.dev')) {
    return localStorage.getItem('printwifiApiBase') || 'http://localhost:8080';
  }

  return localStorage.getItem('printwifiApiBase') || '';
}

function settings() {
  return {
    host: fields.host.value.trim(),
    port: Number(fields.port.value),
    timeoutMs: Number(fields.timeoutMs.value),
    mode: fields.mode.value,
    systemPrinter: fields.systemPrinter.value.trim()
  };
}

function printJob() {
  return {
    ...settings(),
    text: fields.printText.value,
    align: fields.align.value,
    cut: fields.cut.checked,
    feedLines: Number(fields.feedLines.value)
  };
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.busy = busy ? 'true' : 'false';
}

function setStatus(state, text) {
  statusPill.dataset.state = state;
  statusPill.querySelector('strong').textContent = text;
}

function syncTargetLabel() {
  const { host, port, mode, systemPrinter } = settings();
  targetLabel.textContent = mode === 'system'
    ? (systemPrinter || 'Windows default printer')
    : `${host || '-'}:${port || '-'}`;
}

function addLog(type, message, details = '') {
  const item = document.createElement('li');
  const timeNode = document.createElement('time');
  const messageNode = document.createElement('span');
  const time = new Date().toLocaleTimeString('th-TH', { hour12: false });

  item.dataset.type = type;
  timeNode.textContent = time;
  messageNode.textContent = message;
  item.append(timeNode, messageNode);

  if (details) {
    const detailsNode = document.createElement('small');
    detailsNode.textContent = details;
    item.append(detailsNode);
  }

  log.prepend(item);
}

function fileExt(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

function selectedFile() {
  return fields.fileInput.files && fields.fileInput.files[0];
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isTextFile(file) {
  return file.type.startsWith('text/')
    || ['application/json', 'application/xml', 'application/javascript'].includes(file.type)
    || TEXT_FILE_EXTENSIONS.has(fileExt(file.name));
}

function isRawFile(file) {
  return RAW_FILE_EXTENSIONS.has(fileExt(file.name));
}

function validateFile(file) {
  if (!file) {
    throw new Error('กรุณาเลือกไฟล์ก่อน');
  }

  if (file.size > MAX_PRINT_FILE_BYTES) {
    throw new Error(`ไฟล์ใหญ่เกินไป จำกัด ${formatBytes(MAX_PRINT_FILE_BYTES)}`);
  }

  if (UNSUPPORTED_FILE_EXTENSIONS.has(fileExt(file.name)) && fields.mode.value !== 'system') {
    throw new Error('ไฟล์ PDF/รูปภาพยังพิมพ์ผ่าน RAW TCP โดยตรงไม่ได้');
  }
}

function updateFileStatus() {
  const file = selectedFile();

  if (!file) {
    fileStatus.textContent = 'ยังไม่ได้เลือกไฟล์';
    return;
  }

  const mode = fields.mode.value === 'system'
    ? 'system'
    : isRawFile(file)
      ? 'raw'
      : isTextFile(file)
        ? 'text'
        : 'unsupported';
  fileStatus.textContent = `${file.name} · ${formatBytes(file.size)} · ${mode}`;
}

function updateModeUi() {
  const systemMode = fields.mode.value === 'system';
  fields.host.disabled = systemMode;
  fields.port.disabled = systemMode;
  document.body.dataset.printMode = systemMode ? 'system' : 'network';
  updateFileStatus();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function api(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.message || 'Request failed');
  }

  return data;
}

async function loadConfig() {
  try {
    const { config } = await api('/api/config');
    fields.host.value = config.host;
    fields.port.value = config.port;
    fields.timeoutMs.value = config.timeoutMs;
    fields.mode.value = config.mode;
    fields.systemPrinter.value = config.systemPrinter || 'EPSON L3110 Series';
    updateModeUi();
    syncTargetLabel();
  } catch (error) {
    addLog('error', 'โหลดค่าตั้งต้นไม่สำเร็จ', error.message);
  }
}

async function loadPrinters() {
  try {
    const { printers } = await api('/api/printers');
    printerList.replaceChildren(...printers.filter((printer) => printer.Name || printer.name).map((printer) => {
      const option = document.createElement('option');
      option.value = printer.Name || printer.name;
      option.label = printer.DriverName || printer.driverName || '';
      return option;
    }));
  } catch {
    // Render/Linux cannot list Windows printers; manual entry still works on the local bridge.
  }
}

buttons.save.addEventListener('click', async () => {
  setBusy(buttons.save, true);

  try {
    const { config } = await api('/api/config', settings());
    fields.host.value = config.host;
    fields.port.value = config.port;
    fields.timeoutMs.value = config.timeoutMs;
    fields.mode.value = config.mode;
    fields.systemPrinter.value = config.systemPrinter || 'EPSON L3110 Series';
    updateModeUi();
    syncTargetLabel();
    addLog('ok', 'บันทึกค่าแล้ว', `${config.host}:${config.port}`);
  } catch (error) {
    addLog('error', 'บันทึกค่าไม่สำเร็จ', error.message);
  } finally {
    setBusy(buttons.save, false);
  }
});

buttons.check.addEventListener('click', async () => {
  setBusy(buttons.check, true);
  setStatus('checking', 'กำลังตรวจ');
  syncTargetLabel();

  try {
    const result = await api('/api/printer/check', settings());
    setStatus('online', 'เชื่อมต่อได้');
    addLog('ok', result.message, `${result.latencyMs} ms`);
  } catch (error) {
    setStatus('offline', 'เชื่อมต่อไม่ได้');
    addLog('error', 'ตรวจไม่ผ่าน', error.message);
  } finally {
    setBusy(buttons.check, false);
  }
});

buttons.test.addEventListener('click', async () => {
  setBusy(buttons.test, true);
  syncTargetLabel();

  try {
    const result = await api('/api/printer/print-test', settings());
    setStatus('online', 'ส่งแล้ว');
    addLog('ok', result.message, `${result.bytes} bytes`);
  } catch (error) {
    setStatus('offline', 'ส่งไม่สำเร็จ');
    addLog('error', 'ทดสอบไม่สำเร็จ', error.message);
  } finally {
    setBusy(buttons.test, false);
  }
});

buttons.print.addEventListener('click', async () => {
  setBusy(buttons.print, true);
  syncTargetLabel();

  try {
    const result = await api('/api/printer/print', printJob());
    setStatus('online', 'ส่งแล้ว');
    addLog('ok', result.message, `${result.bytes} bytes`);
  } catch (error) {
    setStatus('offline', 'ส่งไม่สำเร็จ');
    addLog('error', 'พิมพ์ไม่สำเร็จ', error.message);
  } finally {
    setBusy(buttons.print, false);
  }
});

buttons.loadFile.addEventListener('click', async () => {
  setBusy(buttons.loadFile, true);

  try {
    const file = selectedFile();
    validateFile(file);

    if (!isTextFile(file)) {
      throw new Error('โหลดเข้า textarea ได้เฉพาะไฟล์ข้อความ');
    }

    fields.printText.value = await file.text();
    addLog('ok', 'โหลดไฟล์เข้า textarea แล้ว', `${file.name} (${formatBytes(file.size)})`);
  } catch (error) {
    addLog('error', 'โหลดไฟล์ไม่สำเร็จ', error.message);
  } finally {
    setBusy(buttons.loadFile, false);
  }
});

buttons.printFile.addEventListener('click', async () => {
  setBusy(buttons.printFile, true);
  syncTargetLabel();

  try {
    const file = selectedFile();
    validateFile(file);

    const body = {
      ...settings(),
      fileName: file.name,
      mimeType: file.type,
      align: fields.align.value,
      cut: fields.cut.checked,
      feedLines: Number(fields.feedLines.value)
    };

    if (isRawFile(file) || (fields.mode.value === 'system' && !isTextFile(file))) {
      body.dataEncoding = 'base64';
      body.data = arrayBufferToBase64(await file.arrayBuffer());
    } else if (isTextFile(file)) {
      body.dataEncoding = 'utf8';
      body.text = await file.text();
    } else {
      throw new Error('รองรับไฟล์ข้อความ หรือไฟล์คำสั่งเครื่องพิมพ์ .prn/.bin/.raw/.escpos');
    }

    const result = await api('/api/printer/print-file', body);
    setStatus('online', 'ส่งไฟล์แล้ว');
    addLog('ok', result.message, `${result.bytes} bytes`);
  } catch (error) {
    setStatus('offline', 'ส่งไฟล์ไม่สำเร็จ');
    addLog('error', 'พิมพ์ไฟล์ไม่สำเร็จ', error.message);
  } finally {
    setBusy(buttons.printFile, false);
  }
});

buttons.clearLog.addEventListener('click', () => {
  log.replaceChildren();
});

fields.fileInput.addEventListener('change', updateFileStatus);
fields.mode.addEventListener('change', updateModeUi);
fields.systemPrinter.addEventListener('input', syncTargetLabel);

Object.values(fields).forEach((field) => {
  field.addEventListener('input', syncTargetLabel);
  field.addEventListener('change', syncTargetLabel);
});

loadConfig();
loadPrinters();
updateModeUi();
updateFileStatus();
