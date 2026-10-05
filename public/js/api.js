/**
 * api.js — 模型调用层
 *
 * 两种通道：
 *   server —— 走本机 server.js 代理（Key 留在电脑上，推荐局域网使用时）
 *   direct —— 浏览器直连模型服务（静态部署 / GitHub Pages 时使用，Key 存在本机浏览器）
 *
 * auto 模式会自己挑：服务器在且配了 Key → server；否则浏览器里有 Key → direct。
 */

import {
  buildMessages, buildDesignerMessages, extractJson, normalizeRound,
  normalizeDesign, partialBlocks, salvageRoundFromText, buildSheetMessages, buildPanelMessages
} from './prompt.js';
import { normalizeSheet } from './sheet.js';
import { localRound } from './engine.js';
import { syncConfig } from './sync.js';

const KEY_LLM = 'novel.llm.v1';

export const PROVIDERS = {
  deepseek: { name: 'DeepSeek V4 Pro（默认）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  deepseek_flash: { name: 'DeepSeek Flash（快）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  ollama: { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' }
};

export const localConfig = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(KEY_LLM) || '{}') || {};
    } catch {
      return {};
    }
  },
  write(patch) {
    const next = { ...this.read(), ...patch };
    try { localStorage.setItem(KEY_LLM, JSON.stringify(next)); } catch { /* 配额满 */ }
    return next;
  },
  clear() {
    try { localStorage.removeItem(KEY_LLM); } catch { /* ignore */ }
  }
};

async function jsonFetch(url, options) {
  const token = syncConfig.read().token;
  const res = await fetch(url, {
    ...options,
    headers: { ...(token ? { 'X-Novel-Token': token } : {}), ...((options && options.headers) || {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function apiHeaders() {
  const token = syncConfig.read().token;
  return { 'Content-Type': 'application/json', ...(token ? { 'X-Novel-Token': token } : {}) };
}

export const server = {
  health: async () => {
    try {
      const res = await fetch('/api/health', { headers: apiHeaders(), cache: 'no-store' });
      if (!res.ok) return { ok: false, status: res.status };
      return await res.json();
    } catch {
      return { ok: false };
    }
  },
  info: () => jsonFetch('/api/info').catch(() => ({ ok: false, addresses: [] })),
  getConfig: () => jsonFetch('/api/config').catch(() => ({ ok: false, config: {} })),
  saveConfig: (patch) => jsonFetch('/api/config', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(patch)
  }).catch(() => ({ ok: false, config: {} })),
  models: () => jsonFetch('/api/models').catch(() => ({ ok: false, models: [] }))
};

let serverAlive = null;
export async function probeServer(force) {
  if (serverAlive !== null && !force) return serverAlive;
  const health = await server.health();
  serverAlive = {
    up: Boolean(health?.ok),
    hasKey: Boolean(health?.hasKey),
    model: health?.model || '',
    needToken: health?.status === 403
  };
  return serverAlive;
}

/** 决定这一轮用哪条通道 */
export async function resolveTransport() {
  const local = localConfig.read();
  const mode = local.mode || 'auto';
  const srv = await probeServer();
  if (mode === 'direct') return local.apiKey ? { kind: 'direct', cfg: local } : { kind: 'none', reason: 'direct-no-key' };
  if (mode === 'server') return srv.up ? { kind: 'server', cfg: srv } : { kind: 'none', reason: 'no-server' };
  if (srv.up && srv.hasKey) return { kind: 'server', cfg: srv };
  if (local.apiKey) return { kind: 'direct', cfg: local };
  if (srv.up) return { kind: 'server', cfg: srv };
  return { kind: 'none', reason: 'no-key' };
}

/* ---------------- 底层请求 ---------------- */

function endpointOf(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function friendly(status, text) {
  let detail = String(text || '').slice(0, 400);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.message || detail;
  } catch { /* keep */ }
  let hint = '';
  if (status === 401 || /invalid api key|authentication|unauthorized/i.test(detail)) hint = 'Key 无效或没复制完整（DeepSeek 的 Key 以 sk- 开头）。';
  else if (status === 402 || /insufficient|balance|quota/i.test(detail)) hint = '账户余额不足，需要先充值。';
  else if (status === 404 || /model.{0,12}(not|does not)/i.test(detail)) hint = '模型名不对，DeepSeek 用 deepseek-chat。';
  else if (status === 429) hint = '请求太频繁，稍等几秒。';
  else if (/response_format|json_object/i.test(detail)) hint = '该模型不支持强制 JSON 模式。';
  return { detail: String(detail).slice(0, 400), hint, status };
}

async function consumeStream(response, onPartial) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';
  let notified = 0;
  let lastPush = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.novelError) throw Object.assign(new Error(chunk.novelError), { kind: 'network' });
      if (chunk.error) throw Object.assign(new Error(chunk.error.message || '模型返回错误'), { kind: 'upstream' });
      const delta = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || '';
      if (!delta) continue;
      text += delta;
      if (onPartial) {
        const blocks = partialBlocks(text);
        const now = Date.now();
        // 节流：手机上每秒钟重排十几次会很卡，控制在一秒 8 次以内
        if (blocks.length > notified && now - lastPush > 120) {
          notified = blocks.length;
          lastPush = now;
          onPartial(blocks, text);
        }
      }
    }
  }
  return text;
}

/**
 * 统一请求入口。任何失败都抛出带 hint 的错误。
 * @param {{messages:Array, stream?:boolean, json?:boolean, onPartial?:Function, signal?:AbortSignal}} opts
 */
export async function request({ messages, stream = true, json = true, onPartial, signal, reasoning }) {
  const t = await resolveTransport();
  if (t.kind === 'none') {
    throw Object.assign(new Error(t.reason === 'no-server' ? '没有可用的模型通道' : '还没有配置 API Key'), { kind: 'no_key' });
  }

  if (t.kind === 'server') {
    let res;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ messages, stream, config: reasoning ? { reasoningEffort: reasoning } : undefined }),
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const where = location.origin;
      const hint = /trycloudflare|ngrok|serveo/.test(where)
        ? '你打开的是旧的临时隧道地址，那个隧道早就关了。请改用固定的 Tailscale 地址（或电脑上的 localhost:8787）。'
        : '检查网络是否正常；手机端请确认能连上家里的电脑（同一 WiFi 用局域网地址，在外用 Tailscale 地址）。';
      throw Object.assign(new Error(`连不上服务（${where}）`), { kind: 'network', hint });
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'network' });
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({ ok: false, message: '返回不是 JSON' }));
      if (!data.ok) {
        throw Object.assign(new Error(data.message || '模型调用失败'), {
          kind: data.error, hint: data.hint || '', status: data.status
        });
      }
      return data.content || '';
    }
    const text = await consumeStream(res, onPartial);
    return text;
  }

  // ---- 浏览器直连 ----
  const cfg = reasoning ? { ...(t.cfg || {}), reasoningEffort: reasoning } : (t.cfg || {});
  const target = endpointOf(cfg.baseUrl);
  const build = (withJson, lean) => {
    const body = { model: cfg.model || 'deepseek-chat', messages, stream };
    if (!lean) {
      body.temperature = Number(cfg.temperature ?? 0.9);
      body.max_tokens = Number(cfg.maxTokens ?? 32000);
    }
    if (cfg.reasoningEffort === 'off') body.thinking = { type: 'disabled' };
    else if (['low', 'medium', 'high'].includes(cfg.reasoningEffort)) body.reasoning_effort = cfg.reasoningEffort;
    if (withJson) body.response_format = { type: 'json_object' };
    return body;
  };

  const attempts = [{ json: Boolean(json), lean: false }, { json: false, lean: false }, { json: false, lean: true }];
  let last = null;
  for (const attempt of attempts) {
    let res;
    try {
      res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(build(attempt.json, attempt.lean)),
        signal
      });
    } catch (err) {
      throw Object.assign(new Error(`连不上 ${target}：${err.message}`), {
        kind: 'network',
        hint: '检查网络，或确认地址写对了（DeepSeek 是 https://api.deepseek.com/v1）。'
      });
    }
    if (res.ok) {
      const ctype = res.headers.get('content-type') || '';
      if (stream && ctype.includes('text/event-stream')) return consumeStream(res, onPartial);
      const data = await res.json().catch(() => null);
      return data?.choices?.[0]?.message?.content || '';
    }
    const text = await res.text().catch(() => '');
    last = friendly(res.status, text);
    const retryable = res.status === 400 && /response_format|json_object|temperature|max_tokens|reasoning_effort|thinking|unsupported|invalid_request/i.test(text);
    if (!retryable) break;
  }
  throw Object.assign(new Error(last?.detail || '模型调用失败'), {
    kind: 'upstream', hint: last?.hint || '', status: last?.status
  });
}

/* ---------------- 诊断 ---------------- */

export async function testConnection(override) {
  const t = override ? { kind: 'direct', cfg: override } : await resolveTransport();
  if (t.kind === 'none') {
    return {
      ok: false,
      step: 'auth',
      message: t.reason === 'no-server' ? '当前是「只用本机服务」模式，但没连上本地服务。' : '还没有填写 API Key。',
      hint: '在下面粘贴 Key 后保存，再点测试。'
    };
  }
  if (t.kind === 'server') {
    return jsonFetch('/api/test', { method: 'POST', headers: apiHeaders(), body: '{}' })
      .catch((err) => ({ ok: false, message: `本地服务没响应：${err.message}` }));
  }
  const cfg = t.cfg || {};
  const target = endpointOf(cfg.baseUrl);
  const started = Date.now();
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model || 'deepseek-chat',
        messages: [{ role: 'user', content: '只回复两个字：可以' }],
        max_tokens: 16,
        stream: false
      })
    });
    const text = await res.text();
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const info = friendly(res.status, text);
      return {
        ok: false, step: 'upstream', status: res.status, latencyMs, endpoint: target,
        message: info.detail, hint: info.hint, raw: text.slice(0, 500)
      };
    }
    let content = '';
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content || ''; } catch { /* ignore */ }
    return {
      ok: true, step: 'done', latencyMs, endpoint: target, model: cfg.model,
      message: `连接成功（${latencyMs}ms），模型回复「${String(content).trim()}」`
    };
  } catch (err) {
    return { ok: false, step: 'network', endpoint: target, message: `请求没发出去：${err.message}`, hint: '检查网络或代理设置。' };
  }
}

/* ---------------- 业务封装 ---------------- */

function makeRound(session, parsed, prevEmotions, engine) {
  const round = normalizeRound(parsed, session, prevEmotions);
  round.engine = engine || 'llm';
  return round;
}

export async function generateRound({ session, cursor, onPartial, signal, styleSample, withPanels = false }) {
  const prevEmotions = cursor >= 0
    ? session.rounds[cursor].emotions
    : Object.fromEntries(session.setup.emotions.map((k) => [k, 0]));

  try {
    const raw = await request({
      messages: buildMessages(session, cursor, { styleSample, noPanels: !withPanels }),
      stream: true, json: true, onPartial, signal
    });
    let parsed;
    let salvaged = false;
    try {
      parsed = extractJson(raw);
    } catch (err) {
      if (!err || !err.raw) throw err;
      // JSON 结构坏了（模型多写了引号/被截断）—— 字段级抢救，尽量别浪费这一轮
      parsed = salvageRoundFromText(err.raw, session);
      salvaged = true;
    }
    const round = makeRound(session, parsed, prevEmotions, 'llm');
    if (!round.blocks.length) throw Object.assign(new Error('模型没有返回正文'), { kind: 'empty' });
    if (salvaged) round.repaired = true;
    return { round, engine: 'llm', repaired: salvaged };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // 配了 Key 却调用失败：宁可什么都不写，也绝不把示例引擎的模板文字塞进玩家的剧情
    if (err.kind !== 'no_key') {
      err.retryable = true;
      throw err;
    }
    // 完全没配 Key：才降级到本地示例引擎
    const round = await localRound({
      session,
      cursor,
      action: session.pendingAction,
      onProgress: onPartial ? (blocks) => onPartial(blocks, '') : null
    });
    return {
      round: makeRound(session, round, prevEmotions, 'local'),
      engine: 'local',
      warning: '未配置模型 API Key，本轮由本地示例引擎生成（文字偏模板化）。'
    };
  }
}

/** 正文出来之后，再单独（后台）补这一轮的面板内容 —— 让正文先到玩家眼前 */
export async function generatePanels({ session, cursor, panels, signal }) {
  const raw = await request({
    messages: buildPanelMessages(session, cursor, panels),
    stream: false,
    json: true,
    reasoning: 'off',          // 面板不需要深度思考，快就好
    signal
  });
  const parsed = extractJson(raw);
  return parsed.panels && typeof parsed.panels === 'object' ? parsed.panels : {};
}

/** 让导演按剧情自动配置标题 / 情感指标 / 顶部与底部按钮 */
export async function designSetup({ draft, localFallback }) {
  try {
    const raw = await request({ messages: buildDesignerMessages(draft), stream: false, json: true });
    const design = normalizeDesign(extractJson(raw));
    if (!design.bottomPanels.length && !design.topPanels.length) throw new Error('模型没有给出面板');
    return { ok: true, design, engine: 'llm' };
  } catch (err) {
    return {
      ok: false,
      design: localFallback ? localFallback() : null,
      engine: 'local',
      error: err.message,
      hint: err.hint || ''
    };
  }
}

/** 人设工坊：把粗略要点扩写成完整角色卡 */
export async function designSheet({ rough, mode, intensity, orientation }) {
  try {
    const raw = await request({ messages: buildSheetMessages(rough, { mode, intensity, orientation }), stream: false, json: true });
    return { ok: true, sheet: normalizeSheet(extractJson(raw)) };
  } catch (err) {
    return { ok: false, error: err.message, hint: err.hint || '' };
  }
}
