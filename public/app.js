const $ = (selector) => document.querySelector(selector);

const fields = {
  host: $('#host'),
  port: $('#port'),
  timeoutMs: $('#timeoutMs'),
  mode: $('#mode'),
  align: $('#align'),
  cut: $('#cut'),
  feedLines: $('#feedLines'),
  printText: $('#printText')
};

const buttons = {
  save: $('#saveBtn'),
  check: $('#checkBtn'),
  test: $('#testBtn'),
  print: $('#printBtn'),
  clearLog: $('#clearLogBtn')
};

const targetLabel = $('#targetLabel');
const statusPill = $('#statusPill');
const log = $('#log');

function settings() {
  return {
    host: fields.host.value.trim(),
    port: Number(fields.port.value),
    timeoutMs: Number(fields.timeoutMs.value),
    mode: fields.mode.value
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
  const { host, port } = settings();
  targetLabel.textContent = `${host || '-'}:${port || '-'}`;
}

function addLog(type, message, details = '') {
  const item = document.createElement('li');
  const time = new Date().toLocaleTimeString('th-TH', { hour12: false });
  item.dataset.type = type;
  item.innerHTML = `<time>${time}</time><span>${message}</span>${details ? `<small>${details}</small>` : ''}`;
  log.prepend(item);
}

async function api(path, payload) {
  const response = await fetch(path, {
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
    syncTargetLabel();
  } catch (error) {
    addLog('error', 'โหลดค่าตั้งต้นไม่สำเร็จ', error.message);
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

buttons.clearLog.addEventListener('click', () => {
  log.replaceChildren();
});

Object.values(fields).forEach((field) => {
  field.addEventListener('input', syncTargetLabel);
  field.addEventListener('change', syncTargetLabel);
});

loadConfig();
