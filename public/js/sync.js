/**
 * sync.js — 跨设备同步
 *
 * 数据放在哪：跑 server.js 的那台电脑上，文件是 novel/data/sessions.json。
 * 手机 / 平板 / 电脑打开同一个服务地址时，读写的都是这一份，所以天然同步。
 * 没有服务时（例如直接开线上版），退化成浏览器本地存储，只在这台设备可见。
 */

const KEY = 'novel.sync.v1';
const GH_API = 'https://api.github.com';

/** GitHub 私有仓库作为同步盘：不用电脑开机，数据存在你自己的私有仓库里 */
async function ghRequest(cfg, path, options = {}) {
  const url = `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `GitHub 返回 ${res.status}`;
    try { msg = JSON.parse(text)?.message || msg; } catch { /* keep */ }
    if (res.status === 401) msg += '（token 无效或过期）';
    if (res.status === 403) msg += '（token 权限不够：需要该仓库的 Contents 读写权限）';
    throw new Error(msg);
  }
  return await res.json();
}

async function ghPull(cfg) {
  const file = await ghRequest(cfg, cfg.path, { method: 'GET' });
  if (file.notFound) return { data: null, sha: null };
  const json = JSON.parse(decodeURIComponent(escape(atob(String(file.content || '').replace(/\n/g, '')))));
  return { data: json, sha: file.sha };
}

async function ghPush(cfg, data, sha) {
  const text = JSON.stringify(data);
  if (text.length > 900 * 1024) {
    throw new Error('数据超过 900KB，GitHub 单文件接口放不下（需要精简剧情或换方案）');
  }
  const body = {
    message: `novel sync ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(text))),
    ...(sha ? { sha } : {})
  };
  const res = await ghRequest(cfg, cfg.path, { method: 'PUT', body: JSON.stringify(body) });
  return res?.content?.sha || null;
}

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
  // 地址失效（比如旧的穿透地址）时不能让整个页面一直等，最多 2.5 秒
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${base}/api/health`, { headers: headers(), cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      lastProbeReason = res.status === 403 ? '口令不对' : `HTTP ${res.status}`;
      return null;
    }
    const data = await res.json();
    if (!data?.ok) { lastProbeReason = '返回异常'; return null; }
    return data;
  } catch (err) {
    // 跨域被拦、DNS 失败、证书问题都会走到这里
    lastProbeReason = err?.name === 'AbortError' ? '连接超时' : (err?.message || '网络错误');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 启动时判断走哪条路：同源服务 → 配置的远端服务 → 纯本地 */
export async function initSync() {
  const cfg = syncConfig.read();
  // 选了 GitHub 私有仓库：直接走它，不需要电脑开着
  if (cfg.backend === 'github' && cfg.gh?.owner && cfg.gh?.repo && cfg.gh?.path && cfg.gh?.token) {
    try {
      await ghPull(cfg.gh);
      state.available = true;
      state.kind = 'github';
      state.base = `github:${cfg.gh.owner}/${cfg.gh.repo}`;
      state.error = '';
      return true;
    } catch (err) {
      state.error = `GitHub 同步不可用：${err.message}`;
      state.available = false;
      state.kind = 'local';
      return false;
    }
  }
  const same = await probe('');
  if (same?.sync) {
    state.available = true;
    state.kind = 'server';
    state.base = '';
    return true;
  }
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
  if (state.kind === 'github') {
    const { data } = await ghPull(syncConfig.read().gh);
    state.lastSync = Date.now();
    state.error = '';
    if (!data) return { sessions: [], deleted: [], updatedAt: 0, meta: {} };
    state.count = (data.sessions || []).length;
    return {
      sessions: data.sessions || [],
      deleted: data.deleted || [],
      updatedAt: data.updatedAt || 0,
      meta: data.meta || {}
    };
  }
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

export async function push({ sessions = [], deleted = [], meta = {} }) {
  if (!state.available) throw new Error('没有可用的同步服务');
  if (state.kind === 'github') {
    const cfg = syncConfig.read().gh;
    // GitHub 没有服务端帮我合并：先读回来，在本地合并（并集 + 删除墓碑），再写回去
    const cur = await ghPull(cfg);
    const remote = cur.data || { sessions: [], deleted: [], updatedAt: 0 };
    const merged = mergeSessions(
      [...(remote.sessions || []), ...sessions],
      [],
      [...(remote.deleted || []), ...deleted.map((id) => ({ id, at: Date.now() }))]
    );
    // meta 放不随剧情变的东西（文风样例等），空值不覆盖远端已有的
    const cleanMeta = {};
    for (const [k, v] of Object.entries(meta || {})) {
      if (v !== undefined && v !== null && v !== '') cleanMeta[k] = v;
    }
    const nextMeta = { ...(remote.meta || {}), ...cleanMeta };
    const next = {
      updatedAt: Date.now(),
      sessions: merged,
      deleted: dedupeTombstones([...(remote.deleted || []), ...deleted.map((id) => ({ id, at: Date.now() }))]),
      meta: nextMeta
    };
    const sha = await ghPush(cfg, next, cur.sha);
    state.lastSha = sha;
    state.lastSync = Date.now();
    state.error = '';
    state.count = next.sessions.length;
    // 回传合并后的结果，让调用方（flushPush）能拿它更新本机，和服务器模式行为一致
    return {
      ok: true,
      updatedAt: next.updatedAt,
      count: next.sessions.length,
      sessions: next.sessions,
      deleted: next.deleted,
      meta: nextMeta
    };
  }
  const res = await fetch(`${state.base}/api/store`, {
    method: 'POST',
    headers: headers(),
    // echo: 让服务器把"合并后的完整结果"回传 —— 否则本机可能一直缺着别端的轮次
    body: JSON.stringify({ sessions, deleted, meta, echo: true })
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

function dedupeTombstones(list) {
  const map = new Map();
  for (const d of list || []) {
    if (!d || !d.id) continue;
    const prev = map.get(d.id) || 0;
    map.set(d.id, Math.max(prev, d.at || 0));
  }
  return Array.from(map.entries()).map(([id, at]) => ({ id, at })).slice(-200);
}

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
/** 应用"删除墓碑"：被删过的剧情不会因为另一端还留着就复活 */
export function applyTombstones(sessions, tombstoned) {
  if (!Array.isArray(tombstoned) || !tombstoned.length) return sessions || [];
  const tomb = new Map(tombstoned.map((d) => [d.id, d.at || 0]));
  return (sessions || []).filter((s) => {
    const at = tomb.get(s?.id);
    return !(at && (s.updatedAt || 0) <= at);
  });
}

export function mergeSessions(local, remote, tombstoned) {
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
  const out = applyTombstones(Array.from(map.values()), tombstoned).map((s) => {
    if (!localCursor.has(s.id) || !Array.isArray(s.rounds) || !s.rounds.length) return s;
    const want = localCursor.get(s.id);
    if (!Number.isFinite(want)) return s;
    return { ...s, cursor: Math.max(0, Math.min(want, s.rounds.length - 1)) };
  });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
