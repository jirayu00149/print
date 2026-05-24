const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execFile, spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEB_SETTINGS_FILE = path.join(ROOT, 'webServerApiSettings.json');
const PRINTER_SETTINGS_FILE = path.join(ROOT, 'printer-settings.json');
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PRINT_FILE_BYTES = 1024 * 1024;
const UNSUPPORTED_FILE_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp'
]);

const DEFAULTS = {
  host: process.env.PRINTER_HOST || '192.168.10.1',
  port: Number(process.env.PRINTER_PORT || 9100),
  timeoutMs: Number(process.env.PRINTER_TIMEOUT_MS || 3000),
  mode: process.env.PRINTER_MODE || 'escpos',
  systemPrinter: process.env.SYSTEM_PRINTER || 'EPSON L3110 Series'
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const webSettings = readJson(WEB_SETTINGS_FILE, {});
const envSettings = Object.fromEntries(Object.entries({
  host: process.env.PRINTER_HOST,
  port: process.env.PRINTER_PORT ? Number(process.env.PRINTER_PORT) : undefined,
  timeoutMs: process.env.PRINTER_TIMEOUT_MS ? Number(process.env.PRINTER_TIMEOUT_MS) : undefined,
  mode: process.env.PRINTER_MODE,
  systemPrinter: process.env.SYSTEM_PRINTER
}).filter(([, value]) => value !== undefined && value !== ''));
let printerSettings = {
  ...DEFAULTS,
  ...readJson(PRINTER_SETTINGS_FILE, {}),
  ...envSettings
};

function normalizeSettings(input = {}) {
  const host = String(input.host || printerSettings.host || DEFAULTS.host).trim();
  const port = Number(input.port || printerSettings.port || DEFAULTS.port);
  const timeoutMs = Number(input.timeoutMs || printerSettings.timeoutMs || DEFAULTS.timeoutMs);
  const allowedModes = new Set(['escpos', 'raw', 'system']);
  const requestedMode = String(input.mode || printerSettings.mode || DEFAULTS.mode || 'escpos');
  const mode = allowedModes.has(requestedMode) ? requestedMode : 'escpos';
  const systemPrinter = String(input.systemPrinter || printerSettings.systemPrinter || DEFAULTS.systemPrinter || '').trim();

  if (!host) {
    throw httpError(400, 'กรุณาระบุ IP เครื่องพิมพ์');
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, 'พอร์ตเครื่องพิมพ์ไม่ถูกต้อง');
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) {
    throw httpError(400, 'timeout ต้องอยู่ระหว่าง 500-30000 ms');
  }

  return { host, port, timeoutMs, mode, systemPrinter };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function savePrinterSettings(settings) {
  printerSettings = normalizeSettings({ ...printerSettings, ...settings });
  fs.writeFileSync(PRINTER_SETTINGS_FILE, JSON.stringify(printerSettings, null, 2));
  return printerSettings;
}

function connectPrinter(settings) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({
      host: settings.host,
      port: settings.port
    });

    const finish = (error) => {
      socket.removeAllListeners();
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve({ latencyMs: Date.now() - startedAt });
    };

    socket.setTimeout(settings.timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error(`เชื่อมต่อไม่ทันภายใน ${settings.timeoutMs} ms`)));
    socket.once('error', (error) => finish(error));
  });
}

function writeToPrinter(settings, payload) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const socket = net.createConnection({
      host: settings.host,
      port: settings.port
    });

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.end();
      setTimeout(() => socket.destroy(), 100).unref();
      resolve({
        bytes: payload.length,
        elapsedMs: Date.now() - startedAt
      });
    };

    const fail = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(settings.timeoutMs);
    socket.once('connect', () => {
      socket.write(payload, (error) => {
        if (error) {
          fail(error);
          return;
        }

        finish();
      });
    });
    socket.once('timeout', () => fail(new Error(`ส่งงานพิมพ์ไม่ทันภายใน ${settings.timeoutMs} ms`)));
    socket.once('error', fail);
  });
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: 'ignore'
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      resolve({ timedOut: true });
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (code && code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }

      resolve({ timedOut: false });
    });
  });
}

function powershellString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function execPowerShell(script, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

function tempPrintPath(fileName) {
  const ext = path.extname(fileName || '') || '.txt';
  const safeExt = /^[a-z0-9.]+$/i.test(ext) ? ext : '.txt';
  return path.join(os.tmpdir(), `printwifi-${Date.now()}-${Math.random().toString(16).slice(2)}${safeExt}`);
}

function cleanupFile(filePath) {
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, 30000).unref();
}

function isTextPrintFile(fileName) {
  return ['.txt', '.csv', '.json', '.log', '.html', '.htm', '.xml', '.md', '.js', '.css', '.yaml', '.yml']
    .includes(path.extname(fileName || '').toLowerCase());
}

async function systemPrinterInfo(settings) {
  if (process.platform !== 'win32') {
    return {
      printerName: settings.systemPrinter || 'system default',
      platform: process.platform
    };
  }

  const script = `
$name = ${powershellString(settings.systemPrinter || '')}
if ($name) {
  Get-Printer -Name $name -ErrorAction Stop | Select-Object Name,DriverName,PortName,PrinterStatus | ConvertTo-Json -Compress
} else {
  Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress
}
`;
  const output = await execPowerShell(script, settings.timeoutMs);
  return output ? JSON.parse(output) : { printerName: settings.systemPrinter || 'system default' };
}

async function listSystemPrinters() {
  if (process.platform !== 'win32') {
    return [];
  }

  const script = `
Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | ConvertTo-Json -Compress
`;
  const output = await execPowerShell(script, 10000);
  if (!output) {
    return [];
  }

  const printers = JSON.parse(output);
  return Array.isArray(printers) ? printers : [printers];
}

async function printWithSystemPrinter(settings, file) {
  if (process.platform !== 'win32') {
    throw httpError(501, 'โหมด USB/System ตอนนี้รองรับบน Windows เท่านั้น');
  }

  const fileName = file.fileName || 'printwifi.txt';
  const filePath = tempPrintPath(fileName);
  const payload = Buffer.isBuffer(file.payload)
    ? file.payload
    : Buffer.from(String(file.payload || ''), 'utf8');

  if (!payload.length) {
    throw httpError(400, 'ไม่มีข้อมูลสำหรับพิมพ์');
  }

  fs.writeFileSync(filePath, payload);
  cleanupFile(filePath);

  const startedAt = Date.now();
  const timeoutMs = Math.max(settings.timeoutMs, 10000);

  if (isTextPrintFile(fileName)) {
    const args = settings.systemPrinter
      ? ['/pt', filePath, settings.systemPrinter]
      : ['/p', filePath];
    await runProcess('notepad.exe', args, timeoutMs);
  } else {
    const script = `
$file = ${powershellString(filePath)}
$process = Start-Process -FilePath $file -Verb Print -PassThru
if ($process) {
  Wait-Process -Id $process.Id -Timeout 20 -ErrorAction SilentlyContinue
}
`;
    await execPowerShell(script, timeoutMs + 5000);
  }

  return {
    bytes: payload.length,
    elapsedMs: Date.now() - startedAt,
    printerName: settings.systemPrinter || 'Windows default printer'
  };
}

function dispatchPrint(settings, payload, fileName = 'printwifi.txt') {
  if (settings.mode === 'system') {
    return printWithSystemPrinter(settings, {
      fileName,
      payload
    });
  }

  return writeToPrinter(settings, payload);
}

function escposPayload({ text, align = 'left', feedLines = 4, cut = true }) {
  const safeText = String(text || '').replace(/\r?\n/g, '\n');
  const alignment = {
    left: 0,
    center: 1,
    right: 2
  }[align] ?? 0;

  const buffers = [
    Buffer.from([0x1b, 0x40]), // Initialize printer
    Buffer.from([0x1b, 0x61, alignment]),
    Buffer.from(safeText, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from([0x1b, 0x64, Math.max(0, Math.min(8, Number(feedLines) || 0))])
  ];

  if (cut) {
    buffers.push(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
  }

  return Buffer.concat(buffers);
}

function rawPayload({ text, feedLines = 2 }) {
  const safeText = String(text || '').replace(/\r?\n/g, '\r\n');
  return Buffer.from(`${safeText}${'\r\n'.repeat(Math.max(0, Math.min(8, Number(feedLines) || 0)))}`, 'utf8');
}

function rawFilePayload({ data, fileName = 'file' }) {
  const payload = Buffer.from(String(data || ''), 'base64');

  if (!payload.length) {
    throw httpError(400, 'ไฟล์ว่างหรืออ่านข้อมูลไม่ได้');
  }

  if (payload.length > MAX_PRINT_FILE_BYTES) {
    throw httpError(413, `ไฟล์ใหญ่เกินไป จำกัด ${Math.round(MAX_PRINT_FILE_BYTES / 1024)} KB`);
  }

  return {
    fileName: path.basename(String(fileName || 'file')),
    payload
  };
}

function systemFilePayload(body) {
  if (body.dataEncoding === 'base64') {
    return rawFilePayload(body);
  }

  const fileName = path.basename(String(body.fileName || 'printwifi.txt'));
  const text = String(body.text || body.data || '').trimEnd();

  if (!text) {
    throw httpError(400, 'ไฟล์ว่างหรือไม่มีข้อความสำหรับพิมพ์');
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_PRINT_FILE_BYTES) {
    throw httpError(413, `ไฟล์ใหญ่เกินไป จำกัด ${Math.round(MAX_PRINT_FILE_BYTES / 1024)} KB`);
  }

  return {
    fileName,
    payload: Buffer.from(`${text}\r\n`, 'utf8')
  };
}

function textFilePayload(body, settings) {
  const fileName = path.basename(String(body.fileName || 'file.txt'));
  const ext = path.extname(fileName).toLowerCase();
  const text = String(body.text || body.data || '').trimEnd();

  if (UNSUPPORTED_FILE_EXTENSIONS.has(ext)) {
    throw httpError(415, 'ไฟล์ PDF/รูปภาพยังพิมพ์ผ่าน RAW TCP โดยตรงไม่ได้ กรุณาใช้ไฟล์ข้อความหรือไฟล์คำสั่งเครื่องพิมพ์');
  }

  if (!text) {
    throw httpError(400, 'ไฟล์ว่างหรือไม่มีข้อความสำหรับพิมพ์');
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_PRINT_FILE_BYTES) {
    throw httpError(413, `ไฟล์ใหญ่เกินไป จำกัด ${Math.round(MAX_PRINT_FILE_BYTES / 1024)} KB`);
  }

  return {
    fileName,
    payload: settings.mode === 'raw'
      ? rawPayload({ text, feedLines: body.feedLines })
      : escposPayload({
        text,
        align: body.align,
        feedLines: body.feedLines,
        cut: body.cut
      })
  };
}

function testText(settings) {
  const now = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour12: false
  });

  return [
    'Wi-Fi Printer Test',
    '--------------------',
    settings.mode === 'system'
      ? `Printer: ${settings.systemPrinter || 'Windows default printer'}`
      : `IP: ${settings.host}`,
    settings.mode === 'system'
      ? 'Mode: USB/System'
      : `Port: ${settings.port}`,
    `Time: ${now}`,
    '',
    'Connection OK'
  ].join('\n');
}

function testPayload(settings) {
  return escposPayload({
    text: testText(settings),
    align: 'center',
    feedLines: 4,
    cut: true
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
  }[ext] || 'application/octet-stream';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true'
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_BYTES) {
        reject(httpError(413, 'ข้อมูลใหญ่เกินไป'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError(400, 'JSON ไม่ถูกต้อง'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(content);
  });
}

async function routeApi(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'printwifi',
      printer: `${printerSettings.host}:${printerSettings.port}`
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      config: printerSettings
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/printers') {
    const printers = await listSystemPrinters();
    sendJson(res, 200, {
      ok: true,
      printers
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readBody(req);
    const config = savePrinterSettings(body);
    sendJson(res, 200, { ok: true, config });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/printer/check') {
    const body = await readBody(req);
    const settings = normalizeSettings({ ...printerSettings, ...body });
    if (settings.mode === 'system') {
      const printer = await systemPrinterInfo(settings);
      sendJson(res, 200, {
        ok: true,
        message: `พร้อมพิมพ์ผ่าน Windows driver: ${settings.systemPrinter || 'default printer'}`,
        printer
      });
      return;
    }

    const result = await connectPrinter(settings);
    sendJson(res, 200, {
      ok: true,
      message: `เชื่อมต่อ ${settings.host}:${settings.port} สำเร็จ`,
      ...result
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/printer/print-test') {
    const body = await readBody(req);
    const settings = normalizeSettings({ ...printerSettings, ...body });
    const payload = settings.mode === 'system'
      ? Buffer.from(`${testText(settings)}\r\n`, 'utf8')
      : testPayload(settings);
    const result = await dispatchPrint(settings, payload, 'printwifi-test.txt');
    sendJson(res, 200, {
      ok: true,
      message: 'ส่งหน้าทดสอบแล้ว',
      ...result
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/printer/print') {
    const body = await readBody(req);
    const settings = normalizeSettings({ ...printerSettings, ...body });
    const text = String(body.text || '').trimEnd();

    if (!text) {
      throw httpError(400, 'กรุณาใส่ข้อความที่จะพิมพ์');
    }

    const payload = settings.mode === 'system'
      ? Buffer.from(`${text}\r\n`, 'utf8')
      : settings.mode === 'raw'
      ? rawPayload(body)
      : escposPayload(body);
    const result = await dispatchPrint(settings, payload, 'printwifi-job.txt');

    sendJson(res, 200, {
      ok: true,
      message: 'ส่งงานพิมพ์แล้ว',
      ...result
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/printer/print-file') {
    const body = await readBody(req);
    const settings = normalizeSettings({ ...printerSettings, ...body });
    const file = settings.mode === 'system'
      ? systemFilePayload(body)
      : body.dataEncoding === 'base64'
        ? rawFilePayload(body)
        : textFilePayload(body, settings);
    const result = await dispatchPrint(settings, file.payload, file.fileName);

    sendJson(res, 200, {
      ok: true,
      message: `ส่งไฟล์ ${file.fileName} แล้ว`,
      fileName: file.fileName,
      ...result
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'API not found'
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.url.startsWith('/api/')) {
      await routeApi(req, res);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      error: error.message || 'Unexpected server error'
    });
  }
});

const webPort = Number(process.env.PORT || webSettings.webServerPort || 8080);

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port <= startPort + 10; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }

  throw new Error(`No available web port found from ${startPort} to ${startPort + 10}`);
}

(async () => {
  const selectedPort = await findAvailablePort(webPort);

  server.listen(selectedPort, () => {
    console.log(`Wi-Fi printer bridge ready at http://localhost:${selectedPort}`);
    console.log(`Printer target: ${printerSettings.host}:${printerSettings.port}`);
  });
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
