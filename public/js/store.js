/**
 * store.js — 会话与设置的本地持久化
 */

const KEY_SESSIONS = 'novel.sessions.v1';
const KEY_ACTIVE = 'novel.active.v1';
const KEY_PREFS = 'novel.prefs.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[novel] 本地存储写入失败', err);
    return false;
  }
}

export const store = {
  listSessions() {
    return read(KEY_SESSIONS, []);
  },
  saveSession(session) {
    const list = this.listSessions();
    const i = list.findIndex((s) => s.id === session.id);
    session.updatedAt = Date.now();
    if (i >= 0) list[i] = session;
    else list.unshift(session);
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    write(KEY_SESSIONS, list.slice(0, 60));
    return session;
  },
  removeSession(id) {
    write(KEY_SESSIONS, this.listSessions().filter((s) => s.id !== id));
    if (this.activeId() === id) this.setActiveId(null);
  },
  getSession(id) {
    return this.listSessions().find((s) => s.id === id) || null;
  },
  activeId() {
    return read(KEY_ACTIVE, null);
  },
  setActiveId(id) {
    write(KEY_ACTIVE, id);
  },
  prefs() {
    return read(KEY_PREFS, { showEmotionBars: true, fontSize: 'normal', engine: 'auto' });
  },
  savePrefs(patch) {
    const next = { ...this.prefs(), ...patch };
    write(KEY_PREFS, next);
    return next;
  },
  exportAll() {
    return {
      app: 'novel',
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: this.listSessions()
    };
  },
  importAll(payload) {
    const incoming = Array.isArray(payload) ? payload : payload?.sessions;
    if (!Array.isArray(incoming)) throw new Error('文件格式不正确');
    const list = this.listSessions();
    let added = 0;
    for (const s of incoming) {
      if (!s || !s.id || !s.setup || !Array.isArray(s.rounds)) continue;
      const i = list.findIndex((x) => x.id === s.id);
      if (i >= 0) list[i] = s;
      else { list.unshift(s); added += 1; }
    }
    write(KEY_SESSIONS, list);
    return { added, total: list.length };
  },
  replaceAll(sessions) {
    write(KEY_SESSIONS, Array.isArray(sessions) ? sessions : []);
  }
};

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function newSession(setup) {
  return {
    id: uid(),
    title: setup.title || setup.scenario?.slice(0, 18) || '未命名剧情',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    setup,
    rounds: [],
    branches: [],
    cursor: -1,
    pendingAction: ''
  };
}
