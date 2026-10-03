/**
 * app.js — 控制器：串起设定页、对话流、回退分支、面板与设置
 */

import {
  TEMPLATES, EMOTION_PRESETS, LENGTH_PRESETS, TONE_PRESETS, POV_PRESETS,
  PANEL_LIBRARY, makePanel, cloneTemplate, suggestSetupLocal
} from './presets.js';
import { store, newSession } from './store.js';
import * as syncApi from './sync.js';
import {
  generateRound, server, designSetup, testConnection,
  localConfig, PROVIDERS, probeServer, resolveTransport
} from './api.js';
import * as ui from './ui.js';

const $ = ui.$;
const $$ = ui.$$;
const esc = ui.esc;

const INTENSITY = [
  { label: '全年龄', text: '全年龄向，只写情感、张力与氛围，不涉及性描写。' },
  { label: '文学化克制', text: '成人向的文学化描写，重心理与氛围，避免直白的器官词与粗俗表达。' },
  { label: '感官细腻', text: '成人向，允许具体而感官化的身体描写，保持文学质感，不做医学式罗列。' },
  { label: '直白强烈', text: '成人向，允许直白描写与强烈张力，语言可以粗粝；不涉及未成年、真实人物与非自愿的鼓励。' }
];

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
  // 用带令牌的地址打开时（例如内网穿透的公网地址 ?token=xxx），先把它记下来
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) syncApi.syncConfig.write({ token: urlToken.trim() });
  registerServiceWorker();
  bindGlobal();
  bindSetup();
  await bootSync();
  renderSessionList();

  state.health = await server.health();
  const cfg = await server.getConfig();
  state.serverCfg = cfg.config || {};

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

function schedulePush() {
  clearTimeout(pushQueue.timer);
  pushQueue.timer = setTimeout(flushPush, 800);
}

async function flushPush() {
  if (!state.sync.available) return;
  if (!pushQueue.sessions.size && !pushQueue.deleted.size) return;
  const payload = { sessions: Array.from(pushQueue.sessions.values()), deleted: Array.from(pushQueue.deleted) };
  pushQueue.sessions.clear();
  pushQueue.deleted.clear();
  state.sync.busy = true;
  updateSyncUI();
  try {
    await syncApi.push(payload);
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
    const remote = await syncApi.pull();
    const merged = syncApi.mergeSessions(store.listSessions(), remote.sessions || []);
    store.replaceAll(merged);
    // 把本机独有的（比如之前在浏览器里写的）补推上去
    await syncApi.push({ sessions: merged, deleted: [] });
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
    const merged = syncApi.mergeSessions(store.listSessions(), remote.sessions || []);
    store.replaceAll(merged);
    await syncApi.push({ sessions: merged, deleted: [] });
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
    ui.renderEngineBanner({
      kind: 'error',
      text: state.lastFailure,
      action: '去设置'
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
      action: '去设置'
    });
  } else {
    ui.renderEngineBanner(null);
  }
}

function renderSessionList() {
  ui.renderSessionList(store.listSessions(), state.session?.id || null);
}

/** 存到本机 + 排队推到服务器 */
function persist(session) {
  store.saveSession(session);
  queuePush(session);
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
    intensity: INTENSITY[1].text,
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
    topPanels: draft.topPanels.map((p) => makePanel(p)),
    bottomPanels: draft.bottomPanels.map((p) => makePanel(p))
  };
}

function bindSetup() {
  $('#btn-autodesign').addEventListener('click', () => runAutoDesign());
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

  // 若已经回退到中途，先把后续轮次存成分支
  if (s.cursor < s.rounds.length - 1) {
    const tail = s.rounds.slice(s.cursor + 1);
    s.branches = s.branches || [];
    s.branches.push({ at: s.cursor, atTime: Date.now(), rounds: tail });
    s.rounds = s.rounds.slice(0, s.cursor + 1);
  }

  state.generating = true;
  state.activePanel = null;
  ui.closeDrawer();
  ui.renderRounds(s, { interactive: false });
  ui.showTyping();
  if (state.stick) ui.scrollToBottom(false);
  setSendState(true);

  const controller = new AbortController();
  state.abort = controller;

  try {
    const { round, engine, warning } = await generateRound({
      session: s,
      cursor: s.cursor,
      signal: controller.signal,
      onPartial: (blocks) => {
        ui.hideTyping();
        ui.renderStreamingRound(s, blocks);
        followScroll(true);
      }
    });

    round.i = s.cursor + 1;
    round.playerAction = s.pendingAction || '';
    round.createdAt = Date.now();
    s.rounds.push(round);
    s.cursor = s.rounds.length - 1;
    s.pendingAction = '';
    persist(s);

    ui.clearTyping();
    ui.renderRounds(s, { futureCount: 0 });
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
      if (state.lastFailure) {
        state.lastFailure = null;
        await refreshEngineBanner(true);
      }
      if (engine === 'local') ui.toast('本轮由本地示例引擎生成。');
    }
  } catch (err) {
    ui.clearTyping();
    ui.renderRounds(s, { futureCount: 0 });
    if (err.name === 'AbortError') ui.toast('已停止本轮生成。');
    else ui.toast(`生成失败：${err.message}`, 'warn');
  } finally {
    state.generating = false;
    state.abort = null;
    setSendState(false);
    const input = $('[data-input]');
    if (input) { fitTextarea(input); input.focus({ preventScroll: true }); }
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
    if (e.target.closest('[data-banner-action]')) openSettings();
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
  ui.openDrawer(def, round.panels?.[id]);
}

function gotoRound(index) {
  const s = state.session;
  if (!s) return;
  if (index < 0) { ui.toast('已经是第一轮了。'); return; }
  if (index >= s.rounds.length) return;
  s.cursor = index;
  persist(s);
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
  const action = round.playerAction || '';
  s.rounds = s.rounds.slice(0, s.cursor);
  s.cursor = s.rounds.length - 1;
  s.pendingAction = action;
  persist(s);
  ui.renderRounds(s, { interactive: false });
  ui.renderRoundNav(s);
  generate();
}

/* =========================================================
   弹层：时间轴 / 设置 / 数据
   ========================================================= */

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
      <input id="s-model" type="text" value="${esc(model)}" placeholder="deepseek-chat" />
    </div>
    <div class="field-2col">
      <div class="field">
        <label class="field-label">温度</label>
        <input id="s-temp" type="text" value="${esc(String(local.temperature ?? cfg.temperature ?? 1.1))}" />
      </div>
      <div class="field">
        <label class="field-label">最大输出 tokens</label>
        <input id="s-max" type="text" value="${esc(String(local.maxTokens ?? cfg.maxTokens ?? 8000))}" />
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
      <label class="field-label">跨设备同步<span class="field-hint">所有剧情存在跑 server.js 的那台电脑上</span></label>
      <div class="diag" id="s-sync-state"></div>
      <input id="s-sync-url" type="text" value="${esc(syncCfg.serverUrl || '')}" placeholder="http://192.168.1.14:8787（线上版想连回家里时填）" />
      <input id="s-sync-token" type="text" value="${esc(syncCfg.token || '')}" placeholder="同步口令（启动 server.js 时终端会打印）" style="margin-top:8px" />
      <div class="chip-row" style="margin-top:9px">
        <button class="chip" id="s-sync-now">立即同步</button>
      </div>
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
      temperature: Number(modal.querySelector('#s-temp').value) || 1.1,
      maxTokens: Number(modal.querySelector('#s-max').value) || 8000,
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
      syncApi.syncConfig.write({
        serverUrl: modal.querySelector('#s-sync-url').value.trim(),
        token: modal.querySelector('#s-sync-token').value.trim()
      });
      await syncApi.initSync();
      updateSyncUI();
      paintSync();
    };

    modal.querySelector('#s-sync-now').addEventListener('click', async () => {
      await applySyncForm();
      await runFullSync();
      paintSync();
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
      if (f.key) patch.apiKey = f.key;
      localConfig.write(patch);
      if (srv.up) await server.saveConfig(patch);
      syncApi.syncConfig.write({
        serverUrl: modal.querySelector('#s-sync-url').value.trim(),
        token: modal.querySelector('#s-sync-token').value.trim()
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

function openData() {
  const synced = state.sync.available;
  const serverUrl = state.sync.kind === 'remote' ? state.sync.serverUrl : location.origin;
  ui.openModal(`
    <h3>数据管理</h3>
    <div class="kvline"><span>剧情档案</span><span>${store.listSessions().length} 条</span></div>
    <div class="kvline"><span>存储位置</span><span>${synced ? esc(serverUrl) + ' 的 data/sessions.json' : '本机浏览器 localStorage'}</span></div>
    <div class="tip">导出的 JSON 包含全部剧情、选项与面板快照，可以在另一台设备导入继续。<br>
      ${synced ? '当前已连上服务，会自动同步。' : '当前没有连上服务，数据只在这台设备上 —— 想搬去另一台设备，用下面的「复制 / 粘贴」。'}</div>
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
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `novel-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
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
