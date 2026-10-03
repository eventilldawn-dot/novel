/**
 * ui.js — 纯渲染层：把会话数据变成 DOM
 */

import { EMOTION_PALETTE } from './presets.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function emotionColor(index) {
  return EMOTION_PALETTE[index % EMOTION_PALETTE.length].color;
}

/* ---------------- HUD ---------------- */

export function renderHUD(session) {
  const round = session.rounds[session.cursor];
  const actEl = $('#act-name');
  const metaEl = $('#act-meta');
  if (!round) {
    actEl.textContent = session.rounds.length ? '（已回到开头）' : '尚未开始';
    metaEl.textContent = '';
  } else {
    actEl.textContent = `${round.scene.act}`;
    metaEl.textContent = `${round.scene.time} · ${round.scene.phase}`;
  }
  renderEmotions(session, round);
}

export function renderEmotions(session, round) {
  const strip = $('#emotion-strip');
  const keys = session.setup.emotions;
  strip.innerHTML = keys.map((key, i) => {
    const value = round ? Number(round.emotions[key] ?? 0) : 0;
    const prev = round ? Number(round.prevEmotions?.[key] ?? value) : 0;
    const delta = value - prev;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '—';
    const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    return `<div class="emo" style="--c:${emotionColor(i)}" data-key="${esc(key)}">
      <div class="emo-top">
        <span class="emo-label">${esc(key)}</span>
        <span class="emo-val">${round ? value : '—'}</span>
        <span class="emo-arrow ${cls}">${round ? arrow : ''}</span>
      </div>
      <i class="emo-bar"><b style="width:${round ? value : 0}%"></b></i>
    </div>`;
  }).join('');
}

export function flashEmotions() {
  $$('.emo').forEach((el) => {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });
}

/* ---------------- 正文 ---------------- */

function blockHTML(block) {
  const text = esc(block.text);
  if (block.type === 'tag') return `<div class="block tag">${text}</div>`;
  if (block.type === 'dialogue') {
    const speaker = block.speaker ? `<span class="speaker">${esc(block.speaker)}</span> ` : '';
    return `<div class="block dialogue">${speaker}“${text}”</div>`;
  }
  if (block.type === 'note') return `<div class="block tag">${text}</div>`;
  return `<div class="block narration">${text}</div>`;
}

export function roundHTML(round, index, opts = {}) {
  const { isLast = false, streaming = false, interactive = true, futureCount = 0 } = opts;
  const first = index === 0 ? ' first' : '';
  const action = round.playerAction
    ? `<div class="player-action">${esc(round.playerAction)}</div>`
    : '';
  const body = (round.blocks || []).map(blockHTML).join('');
  const cursor = streaming ? '<span class="cursor"></span>' : '';

  let composer = '';
  if (isLast && interactive && !streaming && round.options) {
    const options = (round.options || []).map((opt, i) => `
      <button class="option-card" data-option="${i}">
        <span class="opt-idx">${'ABC'[i] || i + 1}</span>
        <span>${esc(opt)}</span>
      </button>`).join('');
    const futureNote = futureCount > 0
      ? `<div class="branch-note">后面还有 ${futureCount} 轮旧剧情，继续对话会从这里分出一条新的线（旧的会自动存进时间轴）。</div>`
      : '';
    composer = `
      <div class="composer" data-composer>
        ${futureNote}
        <div class="options">${options}</div>
        <div class="input-wrap">
          <textarea rows="1" data-input placeholder="或者，自己决定接下来的走向…"></textarea>
          <div class="input-foot">
            <span class="input-tip">Enter 发送 · Shift + Enter 换行</span>
            <button class="send-btn" data-send>发送</button>
          </div>
        </div>
        <div class="tool-row">
          <button class="tool-btn" data-act="regenerate">↻ 换一批走向</button>
          <button class="tool-btn" data-act="rewind">↩ 回退一轮</button>
          <button class="tool-btn" data-act="timeline">☰ 时间轴</button>
          ${round.engine === 'local' ? '<span class="tool-btn" style="cursor:default;border-style:dashed">本地示例引擎</span>' : ''}
        </div>
      </div>`;
  }

  const badge = round.engine === 'local' ? '<span class="round-badge">示例引擎</span>' : '';
  return `<div class="round${first}" data-i="${index}">
    <div class="round-divider">第 ${index + 1} 轮${badge}</div>
    ${action}${body}${cursor}${composer}
  </div>`;
}

export function renderRounds(session, opts = {}) {
  const host = $('#rounds');
  const stage = $('#stage');
  const keepTop = stage.scrollTop;
  const wasAtBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 90;
  const visible = session.rounds.slice(0, session.cursor + 1);
  if (!visible.length && !opts.placeholder) {
    host.innerHTML = `<div class="empty-state">
      <h2>剧情还没有开始</h2>
      <p>写下你的第一句行动，导演会立刻为这一幕开场。</p>
    </div>`;
    $('#jump-bottom') && setJumpButton(false);
    return;
  }
  host.innerHTML = visible.map((r, i) => roundHTML(r, i, {
    isLast: i === visible.length - 1,
    streaming: opts.streaming && i === visible.length - 1,
    interactive: opts.interactive !== false,
    futureCount: opts.futureCount || 0
  })).join('');
  // 重绘后把阅读位置还回去：正在往上翻的人不该被弹走
  if (!wasAtBottom) stage.scrollTop = keepTop;
}

/** 生成中把输入区锁住（不整体重绘，避免画面跳动） */
export function lockComposer(lock) {
  const composer = $('[data-composer]');
  if (!composer) return;
  composer.classList.toggle('locked', Boolean(lock));
  composer.querySelectorAll('.option-card, textarea, .tool-btn').forEach((el) => { el.disabled = Boolean(lock); });
  const send = composer.querySelector('[data-send]');
  if (send) send.disabled = false;   // 生成中保留「停止」
}

/** 流式生成时的临时正文（只更新最后一个 round 的 blocks） */
export function renderStreamingRound(session, blocks) {
  const host = $('#rounds');
  const last = host.querySelector('.round:last-child');
  const html = blocks.map(blockHTML).join('');
  if (last && last.dataset.streaming === '1') {
    const holder = last.querySelector('[data-stream-body]');
    if (holder) { holder.innerHTML = html; return; }
  }
  const div = document.createElement('div');
  div.className = 'round';
  div.dataset.streaming = '1';
  div.innerHTML = `<div class="round-divider">第 ${session.cursor + 2} 轮</div>
    <div data-stream-body>${html}</div><span class="cursor"></span>`;
  host.appendChild(div);
}

export function showTyping() {
  const host = $('#rounds');
  if (host.querySelector('[data-typing]')) return;
  const div = document.createElement('div');
  div.dataset.typing = '1';
  div.className = 'typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  host.appendChild(div);
}

export function hideTyping() {
  $$('#rounds [data-typing]').forEach((el) => el.remove());
}

export function clearTyping() {
  hideTyping();
  $$('#rounds [data-streaming]').forEach((el) => el.remove());
}

export function scrollToBottom(smooth = true) {
  const stage = $('#stage');
  stage.scrollTo({ top: stage.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/** 用户是不是还在底部（或者离底部很近） */
export function isNearBottom(threshold = 90) {
  const stage = $('#stage');
  return stage.scrollHeight - stage.scrollTop - stage.clientHeight < threshold;
}

/** 「有新内容 ↓」按钮 */
export function setJumpButton(visible) {
  const btn = $('#jump-bottom');
  if (!btn) return;
  btn.hidden = !visible;
}

/* ---------------- 顶栏 / 底栏 / 导航 ---------------- */

export function renderTopActions(setup, activeId) {
  const host = $('#top-actions');
  const panels = setup.topPanels || [];
  host.innerHTML = panels.map((p) => `
    <button class="mini-btn${activeId === p.id ? ' active' : ''}" data-panel="${esc(p.id)}">${esc(p.label)}</button>
  `).join('') + `<button class="mini-btn" data-open-writing title="修改本剧的尺度与写作指令">✍ 写作</button>`
    + `<button class="mini-btn" data-open-settings title="设置">⚙</button>`;
}

export function renderBottombar(setup, activeId) {
  const host = $('#bottombar');
  const panels = setup.bottomPanels || [];
  host.classList.toggle('empty', panels.length === 0);
  host.innerHTML = panels.map((p) => `
    <button class="bottom-btn${activeId === p.id ? ' active' : ''}" data-panel="${esc(p.id)}">${esc(p.label)}</button>
  `).join('');
}

export function renderRoundNav(session) {
  const nav = $('#round-nav');
  const total = session.rounds.length;
  nav.hidden = total === 0;
  $('#nav-count').textContent = `${session.cursor + 1} / ${total}`;
  $('#nav-prev').disabled = session.cursor <= 0;
  $('#nav-next').disabled = session.cursor >= total - 1;
  $('#nav-count').title = session.branches?.length ? `已保存 ${session.branches.length} 条分支` : '查看时间轴';
}

/* ---------------- 抽屉 ---------------- */

function renderPanelBody(def, value) {
  if (def.kind === 'list') {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) return '<div class="drawer-empty">这一项还没有内容。</div>';
    return `<ul>${items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`;
  }
  if (def.kind === 'kv') {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) return '<div class="drawer-empty">这一项还没有内容。</div>';
    return `<div class="kv-grid">${items.map((it) => `
      <div class="kv"><div class="k">${esc(it.k)}</div><div class="v">${esc(it.v)}</div></div>
    `).join('')}</div>`;
  }
  const text = String(value || '').trim();
  if (!text) return '<div class="drawer-empty">这一项还没有内容。</div>';
  return text.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('');
}

export function openDrawer(def, value) {
  const drawer = $('#drawer');
  $('#drawer-title').textContent = def.label;
  $('#drawer-body').innerHTML = renderPanelBody(def, value);
  const foot = $('#drawer-foot');
  if (def.kind === 'notes') {
    foot.hidden = false;
    foot.innerHTML = `
      <input type="text" data-idea-input placeholder="把自己的思路写给导演…" />
      <button data-idea-send>注入</button>`;
  } else {
    foot.hidden = true;
    foot.innerHTML = '';
  }
  drawer.hidden = false;
}

export function closeDrawer() {
  $('#drawer').hidden = true;
  $$('.bottom-btn.active, .mini-btn.active').forEach((b) => b.classList.remove('active'));
}

/* ---------------- 弹层 / 提示 ---------------- */

export function openModal(html, onMount) {
  const root = $('#modal-root');
  $('#modal').innerHTML = html;
  root.hidden = false;
  if (onMount) onMount($('#modal'));
}

export function closeModal() {
  $('#modal-root').hidden = true;
  $('#modal').innerHTML = '';
}

let toastTimer = null;
export function toast(message, kind) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${kind === 'warn' ? ' warn' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'warn' ? 5200 : 2800);
}

/* ---------------- 引擎状态横幅 ---------------- */

export function renderEngineBanner(info) {
  const el = $('#engine-banner');
  if (!el) return;
  if (!info) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.className = `engine-banner ${info.kind || 'info'}`;
  el.innerHTML = `
    <span class="banner-text">${esc(info.text)}</span>
    ${info.action ? `<button class="banner-btn" data-banner-action>${esc(info.action)}</button>` : ''}
    <button class="banner-close" data-banner-close title="收起">✕</button>`;
}

/* ---------------- 侧栏 ---------------- */

export function renderSessionList(sessions, activeId) {
  const host = $('#session-list');
  if (!sessions.length) {
    host.innerHTML = '<div class="drawer-empty" style="padding:10px">还没有剧情档案</div>';
    return;
  }
  host.innerHTML = sessions.map((s) => `
    <button class="session-item${s.id === activeId ? ' active' : ''}" data-session="${esc(s.id)}">
      <span class="session-emoji">${esc(s.setup.emoji || '✦')}</span>
      <span class="session-meta">
        <span class="session-title">${esc(s.title)}</span>
        <span class="session-sub">${s.rounds.length} 轮 · ${new Date(s.updatedAt || s.createdAt).toLocaleDateString('zh-CN')}</span>
      </span>
      <span class="session-del" data-del="${esc(s.id)}">✕</span>
    </button>`).join('');
}

export function renderSyncBar(info) {
  const bar = $('#sync-bar');
  if (!bar) return;
  if (!info) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.className = `sync-bar ${info.status || ''}`;
  bar.title = info.title || '';
  bar.querySelector('.sync-text').textContent = info.text;
}

/* ---------------- 同步 / 存储状态 ---------------- */

export function renderSyncStatus({ kind, error, busy, count, serverUrl, storagePath = '本机浏览器的 localStorage' }) {
  const map = {
    server: { cls: 'synced', dot: '☁', text: '已同步 · 存在本机服务' },
    remote: { cls: 'synced', dot: '☁', text: '已同步 · 远程服务' },
    local: { cls: '', dot: '▣', text: '仅本机浏览器' }
  };
  const base = map[kind] || map.local;
  let status = base.cls;
  let text = base.text;
  if (error) { status = 'error'; text = `同步失败：${error}`; }
  else if (busy) { status = 'syncing'; text = '同步中…'; }
  else if (kind !== 'local' && count) { text = `${base.text} · ${count} 部剧情`; }

  renderSyncBar({
    status,
    text,
    title: kind === 'local'
      ? '剧情存在这台设备的浏览器里，换设备看不到。启动电脑上的 server.js 后改为跨设备同步。'
      : `所有剧情保存在服务上（${serverUrl || '当前地址'}），同一服务的设备共用一份。`
  });

  return {
    kind,
    error,
    busy,
    count,
    serverUrl,
    storage: kind === 'local' ? storagePath : `${serverUrl || '当前站点'} → data/sessions.json`
  };
}
