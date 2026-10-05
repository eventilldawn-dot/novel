/**
 * app.js — 控制器：串起设定页、对话流、回退分支、面板与设置
 */

import {
  TEMPLATES, EMOTION_PRESETS, LENGTH_PRESETS, TONE_PRESETS, POV_PRESETS,
  PANEL_LIBRARY, makePanel, cloneTemplate, suggestSetupLocal,
  MODE_PRESETS, MODE_ORDER, INTENSITY_MODE_MAP
  , ORIENTATION_PRESETS, ORIENTATION_ORDER, modeForRatio, ratioLabel
} from './presets.js';
import { store, newSession } from './store.js';
import * as syncApi from './sync.js';
import {
  SHEET_SCHEMA, CAST_FIELDS, MAX_CAST, emptySheet, emptyCastCard,
  normalizeSheet, sheetToSetupParts, sheetIsEmpty, sheetOnlyHasIdea
} from './sheet.js';
import { looksGarbled, modeOf, fleshRatioOf } from './prompt.js';
import {
  generateRound, server, designSetup, testConnection,
  localConfig, PROVIDERS, probeServer, resolveTransport, designSheet, generatePanels,
  discoverLocalServer, exportFromServer
} from './api.js';
import * as ui from './ui.js';

const $ = ui.$;
const $$ = ui.$$;
const esc = ui.esc;

/** 线上版地址：电脑关机也能打开，配合 GitHub 私有仓库同步使用 */
const ONLINE_BASE = 'https://eventilldawn-dot.github.io/novel/';

const INTENSITY = [
  { label: '全年龄', text: '全年龄向，只写情感、张力与氛围，不涉及性描写。' },
  { label: '文学化克制', text: '成人向的文学化描写，重心理与氛围，避免直白的器官词与粗俗表达。' },
  { label: '感官细腻', text: '成人向，允许具体而感官化的身体描写，保持文学质感，不做医学式罗列。' },
  { label: '直白强烈', text: '成人向，允许直白描写与强烈张力，语言可以粗粝；不涉及未成年、真实人物与非自愿的鼓励。' }
  , { label: '无限制', text: '本作是成年向的虚构创作，面向成年读者。性爱场面按剧情需要直接、完整地写：动作、体感、身体反应与对话都写出来；角色该说的粗俗话照说，尺度不设上限。' }
];

/** 默认写作指令：设定页里可以随便改，会以最高优先级写进提示词 */
const DEFAULT_CUSTOM_PROMPT = `1. 严格记住人设与世界观设定，不要遗忘、混淆、擅自更改或添加。
2. 回复中以「你」指代玩家扮演的角色；注意上下文衔接，不要混淆主语。
3. 使用第三人称视角写长段落，同时描写环境、当前角色的动态与其他角色的反应。
4. 但凡写了动作描写，都必须单独换行。
5. 允许主动推进剧情，但不要过度跳跃时间线。
6. 减少血液、流泪这类描写。
7. 在保留动作与语言描写的基础上，增加环境描写。
8. 用词要直接：写性爱场面时该用什么词就用什么词 —— 鸡巴、龟头、精液、射、操、干、骚、穴 这类词不要避开。**禁止用「那里」「下面」「那个地方」「私处」「某处」「花心」「甬道」来代指器官**，禁止用省略号、破折号、"此处省略"把关键动作跳过去；角色该说的粗话照说。
9. 不要引入与当前场景无关的物品、比喻或象征，不要凭空出现此前没提过的东西。
10. 专注写「当下短时间内」发生的事，每次回复话题专一，不要跳脱。
11. 心理描写不要重复已经说过的内容。`;

const state = {
  session: null,
  generating: false,
  abort: null,
  activePanel: null,
  prefs: store.prefs(),
  health: { engine: 'local' },
  serverCfg: {},
  bannerDismissed: false,
  lastFailure: null,
  stick: true,          // 是否"粘"在底部：用户在往上翻的时候不要把他拽回去
  sync: { available: false, kind: 'local', base: '', busy: false, lastSync: 0, error: '', count: 0 }
};

let draft = null; // 设定页草稿

/* =========================================================
   启动
   ========================================================= */

async function boot() {
  // 一次性配置链接（#setup=...）：手机端第一次打开时，把 Key 和同步配置一起带过来
  applyBootstrapLink();
  // 用带令牌的地址打开时（例如内网穿透的公网地址 ?token=xxx），先把它记下来
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) syncApi.syncConfig.write({ token: urlToken.trim() });
  registerServiceWorker();
  bindGlobal();
  bindSetup();

  state.health = await server.health();
  const cfg = await server.getConfig();
  state.serverCfg = cfg.config || {};
  if (state.serverCfg.styleSample) localConfig.write({ styleSample: state.serverCfg.styleSample });
  if (state.serverCfg.defaultMode) localConfig.write({ defaultMode: state.serverCfg.defaultMode });
  if (state.serverCfg.defaultOrientation) localConfig.write({ defaultOrientation: state.serverCfg.defaultOrientation });
  // 服务端如果配好了 GitHub 私有仓库同步，就自动替用户填上（用户没手动改过同步方式时）
  if (applyServerGhSync()) updateSyncUI();
  // 在线上版页面上打开、但这台电脑上正好跑着 server.js：直接把配置接过来
  if (!state.health?.ok) {
    if (await adoptLocalServer()) updateSyncUI();
  }

  await bootSync();
  renderSessionList();

  const activeId = store.activeId();
  const session = activeId ? store.getSession(activeId) : null;
  if (session) {
    enterSession(session);
  } else {
    showEmptyState();
  }
  updateEngineBadge();
  refreshEngineBanner();
}

/** 解析 #setup=<base64url(JSON)>，写进本机配置后把地址栏里的这段抹掉 */
function applyBootstrapLink() {
  const hash = String(location.hash || '');
  if (!hash.startsWith('#setup=')) return false;
  let data = null;
  try {
    const b64 = hash.slice('#setup='.length).replace(/-/g, '+').replace(/_/g, '/');
    data = JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch { return false; }
  if (!data || typeof data !== 'object') return false;

  const patch = {};
  for (const k of [
    'apiKey', 'baseUrl', 'model', 'maxTokens', 'temperature',
    'reasoningEffort', 'styleSample', 'defaultMode', 'defaultOrientation'
  ]) {
    if (data[k] !== undefined && data[k] !== '' && data[k] !== null) patch[k] = data[k];
  }
  if (Object.keys(patch).length) localConfig.write(patch);

  const syncPatch = {};
  if (data.token) syncPatch.token = String(data.token);
  if (data.gh?.owner && data.gh?.repo && data.gh?.token) {
    syncPatch.backend = 'github';
    syncPatch.gh = {
      owner: String(data.gh.owner),
      repo: String(data.gh.repo),
      path: String(data.gh.path || 'novel.json'),
      token: String(data.gh.token)
    };
  }
  if (Object.keys(syncPatch).length) syncApi.syncConfig.write(syncPatch);

  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 忽略 */ }
  return true;
}

/**
 * 在线上版页面上打开、但这台电脑上正好跑着 server.js 时，
 * 自动把本机服务的配置（Key、模型、文风样例、GitHub 同步）接过来。
 * 手机上通常找不到（只有本机会命中），找不到就静默跳过。
 */
async function adoptLocalServer() {
  const local = localConfig.read();
  const sc = syncApi.syncConfig.read();
  if (sc.manual) return false;                  // 用户自己选过同步方式，不插手
  if (local.apiKey && sc.gh?.token) return false; // 已经配好了，别重复来一遍

  const found = await discoverLocalServer();
  if (!found) return false;
  const ex = await exportFromServer(found.base);
  if (!ex) return false;

  const patch = {};
  const fill = (key, value, current) => {
    if (current === undefined || current === '' || current === null) {
      if (value !== undefined && value !== '' && value !== null) patch[key] = value;
    }
  };
  fill('apiKey', ex.apiKey, local.apiKey);
  fill('baseUrl', ex.baseUrl, local.baseUrl);
  fill('model', ex.model, local.model);
  fill('styleSample', ex.styleSample, local.styleSample);
  fill('maxTokens', ex.maxTokens, local.maxTokens);
  fill('temperature', ex.temperature, local.temperature);
  fill('reasoningEffort', ex.reasoningEffort, local.reasoningEffort);
  fill('defaultMode', ex.defaultMode, local.defaultMode);
  fill('defaultOrientation', ex.defaultOrientation, local.defaultOrientation);
  if (Object.keys(patch).length) localConfig.write(patch);

  const syncPatch = {};
  if (ex.ghSync?.owner && ex.ghSync?.repo && ex.ghSync?.token) {
    syncPatch.backend = 'github';
    syncPatch.gh = {
      owner: ex.ghSync.owner,
      repo: ex.ghSync.repo,
      path: ex.ghSync.path || 'novel.json',
      token: ex.ghSync.token
    };
  }
  if (ex.syncToken) syncPatch.token = ex.syncToken;
  if (Object.keys(syncPatch).length) syncApi.syncConfig.write(syncPatch);

  state.serverCfg = { ...state.serverCfg, ...ex };
  ui.toast('已连上这台电脑上的 Novel 服务，Key 和同步都配好了。');
  return true;
}

/**
 * 把当前这台设备上的配置（Key、模型、文风样例、GitHub 同步）打包成线上版链接。
 * 电脑上的 Key 存在服务端，所以优先向本机服务要一份完整配置。
 */
async function buildBootstrapLink(form = {}) {
  const local = localConfig.read();
  const sc = syncApi.syncConfig.read();
  let src = {};
  try {
    const srv = await probeServer();
    if (srv?.up) {
      const ex = await server.exportConfig();
      if (ex?.ok) src = ex;
    }
  } catch { /* 线上版没有本机服务，就用表单里的值 */ }

  const gh = (src.ghSync?.owner && src.ghSync?.token) ? src.ghSync : (sc.gh || {});
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? '';
  const payload = {
    apiKey: pick(form.key, src.apiKey, local.apiKey),
    baseUrl: pick(form.baseUrl, src.baseUrl, local.baseUrl),
    model: pick(form.model, src.model, local.model),
    temperature: Number(pick(form.temperature, src.temperature, local.temperature, 0.9)),
    maxTokens: Number(pick(form.maxTokens, src.maxTokens, local.maxTokens, 12000)),
    reasoningEffort: pick(form.reasoningEffort, src.reasoningEffort, local.reasoningEffort, 'default'),
    styleSample: pick(form.styleSample, src.styleSample, local.styleSample),
    defaultMode: pick(form.defaultMode, src.defaultMode, local.defaultMode, 'balanced'),
    defaultOrientation: pick(form.defaultOrientation, src.defaultOrientation, local.defaultOrientation, 'mm'),
    token: pick(src.syncToken, sc.token)
  };
  if (gh?.owner && gh?.repo && gh?.token) {
    payload.gh = {
      owner: gh.owner, repo: gh.repo, path: gh.path || 'novel.json', token: gh.token
    };
  }
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${ONLINE_BASE}#setup=${b64}`;
}

/** 复制到剪贴板，手机 / 老浏览器不支持时退回手选 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 继续用后备方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 把服务端下发的 GitHub 同步配置写进本机浏览器。
 * 只要用户在设置里手动选过同步方式（manual），就不再覆盖他的选择。
 * 返回 true 表示这次改动过配置。
 */
function applyServerGhSync() {
  const gh = state.serverCfg?.ghSync;
  if (!gh?.owner || !gh?.repo || !gh?.token) return false;
  const cur = syncApi.syncConfig.read();
  if (cur.manual) return false;
  const path = gh.path || 'novel.json';
  if (
    cur.backend === 'github' &&
    cur.gh?.owner === gh.owner &&
    cur.gh?.repo === gh.repo &&
    cur.gh?.path === path &&
    cur.gh?.token === gh.token
  ) {
    return false;
  }
  syncApi.syncConfig.write({
    backend: 'github',
    gh: { owner: gh.owner, repo: gh.repo, path, token: gh.token }
  });
  return true;
}

/** 注册 Service Worker：让这个网址在电脑没开机时也能打开（离线可用） */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    // 每次打开顺手检查一次更新，但不要打断当前使用
    reg.update?.().catch(() => {});
  }).catch(() => { /* http 局域网地址不支持，忽略即可 */ });
}

/* ---------------- 跨设备同步 ---------------- */

const pushQueue = { sessions: new Map(), deleted: new Set(), timer: null };

function updateSyncUI() {
  const s = syncApi.syncState();
  state.sync = { ...state.sync, ...s };
  ui.renderSyncStatus({
    kind: s.kind,
    error: s.error,
    busy: s.busy,
    count: s.count,
    serverUrl: s.kind === 'remote' ? s.serverUrl : (location.origin + ' 的服务')
  });
}

function queuePush(session) {
  if (!state.sync.available) return;
  pushQueue.sessions.set(session.id, session);
  schedulePush();
}

function queueDelete(id) {
  if (!state.sync.available) return;
  pushQueue.deleted.add(id);
  pushQueue.sessions.delete(id);
  schedulePush();
}

/** 跟着同步走的小配置（目前只有文风样例），让几台设备的文风保持一致 */
function syncMeta() {
  const styleSample = localConfig.read().styleSample;
  return styleSample ? { styleSample } : {};
}

/** 本机还没填文风样例时，用同步下来的那份填上 */
function applySyncMeta(meta) {
  if (!meta || typeof meta !== 'object' || !meta.styleSample) return;
  if (localConfig.read().styleSample) return;
  localConfig.write({ styleSample: meta.styleSample });
  state.serverCfg = { ...state.serverCfg, styleSample: meta.styleSample };
}

function schedulePush() {
  clearTimeout(pushQueue.timer);
  pushQueue.timer = setTimeout(flushPush, 800);
}

async function flushPush() {
  if (!state.sync.available) return;
  if (!pushQueue.sessions.size && !pushQueue.deleted.size) return;
  const payload = { sessions: Array.from(pushQueue.sessions.values()), deleted: Array.from(pushQueue.deleted) };
  payload.meta = syncMeta();
  pushQueue.sessions.clear();
  pushQueue.deleted.clear();
  state.sync.busy = true;
  updateSyncUI();
  try {
    const res = await syncApi.push(payload);
    applySyncMeta(res?.meta);
    // 服务器会把合并后的完整数据回传 —— 用它更新本机，避免本机缺着别端的轮次
    if (Array.isArray(res?.sessions) && res.sessions.length) {
      const merged = syncApi.mergeSessions(store.listSessions(), res.sessions, res.deleted || []);
      if (!store.replaceAll(merged)) syncApi.markError('本机浏览器存储已满，已用服务端数据覆盖');
      renderSessionList();
      if (state.session) {
        const fresh = merged.find((x) => x.id === state.session.id);
        if (fresh && (fresh.rounds?.length || 0) !== (state.session.rounds?.length || 0)) {
          state.session = fresh;
          ui.renderRounds(state.session, { futureCount: state.session.rounds.length - 1 - state.session.cursor });
          ui.renderHUD(state.session);
          ui.renderRoundNav(state.session);
          ui.toast(`已同步到最新：${fresh.rounds.length} 轮`);
        } else if (fresh) {
          state.session = fresh;
        }
      }
    }
    syncApi.clearError();
  } catch (err) {
    syncApi.markError(err.message);
  } finally {
    state.sync.busy = false;
    updateSyncUI();
  }
}

/** 生成过程中别强行把用户拽到底部 —— 只有他自己停在底部时才跟随 */
function followScroll(instant) {
  const stage = $('#stage');
  if (stage) stage.dataset.stick = String(state.stick);
  if (state.stick) {
    ui.scrollToBottom(!instant);
    ui.setJumpButton(false);
  } else {
    ui.setJumpButton(true);
  }
}

async function bootSync() {
  const ok = await syncApi.initSync();
  updateSyncUI();
  if (!ok) return;

  state.sync.busy = true;
  updateSyncUI();
  try {
    // 先问版本号：服务器没变过就不下载整份数据（手机上打开会快很多）
    const v = await syncApi.version();
    if (v && syncApi.lastVersion.get() === String(v.updatedAt) && store.listSessions().length) {
      state.sync.count = v.count || state.sync.count;
      syncApi.clearError();
      return;
    }
    const remote = await syncApi.pull();
    applySyncMeta(remote?.meta);
    const merged = syncApi.mergeSessions(store.listSessions(), remote.sessions || [], remote.deleted || []);
    store.replaceAll(merged);
    // 把本机独有的（比如之前在浏览器里写的）补推上去
    const up = await syncApi.push({ sessions: merged, deleted: [], meta: syncMeta() });
    applySyncMeta(up?.meta);
    syncApi.clearError();
  } catch (err) {
    syncApi.markError(err.message);
  } finally {
    state.sync.busy = false;
    updateSyncUI();
  }
}

async function runFullSync() {
  if (!state.sync.available) {
    ui.toast('没有可用的同步服务：启动电脑上的 server.js，或用局域网地址打开。', 'warn');
    return;
  }
  state.sync.busy = true;
  updateSyncUI();
  try {
    const remote = await syncApi.pull();
    applySyncMeta(remote?.meta);
    const merged = syncApi.mergeSessions(store.listSessions(), remote.sessions || [], remote.deleted || []);
    store.replaceAll(merged);
    const up = await syncApi.push({ sessions: merged, deleted: [], meta: syncMeta() });
    applySyncMeta(up?.meta);
    syncApi.clearError();
    renderSessionList();
    if (state.session) {
      const fresh = merged.find((s) => s.id === state.session.id);
      if (fresh) {
        state.session = fresh;
        ui.renderRounds(state.session, { futureCount: state.session.rounds.length - 1 - state.session.cursor });
        ui.renderHUD(state.session);
        ui.renderRoundNav(state.session);
      }
    }
    ui.toast(`同步完成，共 ${merged.length} 部剧情。`);
  } catch (err) {
    syncApi.markError(err.message);
    ui.toast(`同步失败：${err.message}`, 'warn');
  } finally {
    state.sync.busy = false;
    updateSyncUI();
  }
}

function updateEngineBadge() {
  const note = $('#setup-note');
  if (!note) return;
  const local = localConfig.read();
  const ok = state.serverCfg.hasKey || Boolean(local.apiKey);
  const model = state.serverCfg.hasKey ? state.serverCfg.model : (local.model || 'deepseek-chat');
  const base = state.serverCfg.hasKey ? state.serverCfg.baseUrl : (local.baseUrl || 'https://api.deepseek.com/v1');
  note.innerHTML = ok
    ? `<b>导演引擎：</b>已连接 <b>${esc(model)}</b>（${esc(base)}）。剧情与界面按钮都由真实模型生成。`
    : `<b>导演引擎：</b>还没有 API Key，当前使用<b>本地示例引擎</b>——能跑通全部交互，但文字会偏模板、偏生硬。点右上角 ⚙ 填入 DeepSeek 的 Key（默认已按 DeepSeek 配好）即可切换成真实模型。`;
}

/** 顶部状态横幅：告诉用户现在到底在用哪个引擎 */
async function refreshEngineBanner(force) {
  if (state.bannerDismissed && !force) return;
  if (state.lastFailure) {
    const actions = state.failureRetry
      ? [{ label: '重试', key: 'retry' }, { label: '去设置', key: 'settings' }]
      : [{ label: '去设置', key: 'settings' }];
    ui.renderEngineBanner({
      kind: 'error',
      text: state.lastFailure,
      actions
    });
    return;
  }
  const srv = await probeServer();
  if (srv.needToken) {
    ui.renderEngineBanner({
      kind: 'error',
      text: '这个地址需要访问口令。请用带 ?token=… 的完整地址打开（启动 server.js 时终端会打印），或直接在设置里填入口令。',
      action: '去设置'
    });
    return;
  }
  const t = await resolveTransport();
  if (t.kind === 'none') {
    ui.renderEngineBanner({
      kind: 'warn',
      text: '当前是本地示例引擎（未配置 API Key），文字会比较生硬。接上 DeepSeek 后同一套剧情立刻变得自然。',
      actions: [{ label: '去设置', key: 'settings' }]
    });
  } else {
    ui.renderEngineBanner(null);
  }
}

function renderSessionList() {
  ui.renderSessionList(store.listSessions(), state.session?.id || null);
}

/** 存到本机 + 排队推到服务器 */
function persist(session, opts = {}) {
  const ok = store.saveSession(session, opts);
  if (!ok) {
    ui.toast('本机浏览器存不下了（localStorage 已满）。数据仍会同步到电脑上；建议到「⇅ 数据」导出备份，再删掉几部旧剧情。', 'warn');
  }
  queuePush(session);
}

/* ---- 面板内容后台生成：正文先给玩家看，面板随后补上 ---- */
const panelJobs = new Map();     // "sessionId:轮次" → 'pending' | 'failed'
const panelKey = (s, i) => `${s.id}:${i}`;

function panelState(session, index) {
  if (!session || index < 0) return null;
  return panelJobs.get(panelKey(session, index)) || null;
}

async function fillPanelsInBackground(session, index) {
  const round = session.rounds[index];
  if (!round) return;
  // 只更新"到点该更新"的面板：实时类每轮更新，其余每 4 轮更新一次
  const due = duePanels(session, index);
  if (!due.length) return;
  const key = panelKey(session, index);
  panelJobs.set(key, 'pending');
  if (state.session?.id === session.id && state.session.cursor === index && state.activePanel) {
    const def = currentPanelDefs().find((p) => p.id === state.activePanel);
    if (def) ui.openDrawer(def, round.panels?.[def.id], { pending: true });
  }
  try {
    const panels = await generatePanels({ session, cursor: index, panels: due });
    round.panels = { ...(round.panels || {}), ...panels };
    for (const def of due) def.lastAt = index;
    panelJobs.delete(key);
    persist(session);
  } catch (err) {
    panelJobs.set(key, 'failed');
    if (state.session?.id === session.id && state.session.cursor === index && state.activePanel) {
      const def = currentPanelDefs().find((p) => p.id === state.activePanel);
      if (def) ui.openDrawer(def, null, { failed: true });
    }
    return;
  }
  // 面板回来了：如果正开着，立刻刷新
  if (state.session?.id === session.id && state.session.cursor === index && state.activePanel) {
    const def = currentPanelDefs().find((p) => p.id === state.activePanel);
    if (def) ui.openDrawer(def, round.panels[def.id]);
  }
}

/** 哪些面板这一轮该更新了 */
function duePanels(session, index) {
  const defs = [...(session.setup.topPanels || []), ...(session.setup.bottomPanels || [])];
  return defs.filter((def) => {
    if (def.freq === 'each') return true;                 // 弹幕这类：每轮都更新
    const last = Number.isFinite(def.lastAt) ? def.lastAt : -99;
    return index - last >= 4;                             // 其余：每 4 轮更新一次
  });
}

function dropSession(id) {
  store.removeSession(id);
  queueDelete(id);
}

function showEmptyState() {
  state.session = null;
  $('#rounds').innerHTML = `<div class="empty-state">
    <h2>还没有开始的故事</h2>
    <p>写下人设与剧情指令，导演引擎会立刻为这一幕开场。<br>每一轮结束都会给出三个走向，交给屏幕前的你决定。</p>
    <button class="primary-btn" style="max-width:260px;margin:0 auto" id="empty-start">创建新剧情 →</button>
  </div>`;
  $('#round-nav').hidden = true;
  $('#bottombar').innerHTML = '';
  $('#bottombar').classList.add('empty');
  $('#act-name').textContent = '尚未开始';
  $('#act-meta').textContent = '';
  $('#emotion-strip').innerHTML = '';
  $('#title-text').textContent = 'Novel';
  $('#top-actions').innerHTML = '';
  $('#empty-start')?.addEventListener('click', () => openSetup());
}

function enterSession(session) {
  state.session = session;
  // 老剧情没有写作指令，补一份默认的（可以在 ✍ 写作 里改）
  if (!session.setup.customPrompt) {
    session.setup.customPrompt = DEFAULT_CUSTOM_PROMPT;
    persist(session);
  }
  // 旧版「无限制」文案里有"不要自我审查"这类元指令，反而会让模型保守 —— 一律升级成新版
  if (/不要自我审查|不要回避、不要用暗示代替/.test(session.setup.intensity || '')) {
    const newer = INTENSITY.find((i) => i.label === '无限制');
    if (newer && session.setup.intensity !== newer.text) {
      session.setup.intensity = newer.text;
      persist(session);
    }
  }
  // 老版写作指令里只有抽象的"无需避讳违禁词"，模型听不懂 —— 升级成点名版
  const oldLine = '8. 无需避讳违禁词；涉及性爱场面时详细描写，允许描写性器官，允许符合人设的粗俗语。';
  if ((session.setup.customPrompt || '').includes(oldLine)) {
    session.setup.customPrompt = session.setup.customPrompt.replace(oldLine, DEFAULT_CUSTOM_PROMPT.split('\n')[7]);
    persist(session);
  }
  store.setActiveId(session.id);
  $('#screen-setup').classList.remove('open');
  $('#title-icon').textContent = session.setup.emoji || '✦';
  $('#title-text').textContent = session.title;
  ui.renderTopActions(session.setup, state.activePanel);
  ui.renderBottombar(session.setup, state.activePanel);
  ui.renderRounds(session, { futureCount: session.rounds.length - 1 - session.cursor });
  ui.renderHUD(session);
  ui.renderRoundNav(session);
  ui.closeDrawer();
  renderSessionList();
  refreshEngineBanner();
  state.stick = true;
  ui.setJumpButton(false);
  requestAnimationFrame(() => ui.scrollToBottom(false));
}

/* =========================================================
   设定页
   ========================================================= */

function blankSetup() {
  const t = cloneTemplate(TEMPLATES[TEMPLATES.length - 1]);
  const prefs = localConfig.read();
  const defaultMode = prefs.defaultMode || 'balanced';
  const defaultOrientation = prefs.defaultOrientation || 'mm';
  return {
    templateId: t.id,
    emoji: t.emoji,
    title: '',
    scenario: t.scenario,
    userRole: t.userRole,
    targetRole: t.targetRole,
    opening: t.opening,
    tone: t.tone,
    pov: t.pov,
    lengthKey: 'medium',
    emotions: [...t.emotions],
    intensity: MODE_PRESETS[defaultMode].intensity,
    mode: defaultMode,
    orientation: defaultOrientation,
    customPrompt: DEFAULT_CUSTOM_PROMPT,
    idea: '',
    sheet: emptySheet(),
    autoDesign: true,
    topPanels: t.topPanels.map((p) => ({ ...p })),
    bottomPanels: t.bottomPanels.map((p) => ({ ...p }))
  };
}

/* ---------------- 让导演按剧情设计界面 ---------------- */

function scenarioSignature() {
  const s = [draft.scenario, draft.userRole, draft.targetRole, draft.opening, draft.tone, draft.intensity].join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String(h >>> 0);
}

function applyDesign(design) {
  if (!design) return;
  if (design.title && !draft.title.trim()) draft.title = design.title;
  if (design.emotions?.length) draft.emotions = design.emotions;
  if (design.topPanels?.length) draft.topPanels = design.topPanels.map((p) => makePanel(p));
  if (design.bottomPanels?.length) draft.bottomPanels = design.bottomPanels.map((p) => makePanel(p));
  draft.designSignature = scenarioSignature();
  fillForm();
  renderEmotionPresets();
}

async function runAutoDesign({ silent } = {}) {
  readForm();
  const btn = $('#btn-autodesign');
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '正在读剧情…'; }
  try {
    const template = TEMPLATES.find((x) => x.id === draft.templateId) || TEMPLATES[0];
    const res = await designSetup({
      draft: { ...draft, templateName: template.name },
      localFallback: () => suggestSetupLocal(draft)
    });
    applyDesign(res.design);
    if (res.ok) ui.toast('已按剧情重新配置顶部 / 底部按钮与情感指标。');
    else if (!silent) ui.toast(`没接上模型（${res.error}），先用剧情关键词匹配的配置。`, 'warn');
    return res;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/* ---------------- 人设工坊 ---------------- */

const SHEET_GROUPS = [
  { key: 'me', title: '二 · 我的角色（玩家扮演）' },
  { key: 'relation', title: '四 · 这几个角色与我的总体关系' },
  { key: 'world', title: '五 · 世界与剧情' }
];

let builderSheet = null;
let builderOnSave = null;
let builderFromSetup = false;

function finishBuilderSave(sheet) {
  const saved = normalizeSheet(sheet);
  const mode = saved.mode || 'balanced';
  $('#screen-builder').classList.remove('open');
  if (builderOnSave) builderOnSave(saved, mode);
  else if (draft) {
    draft.sheet = saved;
    draft.mode = mode;
    draft.orientation = saved.orientation || 'mm';
    draft.intensity = MODE_PRESETS[mode]?.intensity || draft.intensity;
    applySheetToDraft();
  }
  if (builderFromSetup) $('#screen-setup').classList.add('open');
  ui.toast(`角色卡已回填（${saved.cast.length} 个核心角色 · 尺度 ${MODE_PRESETS[mode]?.name || mode}）。`);
}

function openBuilder({ sheet, onSave, fromSetup, mode }) {
  builderSheet = normalizeSheet(sheet || emptySheet());
  if (mode) builderSheet.mode = mode;
  builderOnSave = onSave || null;
  builderFromSetup = Boolean(fromSetup);
  renderBuilder();
  $('#builder-note').innerHTML = '把想到的填进去就行，空着的交给 <b>✨ AI 补全</b>。字段写得越具体，模型越不会自己编细节、越不容易跑偏。';
  $('#screen-builder').classList.add('open');
  if (builderFromSetup) $('#screen-setup').classList.remove('open');
}

function renderBuilder() {
  const modeBlock = `
    <div class="sheet-group sheet-mode">
      <span class="sheet-group-title">〇 · 取向与尺度（先定这两个）</span>
      <div class="chip-row" id="bld-orientation" style="margin-bottom:10px">
        ${ORIENTATION_ORDER.map((k) => `<button class="chip${(builderSheet.orientation || 'mm') === k ? ' active' : ''}" data-bo="${k}">${ORIENTATION_PRESETS[k].icon} ${esc(ORIENTATION_PRESETS[k].name)}</button>`).join('')}
      </div>
      <div class="chip-row" id="bld-mode">
        ${MODE_ORDER.map((k) => `<button class="chip${(builderSheet.mode || 'balanced') === k ? ' active' : ''}" data-bm="${k}">${MODE_PRESETS[k].icon} ${esc(MODE_PRESETS[k].name)}</button>`).join('')}
      </div>
      <div class="field-tip" id="bld-mode-desc">${esc(MODE_PRESETS[builderSheet.mode || 'balanced'].desc)}<br>
        <b>这一档会同时决定「AI 补全时敢不敢写」和「开演后的写法」。</b>选「直球」，人设卡里涉及性的部分就不会被回避掉。</div>
    </div>`;
  const ideaBlock = `
    <div class="sheet-group sheet-idea">
      <span class="sheet-group-title">一 · 总设定（写了这个就够了）</span>
      <div class="sheet-row">
        <textarea rows="7" data-f="idea" placeholder="把大致构想随手指进来，不用有条理：想写什么关系、什么身份、什么氛围、你希望对方是个什么样的人……&#10;例如：民国上海，我是潜伏在巡捕房的翻译，对方是常来百乐门的日本商人，我要从他嘴里套出运军火的时间表。两个人都在试探，谁先松口谁就输。">${esc(builderSheet.idea || '')}</textarea>
      </div>
      <div class="field-tip">写完点右上角 <b>✨ AI 补全</b>，它会自动拆到下面每一个字段里。下面是几个角色的卡 —— <b>人数由剧情决定</b>：只有一个主角和一个对手戏就留一张，要攻略好几个人就点「＋ 再加一个核心角色」。</div>
    </div>`;
  const castCards = builderSheet.cast.map((card, i) => {
    const fields = CAST_FIELDS.map((f) => `
      <div class="sheet-row">
        <span>${esc(f.label)}</span>
        <textarea rows="${f.rows}" data-f="cast.${i}.${f.key}" placeholder="${esc(f.ph)}">${esc(card[f.key] || '')}</textarea>
      </div>`).join('');
    const canRemove = builderSheet.cast.length > 1;
    return `<div class="sheet-group sheet-cast" data-cast="${i}">
      <span class="sheet-group-title">三 · 核心角色 ${i + 1}${card.name ? '：' + esc(card.name) : '（AI 演的那位）'}
        ${canRemove ? `<button class="cast-del" data-del-cast="${i}" title="删掉这张卡">✕</button>` : ''}
      </span>
      ${fields}
    </div>`;
  }).join('');
  const addCast = builderSheet.cast.length < MAX_CAST
    ? `<button class="add-btn" id="add-cast" style="margin-bottom:26px">＋ 再加一个核心角色</button>`
    : '';
  const opening = `
    <div class="sheet-group">
      <span class="sheet-group-title">六 · 开场</span>
      <div class="sheet-row">
        <span>第一幕从哪一刻开始</span>
        <textarea rows="2" data-f="opening" placeholder="例：百乐门二楼包厢，爵士乐刚换到第二支曲子。">${esc(builderSheet.opening || '')}</textarea>
      </div>
    </div>`;
  // 顺序：尺度 → 总设定 → 我的角色 → 核心角色们 → 总体关系 → 世界 → 开场
  $('#builder-groups').innerHTML = modeBlock + ideaBlock + renderGroup('me') + castCards + addCast + renderGroup('relation') + renderGroup('world') + opening;
}

function renderGroup(key) {
  const g = SHEET_GROUPS.find((x) => x.key === key);
  if (!g) return '';
  const fields = SHEET_SCHEMA[g.key].map((f) => `
    <div class="sheet-row">
      <span>${esc(f.label)}</span>
      <textarea rows="${f.rows}" data-f="${g.key}.${f.key}" placeholder="${esc(f.ph)}">${esc(builderSheet[g.key][f.key] || '')}</textarea>
    </div>`).join('');
  return `<div class="sheet-group" data-group="${g.key}"><span class="sheet-group-title">${esc(g.title)}</span>${fields}</div>`;
}

function readBuilder() {
  $$('#builder-groups [data-f]').forEach((el) => {
    const path = el.dataset.f;
    const v = el.value.trim();
    if (path === 'idea') { builderSheet.idea = v; return; }
    if (path === 'opening') { builderSheet.opening = v; return; }
    const parts = path.split('.');
    if (parts[0] === 'cast') {
      const card = builderSheet.cast[Number(parts[1])];
      if (card) card[parts[2]] = v;
      return;
    }
    if (builderSheet[parts[0]]) builderSheet[parts[0]][parts[1]] = v;
  });
  return builderSheet;
}

function sheetToReadableText(sheet) {
  const s = normalizeSheet(sheet);
  const dump = (fields, group) => fields
    .map((f) => `  ${f.label}：${(group[f.key] || '').trim() || '（空）'}`)
    .join('\n');
  const blocks = [];
  blocks.push(`二 · 我的角色\n${dump(SHEET_SCHEMA.me, s.me)}`);
  s.cast.forEach((card, i) => {
    blocks.push(`三 · 核心角色 ${i + 1}${card.name ? `（${card.name}）` : ''}\n${dump(CAST_FIELDS, card)}`);
  });
  blocks.push(`四 · 总体关系\n${dump(SHEET_SCHEMA.relation, s.relation)}`);
  blocks.push(`五 · 世界与剧情\n${dump(SHEET_SCHEMA.world, s.world)}`);
  blocks.push(`六 · 开场\n  第一幕从哪一刻开始：${(s.opening || '').trim() || '（空）'}`);
  const modeName = MODE_PRESETS[s.mode] ? `${MODE_PRESETS[s.mode].icon} ${MODE_PRESETS[s.mode].name}` : s.mode;
  return `〇 · 尺度档位：${modeName}\n`
    + `${s.idea ? `\n一 · 总设定（玩家的原始构想，请以它为准展开，不要偏离）\n${s.idea}\n` : ''}`
    + `\n${blocks.join('\n\n')}`;
}

async function builderAiFill() {
  readBuilder();
  const btn = $('#builder-ai');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在补全…';
  $('#builder-note').innerHTML = 'AI 正在把你的要点扩写成完整角色卡，大概需要 20~60 秒…';
  try {
    const mode = builderSheet.mode || 'balanced';
    const res = await designSheet({
      rough: sheetToReadableText(builderSheet),
      mode,
      intensity: MODE_PRESETS[mode]?.intensity || '',
      orientation: builderSheet.orientation || 'mm'
    });
    if (res.ok) {
      const keptIdea = builderSheet.idea;      // 总设定与尺度要留着，AI 只负责拆解
      const keptMode = mode;
      const keptOrientation = builderSheet.orientation || 'mm';
      builderSheet = res.sheet;
      builderSheet.idea = keptIdea;
      builderSheet.mode = keptMode;
      builderSheet.orientation = keptOrientation;
      renderBuilder();
      $('#builder-note').innerHTML = '✅ 已补全。可以再手动改，改完点下面保存。';
    } else {
      $('#builder-note').innerHTML = `补全失败：${esc(res.error)}${res.hint ? `<br>建议：${esc(res.hint)}` : ''}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 把角色卡拆开回填到设定页的三个字段 */
function applySheetToDraft() {
  if (!draft) return;
  const parts = sheetToSetupParts(draft.sheet);
  if (parts.userRole) draft.userRole = parts.userRole;
  if (parts.targetRole) draft.targetRole = parts.targetRole;
  if (parts.scenario) draft.scenario = parts.scenario;
  if (parts.opening) draft.opening = parts.opening;
  if (parts.idea) draft.idea = parts.idea;
  fillForm();
}

function openSetup(templateId) {
  draft = blankSetup();
  renderTemplateGrid();
  renderEmotionPresets();
  renderIntensityChips();
  if (templateId) applyTemplate(templateId);
  else fillForm();
  $('#screen-setup').classList.add('open');
  updateEngineBadge();
  $('#chk-autodesign').classList.toggle('active', Boolean(draft.autoDesign));
}

function applyTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  const copy = cloneTemplate(t);
  draft.templateId = copy.id;
  draft.emoji = copy.emoji;
  draft.scenario = copy.scenario;
  draft.userRole = copy.userRole;
  draft.targetRole = copy.targetRole;
  draft.opening = copy.opening;
  draft.tone = copy.tone;
  draft.pov = copy.pov;
  draft.emotions = [...copy.emotions];
  draft.topPanels = copy.topPanels.map((p) => ({ ...p }));
  draft.bottomPanels = copy.bottomPanels.map((p) => ({ ...p }));
  fillForm();
  renderTemplateGrid();
}

function renderTemplateGrid() {
  $('#template-grid').innerHTML = TEMPLATES.map((t) => `
    <button class="template-card${draft.templateId === t.id ? ' active' : ''}" data-template="${t.id}">
      <div class="t-emoji">${t.emoji}</div>
      <div class="t-name">${esc(t.name)}</div>
      <div class="t-desc">${esc(t.desc)}</div>
    </button>`).join('');
}

function renderEmotionPresets() {
  const row = $('#emotion-preset-row');
  const current = draft.emotions.join(',');
  row.innerHTML = Object.entries(EMOTION_PRESETS).map(([key, p]) => `
    <button class="chip${p.list.join(',') === current ? ' active' : ''}" data-emopreset="${key}">${esc(p.name)}</button>
  `).join('') + `<button class="chip" data-emopreset="__clear">清空</button>`;
}

function renderIntensityChips() {
  $('#intensity-row').innerHTML = INTENSITY.map((it) => `
    <button class="chip${draft.intensity === it.text ? ' active' : ''}" data-intensity="${esc(it.label)}">${esc(it.label)}</button>
  `).join('');
}

function fillForm() {
  $('#f-title').value = draft.title || '';
  $('#f-scenario').value = draft.scenario || '';
  $('#f-user').value = draft.userRole || '';
  $('#f-target').value = draft.targetRole || '';
  $('#f-opening').value = draft.opening || '';
  $('#f-tone').innerHTML = TONE_PRESETS.map((t) => `<option${t === draft.tone ? ' selected' : ''}>${esc(t)}</option>`).join('');
  $('#f-pov').innerHTML = POV_PRESETS.map((t) => `<option${t === draft.pov ? ' selected' : ''}>${esc(t)}</option>`).join('');
  $('#f-length').innerHTML = Object.entries(LENGTH_PRESETS).map(([k, v]) => `<option value="${k}"${k === draft.lengthKey ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
  $('#f-emotions').value = draft.emotions.join(', ');
  $('#f-intensity').value = draft.intensity || '';
  $('#f-custom').value = draft.customPrompt || '';
  renderPanelEditor('top');
  renderPanelEditor('bottom');
}

function renderPanelEditor(scope) {
  const list = scope === 'top' ? draft.topPanels : draft.bottomPanels;
  const host = $(scope === 'top' ? '#top-panel-editor' : '#bottom-panel-editor');
  if (!list.length) {
    host.innerHTML = '<div class="drawer-empty" style="padding:6px 2px">还没有按钮，点下方添加。</div>';
    return;
  }
  host.innerHTML = list.map((p, i) => `
    <div class="panel-row" data-scope="${scope}" data-index="${i}">
      <input type="text" value="${esc(p.label)}" data-field="label" placeholder="按钮名称" />
      <select data-field="kind">
        <option value="text"${p.kind === 'text' ? ' selected' : ''}>文字</option>
        <option value="list"${p.kind === 'list' ? ' selected' : ''}>列表</option>
        <option value="kv"${p.kind === 'kv' ? ' selected' : ''}>卡片</option>
        <option value="notes"${p.kind === 'notes' ? ' selected' : ''}>思路</option>
      </select>
      <select data-field="freq" title="更新频率">
        <option value="rare"${p.freq !== 'each' ? ' selected' : ''}>偶尔更新</option>
        <option value="each"${p.freq === 'each' ? ' selected' : ''}>每轮更新</option>
      </select>
      <input type="text" class="hint" value="${esc(p.hint)}" data-field="hint" placeholder="给导演的内容指令" />
      <button class="del" data-del-panel="${i}">✕</button>
    </div>`).join('');
}

function syncPanelDraft() {
  $$('.panel-row').forEach((row) => {
    const scope = row.dataset.scope;
    const i = Number(row.dataset.index);
    const list = scope === 'top' ? draft.topPanels : draft.bottomPanels;
    if (!list[i]) return;
    list[i].label = row.querySelector('[data-field="label"]').value.trim() || list[i].label;
    list[i].kind = row.querySelector('[data-field="kind"]').value;
    list[i].freq = row.querySelector('[data-field="freq"]').value;
    list[i].hint = row.querySelector('[data-field="hint"]').value.trim() || list[i].hint;
  });
}

function readForm() {
  draft.title = $('#f-title').value.trim();
  draft.scenario = $('#f-scenario').value.trim();
  draft.userRole = $('#f-user').value.trim();
  draft.targetRole = $('#f-target').value.trim();
  draft.opening = $('#f-opening').value.trim();
  draft.tone = $('#f-tone').value;
  draft.pov = $('#f-pov').value;
  draft.lengthKey = $('#f-length').value;
  draft.emotions = $('#f-emotions').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  draft.intensity = $('#f-intensity').value.trim();
  draft.customPrompt = $('#f-custom').value.trim();
  syncPanelDraft();
}

function collectSetup() {
  readForm();
  const t = TEMPLATES.find((x) => x.id === draft.templateId) || TEMPLATES[0];
  const title = draft.title
    || (draft.scenario && draft.templateId === 'blank'
      ? draft.scenario.split('\n')[0].replace(/^【[^】]*】/, '').trim().slice(0, 16)
      : t.name);
  return {
    templateId: draft.templateId,
    emoji: draft.emoji,
    title,
    scenario: draft.scenario,
    userRole: draft.userRole,
    targetRole: draft.targetRole,
    opening: draft.opening,
    tone: draft.tone,
    pov: draft.pov,
    lengthHint: (LENGTH_PRESETS[draft.lengthKey] || LENGTH_PRESETS.medium).hint,
    emotions: draft.emotions.length ? draft.emotions : ['好感度', '愉悦度', '羞耻度', '痛苦', '沉溺'],
    intensity: draft.intensity,
    mode: draft.mode || 'balanced',
    orientation: draft.orientation || 'mm',
    customPrompt: draft.customPrompt,
    idea: draft.idea || draft.sheet?.idea || '',
    sheet: draft.sheet,
    topPanels: draft.topPanels.map((p) => makePanel(p)),
    bottomPanels: draft.bottomPanels.map((p) => makePanel(p))
  };
}

function bindSetup() {
  $('#btn-autodesign').addEventListener('click', () => runAutoDesign());
  $('#btn-builder').addEventListener('click', () => {
    readForm();
    openBuilder({
      sheet: draft.sheet,
      fromSetup: true,
      mode: draft.mode || 'balanced',
      onSave: (sheet, mode) => {
        draft.sheet = sheet;
        if (mode) {
          draft.mode = mode;
          draft.intensity = MODE_PRESETS[mode]?.intensity || draft.intensity;
        }
        applySheetToDraft();
      }
    });
  });
  $('#builder-close').addEventListener('click', () => {
    $('#screen-builder').classList.remove('open');
    if (builderFromSetup) $('#screen-setup').classList.add('open');
  });
  $('#builder-ai').addEventListener('click', builderAiFill);
  $('#builder-groups').addEventListener('click', (e) => {
    const oriChip = e.target.closest('[data-bo]');
    if (oriChip) {
      readBuilder();
      builderSheet.orientation = oriChip.dataset.bo;
      renderBuilder();
      return;
    }
    const modeChip = e.target.closest('[data-bm]');
    if (modeChip) {
      readBuilder();
      builderSheet.mode = modeChip.dataset.bm;
      renderBuilder();
      return;
    }
    if (e.target.closest('#add-cast')) {
      readBuilder();
      if (builderSheet.cast.length < MAX_CAST) builderSheet.cast.push(emptyCastCard());
      renderBuilder();
      return;
    }
    const del = e.target.closest('[data-del-cast]');
    if (del) {
      readBuilder();
      builderSheet.cast.splice(Number(del.dataset.delCast), 1);
      if (!builderSheet.cast.length) builderSheet.cast.push(emptyCastCard());
      renderBuilder();
    }
  });
  $('#builder-save').addEventListener('click', () => {
    const sheet = readBuilder();
    if (sheetOnlyHasIdea(sheet)) {
      ui.openModal(`
        <h3>只填了总设定，要先生成完整人设吗？</h3>
        <div class="tip">让 AI 把这段构想拆成完整角色卡（外貌、性格、过往、软肋、关系、世界观），后面的剧情会明显更稳、更少跑偏。</div>
        <div class="row">
          <button class="cancel" data-close-modal>取消</button>
          <button class="cancel" id="b-save-only">直接保存</button>
          <button class="ok" id="b-fill-save">AI 补全并保存</button>
        </div>
      `, (modal) => {
        modal.querySelector('#b-save-only').addEventListener('click', () => {
          ui.closeModal();
          finishBuilderSave(sheet);
        });
        modal.querySelector('#b-fill-save').addEventListener('click', async () => {
          ui.closeModal();
          await builderAiFill();
          const filled = readBuilder();
          if (sheetIsEmpty(filled)) return;      // 补全失败，留在工坊里
          finishBuilderSave(filled);
        });
      });
      return;
    }
    finishBuilderSave(sheet);
  });
  $('#btn-reset-custom').addEventListener('click', () => {
    draft.customPrompt = DEFAULT_CUSTOM_PROMPT;
    $('#f-custom').value = DEFAULT_CUSTOM_PROMPT;
    ui.toast('写作指令已恢复默认。');
  });
  $('#chk-autodesign').addEventListener('click', (e) => {
    draft.autoDesign = !draft.autoDesign;
    e.currentTarget.classList.toggle('active', draft.autoDesign);
  });

  $('#btn-new').addEventListener('click', () => openSetup());
  $('#empty-start')?.addEventListener('click', () => openSetup());
  $('#setup-close').addEventListener('click', () => {
    $('#screen-setup').classList.remove('open');
    if (!state.session) showEmptyState();
  });

  $('#template-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-template]');
    if (!card) return;
    readForm();
    applyTemplate(card.dataset.template);
  });

  $('#emotion-preset-row').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-emopreset]');
    if (!chip) return;
    const key = chip.dataset.emopreset;
    if (key === '__clear') draft.emotions = [];
    else draft.emotions = [...EMOTION_PRESETS[key].list];
    $('#f-emotions').value = draft.emotions.join(', ');
    renderEmotionPresets();
  });

  $('#intensity-row').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-intensity]');
    if (!chip) return;
    const item = INTENSITY.find((x) => x.label === chip.dataset.intensity);
    draft.intensity = item.text;
    $('#f-intensity').value = item.text;
    renderIntensityChips();
  });

  $$('[data-add-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      syncPanelDraft();
      const scope = btn.dataset.addPanel;
      const list = scope === 'top' ? draft.topPanels : draft.bottomPanels;
      list.push(makePanel({ label: '新面板', kind: 'list', hint: '按当前剧情生成这个面板应当展示的内容。' }));
      renderPanelEditor(scope);
    });
  });

  $('#screen-setup').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-panel]');
    if (del) {
      syncPanelDraft();
      const scope = del.closest('.panel-row').dataset.scope;
      const list = scope === 'top' ? draft.topPanels : draft.bottomPanels;
      list.splice(Number(del.dataset.delPanel), 1);
      renderPanelEditor(scope);
    }
  });

  $('#setup-start').addEventListener('click', async () => {
    readForm();
    if (draft.autoDesign && draft.designSignature !== scenarioSignature()) {
      const btn = $('#setup-start');
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '正在按剧情配置界面…';
      try { await runAutoDesign({ silent: true }); } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    }
    const setup = collectSetup();
    if (!setup.scenario && !setup.opening && !setup.targetRole) {
      ui.toast('至少写一点剧情设定或对方角色，导演才知道从哪开始。', 'warn');
      return;
    }
    const session = newSession(setup);
    persist(session);
    $('#screen-setup').classList.remove('open');
    enterSession(session);
    generate();
  });

  $('#f-emotions').addEventListener('input', () => { draft.emotions = $('#f-emotions').value.split(/[,，、\s]+/).filter(Boolean); });
}

/* =========================================================
   生成流程
   ========================================================= */

function currentPanelDefs() {
  const s = state.session;
  return [...(s?.setup.topPanels || []), ...(s?.setup.bottomPanels || [])];
}

async function generate() {
  const s = state.session;
  if (!s || state.generating) return;

  state.generating = true;
  state.activePanel = null;
  ui.closeDrawer();
  ui.lockComposer(true);              // 只锁输入区，不整体重绘（重绘会让画面跳）
  ui.showTyping();
  if (state.stick) ui.scrollToBottom(false);
  setSendState(true);

  const controller = new AbortController();
  state.abort = controller;

  try {
    const { round, engine, warning, repaired } = await generateRound({
      session: s,
      cursor: s.cursor,
      signal: controller.signal,
      styleSample: state.serverCfg.styleSample || localConfig.read().styleSample || '',
      onPartial: (blocks) => {
        ui.hideTyping();
        ui.renderStreamingRound(s, blocks);
        followScroll(true);
      }
    });

    round.i = s.cursor + 1;
    round.playerAction = s.pendingAction || '';
    round.createdAt = Date.now();
    // 生成成功之后才处理"从中间继续"：把原来的后续轮次存成分支再覆盖
    // （失败时什么都不动，玩家的剧情不会有任何损失）
    if (s.cursor < s.rounds.length - 1) {
      const tail = s.rounds.slice(s.cursor + 1);
      s.branches = s.branches || [];
      // 支线只留 5 轮（超出部分自动丢掉），总共最多留 5 条
      s.branches.push({
        at: s.cursor,
        atTime: Date.now(),
        rounds: tail.slice(-syncApi.BRANCH_KEEP_ROUNDS)
      });
      if (s.branches.length > syncApi.BRANCH_KEEP_COUNT) {
        s.branches = s.branches.slice(-syncApi.BRANCH_KEEP_COUNT);
      }
      s.rounds = s.rounds.slice(0, s.cursor + 1);
    }
    s.rounds.push(round);
    s.cursor = s.rounds.length - 1;
    s.pendingAction = '';
    applyPanelUpdates(s, round);
    delete round._rawPanels;          // 调试用的中间字段，不进存储
    persist(s);
    fillPanelsInBackground(s, round.i);   // 面板丢到后台补，不挡正文

    ui.clearTyping();
    ui.renderLastRound(s, { futureCount: 0 });
    ui.renderHUD(s);
    ui.flashEmotions();
    ui.renderRoundNav(s);
    renderSessionList();
    followScroll(false);
    if (warning) {
      state.lastFailure = warning;
      await refreshEngineBanner(true);
      ui.toast('模型这一轮没接上，已改用本地示例引擎 —— 详情看顶部提示。', 'warn');
    } else {
      if (repaired) ui.toast('这一轮模型的 JSON 格式有瑕疵，已自动修复后呈现。');
      if (state.lastFailure) {
        state.lastFailure = null;
        await refreshEngineBanner(true);
      }
      if (engine === 'local') ui.toast('本轮由本地示例引擎生成。');
    }
  } catch (err) {
    ui.clearTyping();
    ui.renderLastRound(s, { futureCount: Math.max(0, s.rounds.length - 1 - s.cursor) });
    if (err.name === 'AbortError') {
      ui.toast('已停止本轮生成。');
    } else {
      // 生成失败：本轮不写入任何内容，把玩家刚才的输入留着，等他重试
      const base = err.kind === 'network'
        ? `连不上服务：${err.message}`
        : `本轮生成失败：${err.message}`;
      state.lastFailure = `${base}${err.hint ? `\n建议：${err.hint}` : ''}`;
      state.failureRetry = true;
      await refreshEngineBanner(true);
      ui.toast('生成失败，本轮没有写入任何内容。点顶部提示里的「重试」再试一次。', 'warn');
    }
  } finally {
    state.generating = false;
    state.abort = null;
    setSendState(false);
    const input = $('[data-input]');
    if (input) {
      fitTextarea(input);
      // 手机上不要自动聚焦，否则会弹出键盘挡住正文
      const coarse = window.matchMedia?.('(pointer: coarse)').matches;
      if (!coarse) input.focus({ preventScroll: true });
    }
  }
}

/** 顶部按钮跟着剧情走：新增 / 改名 / 淘汰 */
function applyPanelUpdates(session, round) {
  const pu = round.panelUpdates;
  if (!pu) return;
  session.setup.topPanels = session.setup.topPanels || [];
  const notes = [];

  for (const r of pu.rename) {
    const hit = session.setup.topPanels.find((p) => p.id === r.id);
    if (hit && hit.label !== r.label) {
      notes.push(`「${hit.label}」改名「${r.label.slice(0, 10)}」`);
      hit.label = r.label.slice(0, 10);
    }
  }
  if (pu.remove.length) {
    const gone = session.setup.topPanels.filter((p) => pu.remove.includes(p.id));
    session.setup.topPanels = session.setup.topPanels.filter((p) => !pu.remove.includes(p.id));
    gone.forEach((p) => notes.push(`移除「${p.label}」`));
  }
  for (const def of pu.add) {
    if (session.setup.topPanels.length >= 6) break;
    if (session.setup.topPanels.some((p) => p.label === def.label)) continue;
    const panel = makePanel(def);
    session.setup.topPanels.push(panel);
    // 模型如果本轮就按 label 写了内容，直接接上
    const raw = round._rawPanels || {};
    round.panels[panel.id] = raw[def.label] ?? raw[panel.label] ?? '';
    notes.push(`新增「${panel.label}」`);
  }
  delete round._rawPanels;
  if (notes.length) {
    ui.renderTopActions(session.setup, state.activePanel);
    ui.toast(`顶部按钮已按剧情调整：${notes.join('、')}`);
  }
}

function setSendState(busy) {
  const btn = $('[data-send]');
  if (!btn) return;
  btn.textContent = busy ? '停止' : '发送';
  btn.dataset.busy = busy ? '1' : '';
}

function submitAction(text) {
  const s = state.session;
  if (!s || state.generating) return;
  const value = String(text || '').trim();
  state.stick = true;                 // 玩家主动出招，跟着往下看
  s.pendingAction = value;
  generate();
}

function fitTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

/* =========================================================
   交互绑定
   ========================================================= */

function bindGlobal() {
  $('#title-text').addEventListener('click', renameSession);
  $('#title-text').title = '点击改名';

  $('#btn-home').addEventListener('click', () => {
    state.session = null;
    store.setActiveId(null);
    toggleSidebar(false);
    renderSessionList();
    showEmptyState();
  });

  // 跟随滚动：只有用户停在底部时才自动跟着新内容走
  $('#stage').addEventListener('scroll', () => {
    state.stick = ui.isNearBottom(90);
    $('#stage').dataset.stick = String(state.stick);
    if (state.stick) ui.setJumpButton(false);
  }, { passive: true });

  $('#jump-bottom').addEventListener('click', () => {
    state.stick = true;
    ui.setJumpButton(false);
    ui.scrollToBottom(true);
  });

  // 侧栏
  $('#btn-sidebar').addEventListener('click', () => toggleSidebar(true));
  $('#scrim').addEventListener('click', () => toggleSidebar(false));

  $('#engine-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-banner-close]')) {
      state.bannerDismissed = true;
      ui.renderEngineBanner(null);
      return;
    }
    const btn = e.target.closest('[data-banner-action]');
    if (!btn) return;
    if (btn.dataset.bannerAction === 'retry') {
      state.lastFailure = null;
      state.failureRetry = false;
      refreshEngineBanner(true);
      generate();
      return;
    }
    openSettings();
  });

  $('#sync-bar').addEventListener('click', () => openSettings());

  $('#session-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      confirmModal('删除这条剧情档案？', '删除后无法恢复。', () => {
        dropSession(id);
        if (state.session?.id === id) {
          state.session = null;
          const next = store.listSessions()[0];
          if (next) enterSession(next); else showEmptyState();
        }
        renderSessionList();
      });
      return;
    }
    const item = e.target.closest('[data-session]');
    if (!item) return;
    const session = store.getSession(item.dataset.session);
    if (session) { enterSession(session); toggleSidebar(false); }
  });

  // 顶栏 / 底栏
  $('#top-actions').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) { openSettings(); return; }
    if (e.target.closest('[data-open-writing]')) { openWriting(); return; }
    if (e.target.closest('[data-open-mode]')) { openMode(); return; }
    const btn = e.target.closest('[data-panel]');
    if (btn) openPanel(btn.dataset.panel);
  });

  $('#bottombar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-panel]');
    if (btn) openPanel(btn.dataset.panel);
  });

  $('#drawer-close').addEventListener('click', () => { state.activePanel = null; ui.closeDrawer(); renderPanelButtons(); });
  $('#drawer-foot').addEventListener('click', (e) => {
    if (!e.target.closest('[data-idea-send]')) return;
    const input = $('#drawer-foot [data-idea-input]');
    const text = input?.value.trim();
    if (!text) return;
    state.activePanel = null;
    ui.closeDrawer();
    renderPanelButtons();
    const box = $('[data-input]');
    if (box) {
      box.value = box.value ? `${box.value} ${text}` : text;
      fitTextarea(box);
      box.focus();
    }
    ui.toast('思路已填入输入框，可以再改一改再发送。');
  });

  // 正文区：选项 / 发送 / 工具
  $('#stage').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-option]');
    if (opt) {
      const text = opt.querySelector('span:last-child')?.textContent?.trim();
      if (text) submitAction(text);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'regenerate') regenerate();
    else if (act.dataset.act === 'rewind') gotoRound(state.session.cursor - 1);
    else if (act.dataset.act === 'timeline') openTimeline();
  });

  $('#stage').addEventListener('click', (e) => {
    const send = e.target.closest('[data-send]');
    if (!send) return;
    if (send.dataset.busy) { state.abort?.abort(); return; }
    const box = $('[data-input]');
    submitAction(box?.value);
  });

  $('#stage').addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-input]')) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitAction(e.target.value);
    }
  });
  $('#stage').addEventListener('input', (e) => {
    if (e.target.matches('[data-input]')) fitTextarea(e.target);
  });

  // 回合导航
  $('#nav-prev').addEventListener('click', () => gotoRound(state.session.cursor - 1));
  $('#nav-next').addEventListener('click', () => gotoRound(state.session.cursor + 1));
  $('#nav-count').addEventListener('click', openTimeline);

  // 弹层
  $('#modal-root').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) ui.closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-root').hidden) ui.closeModal();
      else if (state.activePanel) { state.activePanel = null; ui.closeDrawer(); renderPanelButtons(); }
      else toggleSidebar(false);
    }
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-data').addEventListener('click', openData);
}

function toggleSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}

function renderPanelButtons() {
  if (!state.session) return;
  ui.renderTopActions(state.session.setup, state.activePanel);
  ui.renderBottombar(state.session.setup, state.activePanel);
}

function openPanel(id) {
  const s = state.session;
  if (!s) return;
  const def = currentPanelDefs().find((p) => p.id === id);
  if (!def) return;
  const round = s.rounds[s.cursor];
  if (!round) {
    ui.toast('剧情还没有开始，先写下第一句吧。');
    return;
  }
  state.activePanel = state.activePanel === id ? null : id;
  renderPanelButtons();
  if (!state.activePanel) { ui.closeDrawer(); return; }
  const st = panelState(s, s.cursor);
  // 面板可能是每 4 轮才更新一次 —— 没更新的轮次就沿用最近一次的内容
  const value = panelValue(s, s.cursor, id);
  ui.openDrawer(def, value, {
    pending: st === 'pending' && !hasPanelContent(value),
    failed: st === 'failed' && !hasPanelContent(value)
  });
}

/** 取某个面板"最近一次生成过的内容" */
function panelValue(session, index, id) {
  for (let i = index; i >= 0; i -= 1) {
    const v = session.rounds[i]?.panels?.[id];
    if (hasPanelContent(v)) return v;
  }
  return undefined;
}

function hasPanelContent(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function gotoRound(index) {
  const s = state.session;
  if (!s) return;
  if (index < 0) { ui.toast('已经是第一轮了。'); return; }
  if (index >= s.rounds.length) return;
  s.cursor = index;
  persist(s, { touch: false });      // 只是翻页，不算内容更新（否则会覆盖别的设备的新内容）
  state.activePanel = null;
  ui.closeDrawer();
  ui.renderRounds(s, { futureCount: s.rounds.length - 1 - s.cursor });
  ui.renderHUD(s);
  ui.renderRoundNav(s);
  renderPanelButtons();
  const target = $(`#rounds .round[data-i="${index}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (index < s.rounds.length - 1) ui.toast('已回到这一轮。继续对话会从这里的另一条分支展开。');
}

function regenerate() {
  const s = state.session;
  if (!s || s.cursor < 0) return;
  const round = s.rounds[s.cursor];
  // 只把游标退回去，先不删数据 —— 万一重新生成失败，原作还在
  s.pendingAction = round.playerAction || '';
  s.cursor -= 1;
  state.stick = true;
  persist(s, { touch: false });
  ui.renderRounds(s, { futureCount: s.rounds.length - 1 - s.cursor });
  ui.renderRoundNav(s);
  generate();
}

/* =========================================================
   弹层：时间轴 / 设置 / 数据
   ========================================================= */

/** 修改当前剧情的尺度与写作指令（不必重开一局） */
/** 一键切换「这一步想怎么写」：剧情为主 / 平衡 / 直球 */
function applyMode(session, key, ratio, { save = true } = {}) {
  const m = MODE_PRESETS[key];
  if (!m || !session) return;
  session.setup.mode = key;
  session.setup.intensity = m.intensity;
  if (Number.isFinite(ratio)) session.setup.fleshRatio = Math.max(0, Math.min(100, ratio));
  else if (!Number.isFinite(Number(session.setup.fleshRatio))) session.setup.fleshRatio = m.fleshRatio;
  if (save) persist(session);
  ui.renderTopActions(session.setup, state.activePanel);
}

function openMode() {
  const s = state.session;
  if (!s) return;
  const cur = modeOf(s.setup);
  const curRatio = fleshRatioOf(s.setup);
  ui.openModal(`
    <h3>这一步想怎么写？</h3>
    ${MODE_ORDER.map((k) => {
      const m = MODE_PRESETS[k];
      return `<button class="mode-card${k === cur ? ' active' : ''}" data-mode="${k}">
        <b>${m.icon} ${esc(m.name)}</b>
        <span>${esc(m.desc)}</span>
      </button>`;
    }).join('')}
    <div class="field" style="margin-top:14px">
      <label class="field-label">配比微调<span class="field-hint">左＝剧情，右＝肉，随时可拖</span></label>
      <input type="range" id="m-ratio" class="ratio-slider" min="0" max="100" step="5" value="${curRatio}" />
      <div class="ratio-legend"><span>纯剧情</span><b id="m-ratio-text"></b><span>纯肉</span></div>
    </div>
    <div class="tip">只影响这一部剧情，下一轮生效。想改所有新剧情的默认值，去 <b>⚙ 设置 → 默认尺度模式</b>。</div>
    <div class="row"><button class="cancel" data-close-modal>关闭</button></div>
  `, (modal) => {
    const slider = modal.querySelector('#m-ratio');
    const text = modal.querySelector('#m-ratio-text');
    let key = cur;
    const paint = () => {
      const r = Number(slider.value);
      key = modeForRatio(r);
      text.textContent = `剧情 ${100 - r}% : 情欲 ${r}%（${ratioLabel(r)}）`;
      modal.querySelectorAll('.mode-card').forEach((c) => c.classList.toggle('active', c.dataset.mode === key));
      applyMode(s, key, r, { save: false });
    };
    slider.addEventListener('input', paint);
    // 松手时才落盘，拖动过程只更新界面（手机上 400KB 的数据写太勤会卡）
    slider.addEventListener('change', () => applyMode(s, modeForRatio(Number(slider.value)), Number(slider.value)));
    text.textContent = `剧情 ${100 - curRatio}% : 情欲 ${curRatio}%（${ratioLabel(curRatio)}）`;
    modal.addEventListener('click', (e) => {
      const card = e.target.closest('[data-mode]');
      if (!card) return;
      slider.value = MODE_PRESETS[card.dataset.mode].fleshRatio;
      paint();
    });
  });
}

function renameSession() {
  const s = state.session;
  if (!s) return;
  ui.openModal(`
    <h3>给这部剧情改个名字</h3>
    <div class="field">
      <input id="rn-input" type="text" value="${esc(s.title)}" maxlength="40" />
    </div>
    <div class="row">
      <button class="cancel" data-close-modal>取消</button>
      <button class="ok" id="rn-save">保存</button>
    </div>
  `, (modal) => {
    const input = modal.querySelector('#rn-input');
    input.focus();
    input.select();
    const save = () => {
      const v = input.value.trim();
      if (!v) { ui.toast('名字不能为空。', 'warn'); return; }
      s.title = v.slice(0, 40);
      persist(s);
      $('#title-text').textContent = s.title;
      renderSessionList();
      ui.closeModal();
      ui.toast('已改名。');
    };
    modal.querySelector('#rn-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  });
}

function openWriting() {
  const s = state.session;
  if (!s) return;
  const cur = s.setup.intensity || '';
  const custom = s.setup.customPrompt || '';
  ui.openModal(`
    <h3>本剧的尺度与写作指令</h3>
    <div class="field">
      <label class="field-label">尺度模式<span class="field-hint">一键切换，下面的细档会自动跟着变</span></label>
      <div class="chip-row" id="w-modes">
        ${MODE_ORDER.map((k) => `<button class="chip${modeOf(s.setup) === k ? ' active' : ''}" data-m="${k}">${MODE_PRESETS[k].icon} ${esc(MODE_PRESETS[k].name)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">内容尺度</label>
      <div class="chip-row" id="w-orientation" style="margin-bottom:10px">
        ${ORIENTATION_ORDER.map((k) => `<button class="chip${(s.setup.orientation || 'mm') === k ? ' active' : ''}" data-wo="${k}">${ORIENTATION_PRESETS[k].icon} ${esc(ORIENTATION_PRESETS[k].name)}</button>`).join('')}
      </div>
      <div class="chip-row" id="w-intensity">
        ${INTENSITY.map((it) => `<button class="chip${cur === it.text ? ' active' : ''}" data-w="${esc(it.label)}">${esc(it.label)}</button>`).join('')}
      </div>
      <div class="tip" style="margin-top:6px" id="w-intensity-text">${esc(cur || '（未设置）')}</div>
    </div>
    <div class="field">
      <label class="field-label">单轮篇幅<span class="field-hint">觉得写得单薄，就调大这一档</span></label>
      <div class="chip-row" id="w-length">
        ${Object.entries(LENGTH_PRESETS).map(([k, v]) => `<button class="chip${(s.setup.lengthHint || '') === v.hint ? ' active' : ''}" data-len="${k}">${esc(v.name)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">写作指令<span class="field-hint">最高优先级，逐条写清楚</span></label>
      <textarea id="w-custom" rows="10">${esc(custom || DEFAULT_CUSTOM_PROMPT)}</textarea>
      <div class="chip-row">
        <button class="chip" id="w-reset">恢复默认</button>
        <button class="chip" id="w-builder">✍ 打开人设工坊</button>
      </div>
    </div>
    <div class="tip">保存后，下一轮生成就会用新设定。<b>去掉"避免直白"那类字眼、尺度选「无限制」，能明显减少模型自己往回收。</b></div>
    <div class="row">
      <button class="cancel" data-close-modal>取消</button>
      <button class="ok" id="w-save">保存</button>
    </div>
  `, (modal) => {
    let picked = cur;
    let pickedMode = modeOf(s.setup);
    let pickedOrientation = s.setup.orientation || 'mm';
    modal.querySelector('#w-orientation').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-wo]');
      if (!chip) return;
      pickedOrientation = chip.dataset.wo;
      modal.querySelectorAll('#w-orientation .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
    modal.querySelector('#w-modes').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-m]');
      if (!chip) return;
      pickedMode = chip.dataset.m;
      picked = MODE_PRESETS[pickedMode].intensity;
      modal.querySelectorAll('#w-modes .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      modal.querySelectorAll('#w-intensity .chip').forEach((c) => c.classList.toggle('active', c.dataset.w === '无限制' && pickedMode === 'explicit'));
      modal.querySelector('#w-intensity-text').textContent = picked;
    });
    let pickedLen = s.setup.lengthHint || '';
    modal.querySelector('#w-length').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-len]');
      if (!chip) return;
      pickedLen = LENGTH_PRESETS[chip.dataset.len].hint;
      modal.querySelectorAll('#w-length .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
    modal.querySelector('#w-intensity').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-w]');
      if (!chip) return;
      const item = INTENSITY.find((x) => x.label === chip.dataset.w);
      if (!item) return;
      picked = item.text;
      pickedMode = INTENSITY_MODE_MAP[item.label] || pickedMode;
      modal.querySelectorAll('#w-modes .chip').forEach((c) => c.classList.toggle('active', c.dataset.m === pickedMode));
      modal.querySelectorAll('#w-intensity .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      modal.querySelector('#w-intensity-text').textContent = item.text;
    });
    modal.querySelector('#w-reset').addEventListener('click', () => {
      modal.querySelector('#w-custom').value = DEFAULT_CUSTOM_PROMPT;
    });
    modal.querySelector('#w-builder').addEventListener('click', () => {
      ui.closeModal();
      openBuilder({
        sheet: s.setup.sheet,
        fromSetup: false,
        mode: modeOf(s.setup),
        onSave: (sheet, mode) => {
          s.setup.sheet = sheet;
          if (mode) {
            s.setup.mode = mode;
            s.setup.intensity = MODE_PRESETS[mode]?.intensity || s.setup.intensity;
          }
          const parts = sheetToSetupParts(sheet);
          if (parts.userRole) s.setup.userRole = parts.userRole;
          if (parts.targetRole) s.setup.targetRole = parts.targetRole;
          if (parts.scenario) s.setup.scenario = parts.scenario;
          if (parts.opening) s.setup.opening = parts.opening;
          persist(s);
          ui.toast('角色卡已保存，下一轮开始生效。');
        }
      });
    });
    modal.querySelector('#w-save').addEventListener('click', () => {
      s.setup.intensity = picked;
      s.setup.mode = pickedMode;
      s.setup.orientation = pickedOrientation;
      if (pickedLen) s.setup.lengthHint = pickedLen;
      s.setup.customPrompt = modal.querySelector('#w-custom').value.trim();
      persist(s);
      ui.closeModal();
      ui.toast('已保存，下一轮就用新设定生成。');
    });
  });
}

function openTimeline() {
  const s = state.session;
  if (!s) return;
  const items = s.rounds.map((r, i) => {
    const first = (r.blocks || []).find((b) => b.type === 'narration')?.text
      || (r.blocks || [])[0]?.text || '';
    return `<button class="timeline-item${i === s.cursor ? ' current' : ''}" data-goto="${i}">
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="txt">${esc(r.scene.act)} · ${esc(first.slice(0, 22))}</span>
      <span class="idx">${esc(r.scene.time)}</span>
    </button>`;
  }).join('');

  const branches = (s.branches || []).map((b, i) => `
    <div class="timeline-item" style="cursor:default">
      <span class="idx">⑂${i + 1}</span>
      <span class="txt">从第 ${b.at + 1} 轮分出的另一条线 · ${b.rounds.length} 轮</span>
    </div>`).join('');

  ui.openModal(`
    <h3>时间轴</h3>
    ${items || '<div class="drawer-empty">还没有任何轮次。</div>'}
    ${branches ? `<h3 style="margin-top:20px;font-size:14px">已保存的分支</h3>${branches}` : ''}
    <div class="row"><button class="cancel" data-close-modal>关闭</button></div>
  `, (modal) => {
    modal.addEventListener('click', (e) => {
      const item = e.target.closest('[data-goto]');
      if (!item) return;
      ui.closeModal();
      gotoRound(Number(item.dataset.goto));
    });
  });
}

async function openSettings() {
  const cfg = (await server.getConfig()).config || {};
  state.serverCfg = cfg;
  const local = localConfig.read();
  const syncCfg = syncApi.syncConfig.read();
  const syncGh = { repo: '', path: 'novel.json', ...(syncCfg.gh || {}) };
  syncGh.repo = syncCfg.gh?.owner && syncCfg.gh?.repo ? `${syncCfg.gh.owner}/${syncCfg.gh.repo}` : '';
  const curBackend = syncCfg.backend || 'server';
  const srv = await probeServer(true);
  const info = await server.info();
  const urls = (info.addresses || []).map((u) => `<span class="hl">${esc(u)}</span>`).join('、');

  const base = local.baseUrl || cfg.baseUrl || PROVIDERS.deepseek.baseUrl;
  const model = local.model || cfg.model || PROVIDERS.deepseek.model;
  const mode = local.mode || 'auto';
  const keyHint = local.apiKey
    ? `已保存在本机浏览器（${local.apiKey.slice(0, 5)}····${local.apiKey.slice(-4)}）`
    : cfg.hasKey
      ? `已保存在本机服务（${esc(cfg.keyPreview || '')}）`
      : '粘贴你的 API Key，DeepSeek 以 sk- 开头';

  const modeLabels = { auto: '自动（推荐）', server: '只用本机服务', direct: '只用浏览器直连' };

  ui.openModal(`
    <h3>导演引擎设置</h3>
    <div class="field">
      <label class="field-label">服务商</label>
      <div class="chip-row" id="s-providers">
        ${Object.entries(PROVIDERS).map(([k, p]) => `<button class="chip" data-provider="${k}">${esc(p.name)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">API 地址</label>
      <input id="s-base" type="text" value="${esc(base)}" placeholder="https://api.deepseek.com/v1" />
    </div>
    <div class="field">
      <label class="field-label">API Key<span class="field-hint">${keyHint}</span></label>
      <input id="s-key" type="password" placeholder="留空 = 不修改已保存的 Key" autocomplete="off" />
    </div>
    <div class="field">
      <label class="field-label">模型</label>
      <input id="s-model" type="text" value="${esc(model)}" placeholder="deepseek-v4-pro" />
      <div class="chip-row" id="s-model-pick" style="margin-top:8px">
        <button class="chip" id="s-model-fetch">拉取这家服务的可用模型</button>
      </div>
    </div>
    <div class="field-2col">
      <div class="field">
        <label class="field-label">温度</label>
        <input id="s-temp" type="text" value="${esc(String(local.temperature ?? cfg.temperature ?? 0.9))}" />
      </div>
      <div class="field">
        <label class="field-label">最大输出 tokens</label>
        <input id="s-max" type="text" value="${esc(String(local.maxTokens ?? cfg.maxTokens ?? 32000))}" />
      </div>
    </div>
    <div class="chip-row">
      <button class="chip${(local.stream ?? cfg.stream ?? true) ? ' active' : ''}" id="s-stream">流式输出</button>
      <button class="chip${(local.jsonMode ?? cfg.jsonMode ?? true) ? ' active' : ''}" id="s-json">强制 JSON 模式</button>
    </div>
    <div class="field">
      <label class="field-label">调用方式</label>
      <div class="chip-row" id="s-modes">
        ${Object.entries(modeLabels).map(([k, v]) => `<button class="chip${mode === k ? ' active' : ''}" data-mode="${k}">${esc(v)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">默认尺度模式<span class="field-hint">新建剧情时的默认值（老剧情不受影响）</span></label>
      <div class="chip-row" id="s-default-mode">
        ${MODE_ORDER.map((k) => `<button class="chip${(local.defaultMode || 'balanced') === k ? ' active' : ''}" data-dm="${k}">${MODE_PRESETS[k].icon} ${esc(MODE_PRESETS[k].name)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">默认取向<span class="field-hint">会作为硬性设定写进提示词</span></label>
      <div class="chip-row" id="s-default-orientation">
        ${ORIENTATION_ORDER.map((k) => `<button class="chip${(local.defaultOrientation || 'mm') === k ? ' active' : ''}" data-do="${k}">${ORIENTATION_PRESETS[k].icon} ${esc(ORIENTATION_PRESETS[k].name)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">思考强度<span class="field-hint">v4/flash 是推理模型，"想"的时间占了大头 —— 觉得慢就调低</span></label>
      <div class="chip-row" id="s-reasoning">
        ${[['default', '默认（推荐 · 文笔最好）'], ['low', '低（省时间）'], ['off', '关闭（最快 · 只建议给面板用）']]
          .map(([k, n]) => `<button class="chip${(local.reasoningEffort || cfg.reasoningEffort || 'default') === k ? ' active' : ''}" data-r="${k}">${esc(n)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">文风样例<span class="field-hint">贴 1-2 段你最满意的原文，模型会向它的写法靠拢</span></label>
      <textarea id="s-style" rows="6" placeholder="粘贴一段范文（建议 500~2000 字）。只学写法，不会照抄内容。">${esc(local.styleSample || cfg.styleSample || '')}</textarea>
      <div class="chip-row" style="margin-top:8px">
        <button class="chip" id="s-style-clear">清空文风样例</button>
      </div>
    </div>
    <div class="field">
      <label class="field-label">跨设备同步<span class="field-hint">可以存在电脑（server.js）上，也可以存在你自己的 GitHub 私有仓库里（电脑关机也能同步）</span></label>
      <div class="diag" id="s-sync-state"></div>
      <div class="chip-row" id="s-sync-backend">
        <button class="chip${curBackend === 'server' ? ' active' : ''}" data-sb="server">本机服务（电脑）</button>
        <button class="chip${curBackend === 'github' ? ' active' : ''}" data-sb="github">GitHub 私有仓库（不用电脑开机）</button>
      </div>
      <div id="s-gh-fields" ${curBackend === 'github' ? '' : 'hidden'}>
        <input id="s-gh-repo" type="text" value="${esc(syncGh.repo || '')}" placeholder="仓库：你的用户名/仓库名，例如 eventilldawn-dot/novel-data" />
        <input id="s-gh-path" type="text" value="${esc(syncGh.path || 'novel.json')}" placeholder="文件名，例如 novel.json" style="margin-top:8px" />
        <input id="s-gh-token" type="password" placeholder="${syncGh.token ? '已保存（留空不变）' : 'GitHub token：只给这个仓库的 Contents 读写权限'}" style="margin-top:8px" />
        <div class="field-tip">token 只存在你本机浏览器，请求直连 api.github.com。仓库必须是<b>私有</b>的。${cfg.ghSync?.hasToken ? '<br>这台设备已经由电脑端自动填好了，一般不用动。' : ''}</div>
      </div>
      <input id="s-sync-url" type="text" value="${esc(syncCfg.serverUrl || '')}" placeholder="http://192.168.1.14:8787（线上版想连回家里时填）" />
      <input id="s-sync-token" type="text" value="${esc(syncCfg.token || '')}" placeholder="同步口令（启动 server.js 时终端会打印）" style="margin-top:8px" />
      <div class="chip-row" style="margin-top:9px">
        <button class="chip" id="s-sync-now">立即同步</button>
        <button class="chip" id="s-make-link">打包成手机配置链接</button>
      </div>
      <div class="field-tip">手机第一次用线上版时：点上面的按钮 → 把复制到的链接发到手机（微信文件传输助手）→ 手机上用浏览器打开一次，Key 和同步就都配好了，之后不用再碰电脑。</div>
    </div>
    <div class="tip">
      ${srv.up
        ? `本机服务：已连接（${esc(cfg.baseUrl || '')}），Key ${cfg.hasKey ? '已配置' : '未配置'}。`
        : '本机服务：未检测到。此时会走浏览器直连（Key 存在本机浏览器里，只用于直接请求模型）。'}
      <br>手机 / 平板与电脑连同一 WiFi 时，可用这些地址打开：${urls || '（未检测到局域网地址）'}
    </div>
    <div id="s-result"></div>
    <div class="row">
      <button class="cancel" data-close-modal>取消</button>
      <button class="cancel" id="s-test">测试连接</button>
      <button class="ok" id="s-save">保存</button>
    </div>
    ${local.apiKey ? '<div class="row"><button class="danger" id="s-forget" style="flex:1">清除本机浏览器里保存的 Key</button></div>' : ''}
  `, (modal) => {
    const readForm = () => ({
      baseUrl: modal.querySelector('#s-base').value.trim(),
      model: modal.querySelector('#s-model').value.trim(),
      temperature: Number(modal.querySelector('#s-temp').value) || 0.9,
      maxTokens: Number(modal.querySelector('#s-max').value) || 32000,
      stream: modal.querySelector('#s-stream').classList.contains('active'),
      jsonMode: modal.querySelector('#s-json').classList.contains('active'),
      mode: modal.querySelector('#s-modes .active')?.dataset.mode || 'auto',
      key: modal.querySelector('#s-key').value.trim()
    });

    const toggle = (sel) => {
      const btn = modal.querySelector(sel);
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    };
    toggle('#s-stream');
    toggle('#s-json');

    modal.querySelector('#s-providers').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-provider]');
      if (!chip) return;
      const p = PROVIDERS[chip.dataset.provider];
      modal.querySelector('#s-base').value = p.baseUrl;
      modal.querySelector('#s-model').value = p.model;
      modal.querySelectorAll('#s-providers .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });

    modal.querySelector('#s-modes').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-mode]');
      if (!chip) return;
      modal.querySelectorAll('#s-modes .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });

    const syncBox = modal.querySelector('#s-sync-state');
    const paintSync = () => {
      const s = syncApi.syncState();
      const text = s.error
        ? `✕ ${s.error}${s.errorDetail ? `（${s.errorDetail}）` : ''}`
        : s.kind === 'github'
          ? `✓ 已连上你自己的 GitHub 私有仓库（${s.base.replace(/^github:/, '')}）。剧情存在仓库里，电脑关不关机都能同步。`
        : s.kind === 'server'
          ? `✓ 已连上本机服务。所有剧情保存在 ${location.origin} 这台电脑的 data/sessions.json 里，用同一个地址打开的每台设备共用这一份。`
          : s.kind === 'remote'
            ? `✓ 已连上远程服务 ${s.serverUrl}，各端共用一份。`
            : '✕ 当前只存在这台设备的浏览器里，换设备看不到。启动电脑上的 server.js，或者用局域网地址打开本页，就会自动同步。';
      syncBox.className = `diag ${s.available && !s.error ? 'ok' : 'bad'}`;
      syncBox.innerHTML = `<b>跨设备同步：${s.available && !s.error ? '已开启' : '未开启'}</b>${esc(text)}`;
    };
    paintSync();

    const applySyncForm = async () => {
      const backend = modal.querySelector('#s-sync-backend .chip.active')?.dataset.sb || 'server';
      const repoStr = modal.querySelector('#s-gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '');
      const [owner, repoName] = repoStr.split('/');
      const ghToken = modal.querySelector('#s-gh-token').value.trim();
      syncApi.syncConfig.write({
        serverUrl: modal.querySelector('#s-sync-url').value.trim(),
        token: modal.querySelector('#s-sync-token').value.trim(),
        backend,
        manual: true,
        gh: {
          owner: owner || '',
          repo: repoName || '',
          path: modal.querySelector('#s-gh-path').value.trim() || 'novel.json',
          token: ghToken || syncGh.token || ''
        }
      });
      await syncApi.initSync();
      updateSyncUI();
      paintSync();
    };

    modal.querySelector('#s-sync-backend').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-sb]');
      if (!chip) return;
      modal.querySelectorAll('#s-sync-backend .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      modal.querySelector('#s-gh-fields').hidden = chip.dataset.sb !== 'github';
    });

    modal.querySelector('#s-sync-now').addEventListener('click', async () => {
      await applySyncForm();
      await runFullSync();
      paintSync();
    });

    modal.querySelector('#s-make-link').addEventListener('click', async () => {
      const btn = modal.querySelector('#s-make-link');
      btn.textContent = '正在打包…';
      const link = await buildBootstrapLink({
        key: modal.querySelector('#s-key').value.trim(),
        baseUrl: modal.querySelector('#s-base').value.trim(),
        model: modal.querySelector('#s-model').value.trim(),
        temperature: Number(modal.querySelector('#s-temp').value) || 0.9,
        maxTokens: Number(modal.querySelector('#s-max').value) || 12000,
        reasoningEffort: modal.querySelector('#s-reasoning .chip.active')?.dataset.r || 'default',
        styleSample: modal.querySelector('#s-style').value.trim(),
        defaultMode: modal.querySelector('#s-default-mode .chip.active')?.dataset.dm || 'balanced',
        defaultOrientation: modal.querySelector('#s-default-orientation .chip.active')?.dataset.do || 'mm'
      });
      btn.textContent = '打包成手机配置链接';
      const copied = await copyText(link);
      if (copied) ui.toast('已复制。发到手机（微信文件传输助手）后用浏览器打开一次就行。');
      else ui.toast('没能自动复制，链接已放进下面的框里，手动复制一下。', 'warn');
      modal.querySelector('#s-result').innerHTML =
        `<div class="diag ok"><b>手机配置链接（${link.length} 字符）</b>`
        + `<textarea rows="4" style="width:100%;margin-top:6px">${esc(link)}</textarea>`
        + `<div class="field-tip">用手机浏览器打开一次即可，之后手机用 ${esc(ONLINE_BASE)} 就够了，不用电脑开机。</div></div>`;
      modal.querySelector('#s-result textarea')?.select?.();
    });

    modal.querySelector('#s-style-clear').addEventListener('click', () => {
      modal.querySelector('#s-style').value = '';
    });

    modal.querySelector('#s-model-fetch').addEventListener('click', async () => {
      const box = modal.querySelector('#s-model-pick');
      box.innerHTML = '<span class="chip">拉取中…</span>';
      const res = await server.models();
      if (!res.ok || !(res.models || []).length) {
        box.innerHTML = '<span class="chip">没拉到模型列表（检查 Key / 地址）</span>';
        return;
      }
      box.innerHTML = res.models.slice(0, 24)
        .map((m) => `<button class="chip" data-pick-model="${esc(m)}">${esc(m)}</button>`).join('');
    });

    modal.querySelector('#s-default-mode').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-dm]');
      if (!chip) return;
      modal.querySelectorAll('#s-default-mode .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
    modal.querySelector('#s-reasoning').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-r]');
      if (!chip) return;
      modal.querySelectorAll('#s-reasoning .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
    modal.querySelector('#s-default-orientation').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-do]');
      if (!chip) return;
      modal.querySelectorAll('#s-default-orientation .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });

    modal.querySelector('#s-model-pick').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-pick-model]');
      if (!chip) return;
      modal.querySelector('#s-model').value = chip.dataset.pickModel;
      ui.toast('已选 ' + chip.dataset.pickModel + '，点保存生效。');
    });

    const showResult = (r) => {
      const box = modal.querySelector('#s-result');
      box.innerHTML = `<div class="diag ${r.ok ? 'ok' : 'bad'}">
        <b>${r.ok ? '✓ 连接正常' : '✕ 连接失败'}</b>
        ${esc(r.message || '')}
        ${r.hint ? `<div style="margin-top:5px">建议：${esc(r.hint)}</div>` : ''}
        ${r.endpoint ? `<div style="margin-top:5px;opacity:.7">请求地址：${esc(r.endpoint)}　模型：${esc(r.model || readForm().model)}</div>` : ''}
        ${r.raw ? `<div class="raw">${esc(r.raw)}</div>` : ''}
      </div>`;
    };

    modal.querySelector('#s-test').addEventListener('click', async () => {
      const f = readForm();
      const box = modal.querySelector('#s-result');
      box.innerHTML = '<div class="diag">正在请求模型，请稍等…</div>';
      const prevApi = localConfig.read().apiKey;
      if (f.key) localConfig.write({ apiKey: f.key });
      const override = f.key ? { ...f, apiKey: f.key, mode: 'direct' } : (f.mode === 'direct' ? { ...f, apiKey: prevApi } : null);
      const r = await testConnection(override && override.apiKey ? override : undefined);
      if (!f.key && !prevApi) localConfig.write({ apiKey: '' });
      showResult(r);
    });

    modal.querySelector('#s-forget')?.addEventListener('click', async () => {
      localConfig.clear();
      if (srv.up) await server.saveConfig({ apiKey: '' });
      state.serverCfg = (await server.getConfig()).config || {};
      await probeServer(true);
      state.lastFailure = null;
      ui.closeModal();
      updateEngineBadge();
      await refreshEngineBanner(true);
      ui.toast('已清除本机保存的 API Key。');
    });

    modal.querySelector('#s-save').addEventListener('click', async () => {
      const f = readForm();
      const patch = {
        baseUrl: f.baseUrl, model: f.model, temperature: f.temperature,
        maxTokens: f.maxTokens, stream: f.stream, jsonMode: f.jsonMode, mode: f.mode
      };
      patch.styleSample = modal.querySelector('#s-style').value.trim();
      patch.defaultMode = modal.querySelector('#s-default-mode .chip.active')?.dataset.dm || 'balanced';
      patch.reasoningEffort = modal.querySelector('#s-reasoning .chip.active')?.dataset.r || 'default';
      patch.defaultOrientation = modal.querySelector('#s-default-orientation .chip.active')?.dataset.do || 'mm';
      if (looksGarbled(patch.styleSample)) {
        ui.toast('⚠ 这段文风样例看起来是乱码（编码不对），已忽略它 —— 请重新复制一段正常的文本。', 'warn');
      }
      if (f.key) patch.apiKey = f.key;
      localConfig.write(patch);
      if (srv.up) await server.saveConfig(patch);
      syncApi.syncConfig.write({
        serverUrl: modal.querySelector('#s-sync-url').value.trim(),
        token: modal.querySelector('#s-sync-token').value.trim(),
        backend: modal.querySelector('#s-sync-backend .chip.active')?.dataset.sb || 'server',
        manual: true,
        gh: (() => {
          const repoStr = modal.querySelector('#s-gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '');
          const [owner, repoName] = repoStr.split('/');
          const ghToken = modal.querySelector('#s-gh-token').value.trim();
          return {
            owner: owner || '',
            repo: repoName || '',
            path: modal.querySelector('#s-gh-path').value.trim() || 'novel.json',
            token: ghToken || syncGh.token || ''
          };
        })()
      });
      await syncApi.initSync();
      state.serverCfg = (await server.getConfig()).config || {};
      await probeServer(true);
      state.health = await server.health();
      state.lastFailure = null;
      state.bannerDismissed = false;
      ui.closeModal();
      updateEngineBadge();
      updateSyncUI();
      if (state.sync.available) runFullSync();
      await refreshEngineBanner(true);
      const has = Boolean(f.key) || Boolean(localConfig.read().apiKey) || state.serverCfg.hasKey;
      ui.toast(has ? '已保存，下一轮开始用真实模型生成。' : '已保存（还没有 Key，仍是本地示例引擎）。');
    });
  });
}

/** 触发下载：必须把 <a> 挂进 DOM，否则 Safari / 部分手机浏览器会静默失败 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

function openData() {
  const synced = state.sync.available;
  const serverUrl = state.sync.kind === 'remote' ? state.sync.serverUrl : location.origin;
  ui.openModal(`
    <h3>数据管理</h3>
    <div class="kvline"><span>剧情档案</span><span>${store.listSessions().length} 条</span></div>
    <div class="kvline"><span>存储位置</span><span>${synced ? esc(serverUrl) + ' 的 data/sessions.json' : '本机浏览器 localStorage'}</span></div>
    <div class="tip">导出的 JSON 包含全部剧情、选项与面板快照，可以在另一台设备导入继续。<br>
      ${synced ? '当前已连上服务，会自动同步。' : '当前没有连上服务，数据只在这台设备上 —— 想搬去另一台设备，用下面的「复制 / 粘贴」。'}</div>
    ${state.session ? '<div class="row"><button class="cancel" id="d-export-txt" style="flex:1">导出当前剧情为 TXT（当小说存下来）</button></div>' : ''}
    <div class="row">
      <button class="cancel" id="d-copy">复制全部到剪贴板</button>
      <button class="cancel" id="d-paste">从剪贴板导入</button>
    </div>
    <div class="row">
      <button class="cancel" id="d-import">导入</button>
      <button class="ok" id="d-export">导出</button>
    </div>
    <div class="row">
      <button class="danger" id="d-clear" style="flex:1">清空全部剧情</button>
    </div>
  `, (modal) => {
    modal.querySelector('#d-export-txt')?.addEventListener('click', () => {
      const s = state.session;
      if (!s) return;
      const out = [s.title, `（共 ${s.rounds.length} 轮 · 导出于 ${new Date().toLocaleString('zh-CN')}）`, ''];
      for (const r of s.rounds) {
        out.push(`—— 第 ${r.i + 1} 轮 · ${r.scene.act} · ${r.scene.time} ${r.scene.phase} ——`);
        if (r.playerAction) out.push(`〔你的行动〕${r.playerAction}`);
        out.push('');
        for (const b of r.blocks || []) {
          out.push(b.type === 'dialogue'
            ? `${b.speaker ? `${b.speaker}：` : ''}“${b.text}”`
            : b.text);
          out.push('');
        }
        if (r.options?.length) out.push(`【本轮的三个走向】${r.options.join(' / ')}`);
        out.push('');
      }
      const blob = new Blob([out.join('\n')], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `${String(s.title).replace(/[\\/:*?"<>|]/g, '_')}.txt`);
      ui.toast('已导出 TXT，在浏览器的下载里。');
    });

    modal.querySelector('#d-copy').addEventListener('click', async () => {
      const text = JSON.stringify(store.exportAll());
      try {
        await navigator.clipboard.writeText(text);
        ui.toast(`已复制 ${store.listSessions().length} 部剧情（${Math.round(text.length / 1024)}KB），发给另一台设备后点「从剪贴板导入」。`);
      } catch {
        ui.toast('复制失败，请改用「导出」下载文件。', 'warn');
      }
    });
    modal.querySelector('#d-paste').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const res = store.importAll(JSON.parse(text));
        renderSessionList();
        if (state.session) enterSession(state.session);
        ui.closeModal();
        ui.toast(`导入完成，新增 ${res.added} 条，共 ${res.total} 条。`);
        if (state.sync.available) runFullSync();
      } catch (err) {
        ui.toast(`导入失败：剪贴板里不是有效的备份内容（${err.message}）`, 'warn');
      }
    });
    modal.querySelector('#d-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
      downloadBlob(blob, `novel-backup-${new Date().toISOString().slice(0, 10)}.json`);
      ui.toast('已导出备份文件。');
    });
    modal.querySelector('#d-import').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const payload = JSON.parse(await file.text());
          const res = store.importAll(payload);
          renderSessionList();
          ui.closeModal();
          ui.toast(`导入完成，新增 ${res.added} 条，共 ${res.total} 条。`);
          if (state.sync.available) runFullSync();
        } catch (err) {
          ui.toast(`导入失败：${err.message}`, 'warn');
        }
      });
      input.click();
    });
    modal.querySelector('#d-clear').addEventListener('click', () => {
      ui.closeModal();
      confirmModal('清空全部剧情？', '所有人的对话、分支与快照都会被删除，无法恢复。', () => {
        localStorage.removeItem('novel.sessions.v1');
        localStorage.removeItem('novel.active.v1');
        state.session = null;
        renderSessionList();
        showEmptyState();
      });
    });
  });
}

function confirmModal(title, desc, onOk) {
  ui.openModal(`
    <h3>${esc(title)}</h3>
    <div class="tip" style="margin:0 0 8px">${esc(desc)}</div>
    <div class="row">
      <button class="cancel" data-close-modal>取消</button>
      <button class="danger" id="c-ok">确定</button>
    </div>
  `, (modal) => {
    modal.querySelector('#c-ok').addEventListener('click', () => {
      ui.closeModal();
      onOk();
    });
  });
}

/* ---------------- go ---------------- */
boot();

window.addEventListener('resize', () => {
  if (window.innerWidth >= 1024) toggleSidebar(false);
});
