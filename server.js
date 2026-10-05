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
const zlib = require('zlib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const DEFAULTS = {
  baseUrl: process.env.NOVEL_API_BASE || 'https://api.deepseek.com/v1',
  apiKey: process.env.NOVEL_API_KEY || '',
  model: process.env.NOVEL_MODEL || 'deepseek-chat',
  temperature: 0.9,
  maxTokens: 32000,
  stream: true,
  jsonMode: true,
  timeoutMs: 180000,
  syncToken: '',
  reasoningEffort: 'default'
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
  for (const key of ['baseUrl', 'apiKey', 'model', 'systemExtra', 'syncToken', 'styleSample', 'defaultMode', 'reasoningEffort', 'defaultOrientation']) {
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

/** 能压就压：隧道/手机上，100KB 的剧情数据压缩后通常只剩十几 KB */
function maybeGzip(req, res, buf, type) {
  const accept = String(req?.headers?.['accept-encoding'] || '');
  if (!/gzip/.test(accept)) return buf;
  if (buf.length < 1024) return buf;
  if (!/^(text\/|application\/(json|javascript|manifest))/.test(type)) return buf;
  try {
    const gz = zlib.gzipSync(buf, { level: 6 });
    if (gz.length >= buf.length * 0.92) return buf;
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return gz;
  } catch {
    return buf;
  }
}

function sendJson(res, status, obj, req) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const body = maybeGzip(req, res, raw, 'application/json; charset=utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
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
let storeLoadFailed = false;
let lastCount = -1;
let lastBackupAt = 0;

async function loadStore() {
  if (storeCache) return storeCache;
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    storeCache = { updatedAt: parsed.updatedAt || 0, sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    storeLoadFailed = false;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // 首次运行：文件还不存在，这是正常的
      storeCache = { updatedAt: 0, sessions: [] };
      storeLoadFailed = false;
    } else {
      // 读到了但解析失败（例如正被写入）——**绝不能当作空数据**，
      // 否则下一次写入就会把用户所有剧情覆盖掉
      console.error('[novel] 数据文件读取失败，已进入保护模式（不会写回）:', err.message);
      storeCache = { updatedAt: 0, sessions: [] };
      storeLoadFailed = true;
    }
  }
  lastCount = storeCache.sessions.length;
  return storeCache;
}

/** 滚动备份：平时每 3 分钟一份，数量变少时立刻留一份（这类事故的唯一救命绳） */
async function writeBackup(payload, tag) {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.writeFile(path.join(BACKUP_DIR, `sessions-${stamp}${tag}.json`), payload, 'utf8');
    lastBackupAt = Date.now();
    const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) {
      await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
    }
  } catch { /* 备份失败不影响主流程 */ }
}

async function persistStore() {
  if (!storeCache) return;
  if (storeLoadFailed) {
    console.error('[novel] 之前读取数据文件失败，本次拒绝写回，避免覆盖已有剧情。请重启服务。');
    return;
  }
  storeCache.updatedAt = Date.now();
  const payload = JSON.stringify(storeCache);
  const count = storeCache.sessions.length;
  const shrank = lastCount >= 0 && count < lastCount;
  if (shrank || Date.now() - lastBackupAt > 180000) {
    await writeBackup(payload, shrank ? '-shrink' : '');
  }
  if (shrank) {
    console.warn(`[novel] 注意：剧情数量从 ${lastCount} 变成 ${count}，已在 data/backups/ 留档`);
  }
  lastCount = count;
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

/**
 * 合并同一部剧情的两份副本：整体取 updatedAt 较新的，
 * 但轮次做并集（同序号取 createdAt 较新的），保证任何一端写的内容都不会被覆盖。
 */
/** 分支存档指纹：跨设备要算出同一个 key，否则会越并越多（曾把数据撑到 74MB） */
function branchKey(b) {
  const rounds = b && Array.isArray(b.rounds) ? b.rounds : [];
  return `${(b && b.at) ?? -1}|${(b && b.atTime) ?? 0}|${rounds.length}|${(rounds[0] && rounds[0].createdAt) || 0}`;
}

const BRANCH_KEEP_ROUNDS = 5;
const BRANCH_KEEP_COUNT = 5;

function trimBranch(b) {
  if (!b || !Array.isArray(b.rounds)) return b;
  return b.rounds.length <= BRANCH_KEEP_ROUNDS ? b : { ...b, rounds: b.rounds.slice(-BRANCH_KEEP_ROUNDS) };
}

function mergeBranches(a, b, limit = BRANCH_KEEP_COUNT) {
  const map = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    if (!x || !Array.isArray(x.rounds)) continue;
    const k = branchKey(x);
    if (!map.has(k)) map.set(k, trimBranch(x));
  }
  return Array.from(map.values())
    .sort((x, y) => (y.atTime || 0) - (x.atTime || 0))
    .slice(0, limit);
}

function pickSession(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
  const older = newer === a ? b : a;
  const out = { ...newer };
  const len = Math.max((a.rounds || []).length, (b.rounds || []).length);
  if (len) {
    const rounds = [];
    for (let i = 0; i < len; i += 1) {
      const ra = a.rounds && a.rounds[i];
      const rb = b.rounds && b.rounds[i];
      if (!ra) rounds.push(rb);
      else if (!rb) rounds.push(ra);
      else rounds.push((ra.createdAt || 0) >= (rb.createdAt || 0) ? ra : rb);
    }
    out.rounds = rounds;
    const want = Number.isFinite(newer.cursor) ? newer.cursor : rounds.length - 1;
    out.cursor = Math.max(0, Math.min(want, rounds.length - 1));
  }
  out.branches = mergeBranches(newer.branches, older.branches);
  return out;
}

/** 合并：同 id 逐轮并集；deleted 里的 id 直接删掉 */
function mergeStore(incoming, deleted) {
  const map = new Map((storeCache?.sessions || []).map((s) => [s.id, s]));
  for (const id of deleted || []) map.delete(id);
  for (const s of incoming || []) {
    if (!s || !s.id) continue;
    map.set(s.id, pickSession(map.get(s.id), s));
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
  // 轻量版本号：客户端先问这个，没变就不下载整份数据（手机上打开会快很多）
  if (pathname === '/api/store/version') {
    const store = await loadStore();
    return sendJson(res, 200, {
      ok: true,
      updatedAt: store.updatedAt,
      count: store.sessions.length
    }, req);
  }
  if (req.method === 'GET') {
    const store = await loadStore();
    return sendJson(res, 200, { ok: true, updatedAt: store.updatedAt, sessions: store.sessions }, req);
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
    const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
    const body = maybeGzip(req, res, data, type);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    });
    res.end(body);
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
    styleSample: config.styleSample || '',
    defaultMode: config.defaultMode || 'balanced',
    reasoningEffort: config.reasoningEffort || 'low',
    defaultOrientation: config.defaultOrientation || 'mm',
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
    // 推理模型：思考很吃时间，允许调低甚至关掉
    if (cfg.reasoningEffort === 'off') payload.thinking = { type: 'disabled' };
    else if (['low', 'medium', 'high'].includes(cfg.reasoningEffort)) payload.reasoning_effort = cfg.reasoningEffort;
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
        /response_format|json_object|temperature|max_tokens|reasoning_effort|thinking|unsupported|invalid_request/i.test(probe);
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

    // 关键：推理模型的"思考"也是逐 token 流式过来的，每个事件约 250 字节。
    // 一次生成能产生近 1MB 的思考数据，而前端只需要正文 —— 手机上这纯属浪费带宽。
    // 这里把 reasoning_content 与空 delta 全部丢掉，只转发正文增量。
    const forward = (obj) => {
      try {
        const choice = obj?.choices?.[0];
        if (!choice) return;
        const delta = choice.delta || {};
        delete delta.reasoning_content;
        const hasContent = typeof delta.content === 'string' && delta.content.length;
        if (!hasContent && !choice.finish_reason) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: choice.finish_reason ?? null }] })}\n\n`);
      } catch {
        /* 忽略无法解析的行 */
      }
    };

    const decoder = new TextDecoder('utf-8');
    let sseBuf = '';
    let lastBeat = Date.now();
    try {
      for await (const chunk of upstream.body) {
        sseBuf += decoder.decode(chunk, { stream: true });
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
          try {
            forward(JSON.parse(payload));
          } catch {
            /* 上游偶发的非 JSON 行，忽略 */
          }
        }
        // 长时间只有思考、没有正文时，发个心跳避免中间层超时断连
        if (Date.now() - lastBeat > 5000) {
          lastBeat = Date.now();
          res.write(': keepalive\n\n');
        }
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
    return sendJson(res, 200, { ok: true, config: publicConfig() }, req);
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
