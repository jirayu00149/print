const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEB_SETTINGS_FILE = path.join(ROOT, 'webServerApiSettings.json');
const PRINTER_SETTINGS_FILE = path.join(ROOT, 'printer-settings.json');

const DEFAULTS = {
  host: process.env.PRINTER_HOST || '192.168.10.1',
  port: Number(process.env.PRINTER_PORT || 9100),
  timeoutMs: Number(process.env.PRINTER_TIMEOUT_MS || 3000),
  mode: 'escpos'
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const webSettings = readJson(WEB_SETTINGS_FILE, {});
let printerSettings = {
  ...DEFAULTS,
  ...readJson(PRINTER_SETTINGS_FILE, {})
};

function normalizeSettings(input = {}) {
  const host = String(input.host || printerSettings.host || DEFAULTS.host).trim();
  const port = Number(input.port || printerSettings.port || DEFAULTS.port);
  const timeoutMs = Number(input.timeoutMs || printerSettings.timeoutMs || DEFAULTS.timeoutMs);
  const mode = input.mode === 'raw' ? 'raw' : 'escpos';

  if (!host) {
    throw httpError(400, 'กรุณาระบุ IP เครื่องพิมพ์');
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, 'พอร์ตเครื่องพิมพ์ไม่ถูกต้อง');
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) {
    throw httpError(400, 'timeout ต้องอยู่ระหว่าง 500-30000 ms');
  }

  return { host, port, timeoutMs, mode };
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

function testPayload(settings) {
  const now = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour12: false
  });

  const text = [
    'Wi-Fi Printer Test',
    '--------------------',
    `IP: ${settings.host}`,
    `Port: ${settings.port}`,
    `Time: ${now}`,
    '',
    'Connection OK'
  ].join('\n');

  return escposPayload({
    text,
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
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
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

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      config: printerSettings
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
    const result = await writeToPrinter(settings, testPayload(settings));
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

    const payload = settings.mode === 'raw'
      ? rawPayload(body)
      : escposPayload(body);
    const result = await writeToPrinter(settings, payload);

    sendJson(res, 200, {
      ok: true,
      message: 'ส่งงานพิมพ์แล้ว',
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
