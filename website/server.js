const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://127.0.0.1:5006';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

/** 业务系统路由：官网与系统同域，这些路径交给 APP_ORIGIN 处理。 */
const APP_PATHS = [
  '/api',
  '/assets',
  '/login',
  '/register',
  '/dashboard',
  '/users',
  '/archives',
  '/knowledge-graph',
  '/templates',
  '/borrow',
  '/audit',
  '/system',
  '/images/ecosystem',
  '/images/qutan-ai-official-account-qr.png'
];

function parsePathname(requestUrl) {
  try {
    return decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

function isAppPath(pathname) {
  return APP_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function resolveFilePath(pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, relativePath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  return resolved;
}

function sendError(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(message);
}

/** 取逗号分隔请求头的首个值；代理链上只信任最靠近客户端的那个。 */
function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').split(',')[0].trim();
}

function proxyToApp(req, res) {
  const target = new URL(req.url || '/', APP_ORIGIN);
  const transport = target.protocol === 'https:' ? https : http;
  // 保留上游（Nginx）传入的协议与主机：本进程在 8080 收到的往往是 Nginx 的明文转发，
  // 不能只看 req.socket.encrypted，否则会把 https 覆盖成 http，导致 JitWord 票据 origin 不一致。
  const forwardedProto =
    firstHeaderValue(req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;
  const headers = {
    ...req.headers,
    // 保留浏览器访问地址，后端据此解析 JitWord 票据 origin。
    host: forwardedHost,
    'x-forwarded-host': forwardedHost,
    'x-forwarded-proto': forwardedProto,
    'x-forwarded-for': req.socket.remoteAddress || ''
  };

  const proxyReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.pathname + target.search,
      headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.setTimeout(300000, () => proxyReq.destroy(new Error('upstream timeout')));
  proxyReq.on('error', () => {
    if (!res.headersSent) sendError(res, 502, 'Bad Gateway');
    else res.destroy();
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const pathname = parsePathname(req.url || '/');
  if (!pathname) {
    sendError(res, 400, 'Bad Request');
    return;
  }

  if (isAppPath(pathname)) {
    proxyToApp(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  const filePath = resolveFilePath(pathname);
  if (!filePath) {
    sendError(res, 400, 'Bad Request');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      sendError(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
    };

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.destroy();
    });
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('JitArchives 官网运行中: http://' + HOST + ':' + PORT);
  console.log('静态目录: ' + ROOT);
  console.log('业务系统代理: ' + APP_ORIGIN);
});
