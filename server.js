#!/usr/bin/env node
/**
 * Novel — 本地服务器
 * 零依赖：静态资源托管 + 大模型 API 代理（Key 只留在本机，不暴露给浏览器）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'sessions.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const DEFAULTS = {
  baseUrl: process.env.NOVEL_API_BASE || 'https://api.deepseek.com/v1',
  apiKey: process.env.NOVEL_API_KEY || '',
  model: process.env.NOVEL_MODEL || 'deepseek-chat',
  temperature: 1.1,
  maxTokens: 8000,
  stream: true,
  jsonMode: true,
  timeoutMs: 180000,
  syncToken: ''
};

let config = { ...DEFAULTS };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...DEFAULTS, ...raw };
    }
  } catch (err) {
    console.warn('[novel] config.json 解析失败，已使用默认配置：', err.message);
  }
}

async function saveConfig(patch) {
  const next = { ...config };
  for (const key of ['baseUrl', 'apiKey', 'model', 'systemExtra', 'syncToken']) {
    if (typeof patch[key] === 'string') next[key] = patch[key].trim();
  }
  for (const key of ['temperature', 'maxTokens', 'timeoutMs']) {
    if (patch[key] !== undefined && !Number.isNaN(Number(patch[key]))) next[key] = Number(patch[key]);
  }
  for (const key of ['stream', 'jsonMode']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  config = next;
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('JSON 解析失败：' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out;
}

/* =========================================================
   跨设备同步：把「所有剧情」存在服务器上，各端连过来共用一份
   ========================================================= */

let storeCache = null;
let storeWriting = null;

async function loadStore() {
  if (storeCache) return storeCache;
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    storeCache = { updatedAt: parsed.updatedAt || 0, sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch {
    storeCache = { updatedAt: 0, sessions: [] };
  }
  return storeCache;
}

async function persistStore() {
  if (!storeCache) return;
  storeCache.updatedAt = Date.now();
  const payload = JSON.stringify(storeCache);
  if (storeWriting) return storeWriting;
  storeWriting = (async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    try { await fsp.copyFile(STORE_FILE, `${STORE_FILE}.bak`); } catch { /* 首次没有旧文件 */ }
    await fsp.rename(tmp, STORE_FILE);
  })().finally(() => { storeWriting = null; });
  return storeWriting;
}

/** 合并：同 id 取 updatedAt 更新的那份；deleted 里的 id 直接删掉 */
function mergeStore(incoming, deleted) {
  const map = new Map((storeCache?.sessions || []).map((s) => [s.id, s]));
  for (const id of deleted || []) map.delete(id);
  for (const s of incoming || []) {
    if (!s || !s.id) continue;
    const old = map.get(s.id);
    if (!old || (s.updatedAt || 0) >= (old.updatedAt || 0)) map.set(s.id, s);
  }
  storeCache.sessions = Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return storeCache;
}

function withCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Novel-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

/**
 * 判断这次请求是不是"从公网进来的"（走了隧道 / 反向代理）。
 * 局域网 IP、机器名、localhost 都算内网，不需要口令。
 */
function isExternalHost(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === os.hostname().toLowerCase()) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;   // 任何 IPv4（含内网）
  if (host.includes(':')) return false;                      // IPv6
  if (!host.includes('.')) return false;                     // 局域网里的机器名
  if (host.endsWith('.local')) return false;
  return true;
}

function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const reqHost = String(req.headers.host || '').toLowerCase();
    if (o.host.toLowerCase() === reqHost) return false;   // 同源（含端口）
  } catch {
    return true;
  }
  return true;
}

function tokenMatches(req, url) {
  const token = req.headers['x-novel-token'] || url.searchParams.get('token');
  return Boolean(config.syncToken) && token === config.syncToken;
}

/** 公网访问、或从别的站点跨域连过来：必须带口令 */
function authBlocked(req, url) {
  if (!isExternalHost(req) && !isCrossOrigin(req)) return null;
  if (tokenMatches(req, url)) return null;
  return {
    ok: false,
    error: 'need_token',
    message: isExternalHost(req)
      ? '需要访问口令。请用带 ?token= 的完整地址打开（启动 server.js 时会打印）。'
      : '同步口令不正确。'
  };
}

async function handleStore(req, res, pathname) {
  if (req.method === 'GET') {
    const store = await loadStore();
    return sendJson(res, 200, { ok: true, updatedAt: store.updatedAt, sessions: store.sessions });
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    let body;
    try {
      body = await readBody(req, 32 * 1024 * 1024);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: 'bad_request', message: err.message });
    }
    await loadStore();
    const sessions = Array.isArray(body) ? body : (body.sessions || []);
    const deleted = Array.isArray(body?.deleted) ? body.deleted : [];
    mergeStore(sessions, deleted);
    await persistStore();
    return sendJson(res, 200, {
      ok: true,
      updatedAt: storeCache.updatedAt,
      count: storeCache.sessions.length,
      sessions: Array.isArray(body?.sessions) && body.echo ? storeCache.sessions : undefined
    });
  }
  if (req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    await loadStore();
    if (id) mergeStore([], [id]);
    else storeCache.sessions = [];
    await persistStore();
    return sendJson(res, 200, { ok: true, count: storeCache.sessions.length });
  }
  return sendJson(res, 405, { ok: false, message: '不支持的请求方法' });
}

async function serveStatic(req, res, pathname) {
  let target = decodeURIComponent(pathname);
  if (target === '/' || target === '') target = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    const real = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const data = await fsp.readFile(real);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function publicConfig() {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    stream: config.stream,
    jsonMode: config.jsonMode,
    hasKey: Boolean(config.apiKey),
    keyPreview: config.apiKey ? `${config.apiKey.slice(0, 4)}····${config.apiKey.slice(-4)}` : ''
  };
}

async function callUpstream(cfg, payload, signal) {
  const base = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const target = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`
  };
  return fetch(target, { method: 'POST', headers, body: JSON.stringify(payload), signal });
}

/** 从各家五花八门的错误体里榨出一句人能看懂的话 */
function explainError(status, text) {
  let detail = String(text || '').slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.message || parsed?.error || detail;
  } catch { /* 保留原文 */ }
  detail = String(detail).slice(0, 600);

  let hint = '';
  if (status === 401 || /invalid api key|authentication|unauthorized|api key/i.test(detail)) {
    hint = 'Key 无效或已过期。请确认复制完整（DeepSeek 的 Key 以 sk- 开头），保存后重试。';
  } else if (status === 402 || /insufficient|balance|quota|余额/i.test(detail)) {
    hint = '账户余额不足，需要先充值。';
  } else if (status === 404 || /model_not_found|does not exist|not found/i.test(detail)) {
    hint = '模型名不对，DeepSeek 请填 deepseek-chat 或 deepseek-reasoner。';
  } else if (status === 429) {
    hint = '请求太频繁或达到速率上限，稍等几秒再试。';
  } else if (/response_format|json_object/i.test(detail)) {
    hint = '该模型不支持强制 JSON 模式，在设置里关掉「强制 JSON」即可。';
  } else if (/temperature|max_tokens|unsupported/i.test(detail)) {
    hint = '该模型不接受某些参数（如 temperature），可以换 deepseek-chat。';
  } else if (status >= 500) {
    hint = '模型服务侧故障，稍后重试。';
  }
  return { detail, hint, status };
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: 'bad_request', message: err.message });
  }

  const cfg = { ...config, ...(body.config || {}) };
  if (!cfg.apiKey) {
    return sendJson(res, 200, {
      ok: false,
      error: 'no_key',
      message: '尚未配置模型 API Key，已切换到本地示例引擎。'
    });
  }

  const wantStream = body.stream !== undefined ? Boolean(body.stream) : Boolean(cfg.stream);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || DEFAULTS.timeoutMs);
  req.on('close', () => controller.abort());

  const build = (jsonMode, lean) => {
    const payload = {
      model: cfg.model,
      messages,
      stream: wantStream
    };
    if (!lean) {
      payload.temperature = Number(cfg.temperature) || 1;
      payload.max_tokens = Number(cfg.maxTokens) || DEFAULTS.maxTokens;
    }
    if (jsonMode) payload.response_format = { type: 'json_object' };
    return payload;
  };

  // 依次降级重试：完整参数 → 去掉强制 JSON → 只留最小参数
  const attempts = [{ json: Boolean(cfg.jsonMode), lean: false }, { json: false, lean: false }, { json: false, lean: true }];
  let upstream = null;
  let lastErr = null;
  try {
    for (const attempt of attempts) {
      upstream = await callUpstream(cfg, build(attempt.json, attempt.lean), controller.signal);
      if (upstream.ok) break;
      const probe = await upstream.text();
      lastErr = explainError(upstream.status, probe);
      const retryable = upstream.status === 400 &&
        /response_format|json_object|temperature|max_tokens|unsupported|invalid_request/i.test(probe);
      if (!retryable) break;
      upstream = null;
    }
  } catch (err) {
    clearTimeout(timer);
    return sendJson(res, 200, {
      ok: false,
      error: 'network',
      message: `无法连接模型服务：${err.message}`
    });
  }

  if (!upstream || !upstream.ok) {
    clearTimeout(timer);
    return sendJson(res, 200, {
      ok: false,
      error: 'upstream',
      status: lastErr?.status || 0,
      message: lastErr?.detail || '模型服务返回异常',
      hint: lastErr?.hint || ''
    });
  }

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ novelError: err.message })}\n\n`);
    } finally {
      clearTimeout(timer);
      res.end();
    }
    return;
  }

  try {
    const data = await upstream.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    clearTimeout(timer);
    sendJson(res, 200, { ok: true, content, usage: data.usage || null });
  } catch (err) {
    clearTimeout(timer);
    sendJson(res, 200, { ok: false, error: 'parse', message: err.message });
  }
}

/** 诊断接口：发一个最小请求，把原始返回如实交回给前端 */
async function handleTest(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* 用默认配置 */ }
  const cfg = { ...config, ...(body.config || {}) };
  if (!cfg.apiKey) {
    return sendJson(res, 200, {
      ok: false,
      step: 'auth',
      message: '还没有填写 API Key。',
      hint: '在设置里粘贴 DeepSeek 的 Key（sk- 开头）后重试。'
    });
  }
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const target = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const started = Date.now();
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '只回复两个字：可以' }],
        max_tokens: 16,
        stream: false
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await r.text();
    const latencyMs = Date.now() - started;
    if (!r.ok) {
      const info = explainError(r.status, text);
      return sendJson(res, 200, {
        ok: false, step: 'upstream', status: r.status, latencyMs,
        endpoint: target, model: cfg.model,
        message: info.detail, hint: info.hint, raw: text.slice(0, 800)
      });
    }
    let content = '';
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content || ''; } catch { /* ignore */ }
    return sendJson(res, 200, {
      ok: true, step: 'done', latencyMs, endpoint: target, model: cfg.model,
      message: `连接成功，模型回复「${content.trim()}」`
    });
  } catch (err) {
    return sendJson(res, 200, {
      ok: false, step: 'network', endpoint: target,
      message: `请求发不出去：${err.message}`,
      hint: '检查网络或代理；DeepSeek 地址应为 https://api.deepseek.com/v1'
    });
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    withCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const blocked = authBlocked(req, parsed);
    if (blocked) return sendJson(res, 403, blocked);
  }

  if (pathname.startsWith('/api/store')) {
    return handleStore(req, res, pathname);
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      engine: config.apiKey ? 'llm' : 'local',
      model: config.model,
      hasKey: Boolean(config.apiKey),
      port: PORT,
      sync: true,
      host: os.hostname()
    });
  }

  if (pathname === '/api/info') {
    return sendJson(res, 200, {
      ok: true,
      port: PORT,
      host: os.hostname(),
      addresses: lanAddresses().map((a) => `http://${a.address}:${PORT}`),
      platform: `${os.platform()} ${os.release()}`
    });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, config: publicConfig() });
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      await saveConfig(body || {});
      return sendJson(res, 200, { ok: true, config: publicConfig() });
    } catch (err) {
      return sendJson(res, 500, { ok: false, message: err.message });
    }
  }

  if (pathname === '/api/models') {
    const cfg = { ...config };
    if (!cfg.apiKey) return sendJson(res, 200, { ok: false, error: 'no_key', models: [] });
    try {
      const base = String(cfg.baseUrl).replace(/\/+$/, '');
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
      const data = await r.json();
      const models = (data.data || []).map((m) => m.id).sort();
      return sendJson(res, 200, { ok: r.ok, models });
    } catch (err) {
      return sendJson(res, 200, { ok: false, models: [], message: err.message });
    }
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res);
  }

  if (pathname === '/api/test' && req.method === 'POST') {
    return handleTest(req, res);
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, message: '未知接口' });
  }

  return serveStatic(req, res, pathname);
});

loadConfig();

// 首次运行生成一个同步口令：跨域（例如从线上版连回家里）访问存储接口时需要它
if (!config.syncToken) {
  config.syncToken = require('crypto').randomBytes(12).toString('hex');
  saveConfig({}).catch(() => {});
}

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  \x1b[38;5;179m▌ Novel\x1b[0m · 沉浸式文字剧情引擎',
    `  \x1b[2m本机访问\x1b[0m   http://localhost:${PORT}`,
  ];
  for (const addr of lanAddresses()) {
    lines.push(`  \x1b[2m局域网访问\x1b[0m http://${addr.address}:${PORT}  \x1b[2m(${addr.name} · 手机/平板用这个)\x1b[0m`);
  }
  lines.push(`  \x1b[2m备用地址\x1b[0m   http://${os.hostname()}:${PORT}  \x1b[2m(IP 变了也能用)\x1b[0m`);
  lines.push(`  \x1b[2m模型状态\x1b[0m   ${config.apiKey ? `已配置 ${config.model}` : '未配置 Key → 使用本地示例引擎'}`);
  lines.push(`  \x1b[2m剧情存储\x1b[0m   ${path.relative(ROOT, STORE_FILE)}  \x1b[2m(各端共用一份)\x1b[0m`);
  lines.push(`  \x1b[2m同步口令\x1b[0m   ${config.syncToken}`);
  lines.push(`  \x1b[2m提示\x1b[0m      同一 WiFi 下，手机/平板直接访问上面的局域网地址即可，剧情自动同步`);
  lines.push('');
  console.log(lines.join('\n'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[novel] 端口 ${PORT} 已被占用，请用 PORT=8790 node server.js 换个端口启动。\n`);
  } else {
    console.error('[novel] 服务启动失败：', err.message);
  }
  process.exit(1);
});
