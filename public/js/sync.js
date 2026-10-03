/**
 * sync.js — 跨设备同步
 *
 * 数据放在哪：跑 server.js 的那台电脑上，文件是 novel/data/sessions.json。
 * 手机 / 平板 / 电脑打开同一个服务地址时，读写的都是这一份，所以天然同步。
 * 没有服务时（例如直接开线上版），退化成浏览器本地存储，只在这台设备可见。
 */

const KEY = 'novel.sync.v1';

export const syncConfig = {
  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
  },
  write(patch) {
    const next = { ...this.read(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  }
};

const state = {
  available: false,   // 有没有可用的同步服务
  kind: 'local',      // local | server | remote
  base: '',           // '' = 同源；否则是远端地址
  busy: false,
  lastSync: 0,
  error: '',
  count: 0
};

export function syncState() {
  return { ...state, serverUrl: syncConfig.read().serverUrl || '' };
}

function headers() {
  const token = syncConfig.read().token;
  return token
    ? { 'Content-Type': 'application/json', 'X-Novel-Token': token }
    : { 'Content-Type': 'application/json' };
}

async function probe(base) {
  try {
    const res = await fetch(`${base}/api/health`, { headers: headers(), cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

/** 启动时判断走哪条路：同源服务 → 配置的远端服务 → 纯本地 */
export async function initSync() {
  const same = await probe('');
  if (same?.sync) {
    state.available = true;
    state.kind = 'server';
    state.base = '';
    return true;
  }
  const cfg = syncConfig.read();
  if (cfg.serverUrl) {
    const base = String(cfg.serverUrl).replace(/\/+$/, '');
    const remote = await probe(base);
    if (remote?.sync) {
      state.available = true;
      state.kind = 'remote';
      state.base = base;
      return true;
    }
    state.error = `连不上 ${base}`;
  }
  state.available = false;
  state.kind = 'local';
  return false;
}

export async function pull() {
  if (!state.available) throw new Error('没有可用的同步服务');
  const res = await fetch(`${state.base}/api/store`, { headers: headers(), cache: 'no-store' });
  if (res.status === 403) throw new Error('同步口令不正确');
  if (!res.ok) throw new Error(`服务返回 ${res.status}`);
  const data = await res.json();
  state.lastSync = Date.now();
  state.error = '';
  state.count = (data.sessions || []).length;
  return data;
}

export async function push({ sessions = [], deleted = [] }) {
  if (!state.available) throw new Error('没有可用的同步服务');
  const res = await fetch(`${state.base}/api/store`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessions, deleted })
  });
  if (res.status === 403) throw new Error('同步口令不正确');
  if (!res.ok) throw new Error(`服务返回 ${res.status}`);
  const data = await res.json();
  state.lastSync = Date.now();
  state.error = '';
  state.count = data.count ?? state.count;
  return data;
}

export function markError(message) {
  state.error = message || '同步失败';
}

export function clearError() {
  state.error = '';
}

/** 合并两份数据：同 id 取 updatedAt 更新的那份 */
export function mergeSessions(local, remote) {
  const map = new Map();
  for (const s of local || []) if (s?.id) map.set(s.id, s);
  for (const s of remote || []) {
    if (!s?.id) continue;
    const old = map.get(s.id);
    if (!old || (s.updatedAt || 0) > (old.updatedAt || 0)) map.set(s.id, s);
  }
  return Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
