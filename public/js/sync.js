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

let lastProbeReason = '';

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
    if (!res.ok) {
      lastProbeReason = res.status === 403 ? '口令不对' : `HTTP ${res.status}`;
      return null;
    }
    const data = await res.json();
    if (!data?.ok) { lastProbeReason = '返回异常'; return null; }
    return data;
  } catch (err) {
    // 跨域被拦、DNS 失败、证书问题都会走到这里
    lastProbeReason = err?.message || '网络错误';
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
    state.errorDetail = lastProbeReason;
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

/** 只问版本号（很小），用来判断要不要下载整份数据 */
export async function version() {
  if (!state.available) return null;
  try {
    const res = await fetch(`${state.base}/api/store/version`, { headers: headers(), cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 换 key 名 = 让所有设备强制做一次全量拉取，修掉之前"跳过下载"留下的陈旧副本
const KEY_VERSION = 'novel.storeVersion.v2';
export const lastVersion = {
  get() { try { return localStorage.getItem(KEY_VERSION) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(KEY_VERSION, String(v || '')); } catch { /* ignore */ } }
};

export async function push({ sessions = [], deleted = [] }) {
  if (!state.available) throw new Error('没有可用的同步服务');
  const res = await fetch(`${state.base}/api/store`, {
    method: 'POST',
    headers: headers(),
    // echo: 让服务器把"合并后的完整结果"回传 —— 否则本机可能一直缺着别端的轮次
    body: JSON.stringify({ sessions, deleted, echo: true })
  });
  if (res.status === 403) throw new Error('同步口令不正确');
  if (!res.ok) throw new Error(`服务返回 ${res.status}`);
  const data = await res.json();
  state.lastSync = Date.now();
  state.error = '';
  state.count = data.count ?? state.count;
  if (data.updatedAt) lastVersion.set(data.updatedAt);
  return data;
}

export function markError(message) {
  state.error = message || '同步失败';
}

export function clearError() {
  state.error = '';
}

/**
 * 合并同一部剧情的两份副本。
 * 规则：整体以 updatedAt 较新的那份为准（标题/设定/游标），
 *       但**轮次做并集** —— 同序号取 createdAt 较新的，谁都不丢。
 * 这样即使时间戳判断出错，也不会再出现"某一端写的内容被覆盖"。
 */
/** 分支存档的指纹：同一个分支在不同设备上必须算出同一个 key，否则会越并越多 */
function branchKey(b) {
  const rounds = b?.rounds || [];
  return `${b?.at ?? -1}|${b?.atTime ?? 0}|${rounds.length}|${rounds[0]?.createdAt || 0}`;
}

/** 支线存档上限：每条支线最多留 5 轮，总共最多留 5 条 */
export const BRANCH_KEEP_ROUNDS = 5;
export const BRANCH_KEEP_COUNT = 5;

export function trimBranch(b) {
  if (!b || !Array.isArray(b.rounds)) return b;
  return b.rounds.length <= BRANCH_KEEP_ROUNDS ? b : { ...b, rounds: b.rounds.slice(-BRANCH_KEEP_ROUNDS) };
}

/** 分支去重 + 截断到 5 轮 + 只留最新 5 条 */
export function mergeBranches(a, b, limit = BRANCH_KEEP_COUNT) {
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

export function pickSession(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
  const older = newer === a ? b : a;
  const out = { ...newer };

  const len = Math.max(a.rounds?.length || 0, b.rounds?.length || 0);
  if (len) {
    const rounds = [];
    for (let i = 0; i < len; i += 1) {
      const ra = a.rounds?.[i];
      const rb = b.rounds?.[i];
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

/** 合并两份数据（游标保留本机的 —— 你看到第几轮是每台设备自己的事） */
export function mergeSessions(local, remote) {
  const map = new Map();
  const localCursor = new Map();
  for (const s of local || []) {
    if (!s?.id) continue;
    map.set(s.id, s);
    localCursor.set(s.id, s.cursor);
  }
  for (const s of remote || []) {
    if (!s?.id) continue;
    map.set(s.id, pickSession(map.get(s.id), s));
  }
  const out = Array.from(map.values()).map((s) => {
    if (!localCursor.has(s.id) || !Array.isArray(s.rounds) || !s.rounds.length) return s;
    const want = localCursor.get(s.id);
    if (!Number.isFinite(want)) return s;
    return { ...s, cursor: Math.max(0, Math.min(want, s.rounds.length - 1)) };
  });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
