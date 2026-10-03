/**
 * prompt.js — 提示词构建 + 模型输出解析（含流式增量解析）
 */

const JSON_SPEC = `{
  "scene": {
    "act": "第N幕 · 幕名（4-8字）",
    "location": "场景地点，可含分隔符 ·",
    "time": "剧内时间，如 00:22",
    "phase": "时段或状态，如 深夜 / 潮湿 / 压抑爆发"
  },
  "memory": "截至目前剧情的滚雪球摘要，200字以内，会作为下一轮的长期记忆",
  "emotions": { "情感名": 0到100的整数 },
  "blocks": [
    { "type": "tag", "text": "[地点 · 场景 · 状态]" },
    { "type": "narration", "text": "旁白段落，一段一个元素，不要换行符" },
    { "type": "dialogue", "speaker": "角色名", "text": "角色台词，不含引号" }
  ],
  "options": ["选项一", "选项二", "选项三"],
  "panels": { "面板id": "该面板的内容" }
}`;

function panelBlock(panels, scope) {
  if (!panels || !panels.length) return '';
  const lines = panels.map((p) => {
    const kind =
      p.kind === 'list' ? '字符串数组，每条 8-24 字，可用 [来源]: 前缀'
        : p.kind === 'kv' ? '对象数组 [{"k":"标题","v":"内容"}]，3-5 项'
          : '一段 40-120 字的文字';
    return `- key "${p.id}"（${p.label}）：${p.hint}\n  该面板的数据格式：${kind}`;
  });
  return `\n【${scope}】下面是固定面板，必须每一项都填：\n${lines.join('\n')}\n`;
}

export function buildSystemPrompt(setup) {
  const emotions = (setup.emotions || []).join('、');
  const lengthHint = setup.lengthHint || '控制在 350-500 字，有场景与对白。';
  return `你是「Novel」的导演引擎 —— 一位功力深厚的中文互动小说作者，负责推进一部沉浸式文字剧情。

【世界观与剧情设定】
${setup.scenario || '（未指定，请按你自己的判断构建一个自洽且迷人的世界）'}

【玩家扮演】
${setup.userRole || '（未指定，按剧情合理设定）'}

【核心角色】
${setup.targetRole || '（未指定，按剧情合理设定）'}

【开场状态】
${setup.opening || '（未指定，请自行写出一个有力的开场）'}

【叙事风格】${setup.tone || '沉浸式小说'}
【叙事视角】${setup.pov || '第二人称（你用……）'}
【单轮篇幅】${lengthHint}
【内容尺度】${setup.intensity || '成人向的文学化描写，重心理与氛围，避免直白的器官词与粗俗表达'}

【情感指标】${emotions}
情感值范围 0-100 的整数，只随剧情因果变化，不要无理由跳变。上一轮的数值会给你参考。

【写作要求】
1. 每一轮都要推进剧情：出现新的信息、新的动作或新的关系变化，禁止原地复述。
2. blocks 是这一轮的正文，用 3-6 个元素组成：先一个 tag 交代场景，然后旁白与对白交替。对白要有个性、有潜台词，可以直接引用角色原话。
3. 严格遵守【叙事视角】。
4. 描写要具体、有画面感、有生理与心理细节，避免陈词滥调与总结式抒情。
5. options 必须给出三个「方向明显不同」的下一步行动，每条 10-24 字，用动词开头，能让玩家立刻做出判断；三条之间不要只是程度差异。
6. 玩家可能会无视选项、自己输入行动 —— 你必须在逻辑上无缝承接玩家的输入，绝不跳戏。
7. panels 的内容要克制：列表 3-5 条、每条不超过 30 字，卡片 3-4 组，文字面板不超过 120 字。整个 JSON 总量控制在 2500 字以内，宁可精炼也不要写长导致被截断。

${panelBlock(setup.topPanels, '顶部面板')}${panelBlock(setup.bottomPanels, '底部面板')}

【输出格式】只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字。结构如下：
${JSON_SPEC}

注意：
- panels 里必须包含上面列出的每一个 key，值直接是内容本身（字符串 / 字符串数组 / {k,v} 数组），不要嵌套额外的说明层。
- blocks 中的 text 内部不要出现换行符。
- 只写 JSON，第一个字符必须是 {，最后一个字符必须是 }。`;
}

function blocksToText(blocks) {
  return (blocks || [])
    .map((b) => {
      if (b.type === 'dialogue') return `${b.speaker ? b.speaker + '：' : ''}“${b.text}”`;
      return b.text;
    })
    .join('\n');
}

export function buildMessages(session, cursor) {
  const setup = session.setup;
  const rounds = session.rounds.slice(0, cursor + 1);
  const system = buildSystemPrompt(setup);
  const messages = [{ role: 'system', content: system }];

  const memory = rounds.length ? rounds[rounds.length - 1].memory : '';
  const recent = rounds.slice(-4);
  const transcript = recent
    .map((r) => {
      const action = r.playerAction ? `\n〔玩家的行动〕${r.playerAction}` : '';
      return `—— 第 ${r.i + 1} 轮（${r.scene.act}｜${r.scene.time} ${r.scene.phase}）——\n${blocksToText(r.blocks)}${action}`;
    })
    .join('\n\n');

  const last = rounds[rounds.length - 1];
  const state = last
    ? `\n【上一轮结束时的情感值】${JSON.stringify(last.emotions)}`
    : '\n【这是第一轮】请写出开场，结束在玩家必须做出选择的那一刻。';

  const action = session.pendingAction;
  const actionLine = action
    ? `\n【玩家本轮的输入】${action}\n请严格承接玩家的这个输入继续推进。`
    : rounds.length
      ? '\n【玩家本轮的输入】玩家尚未给出明确行动，请你主动推进一小步，把球重新交回玩家手里。'
      : '';

  messages.push({
    role: 'user',
    content:
      `【长期记忆】${memory || '（暂无，这是开场）'}` +
      (transcript ? `\n\n【最近剧情】\n${transcript}` : '') +
      state +
      actionLine +
      `\n\n现在请输出第 ${rounds.length + 1} 轮的 JSON。`
  });
  return messages;
}

/* ---------------- 让导演自己设计界面 ---------------- */

export function buildDesignerMessages(draft) {
  const system = `你是「Novel」的文字剧情产品设计师。用户会给你一份剧情设定，你要为这部剧情量身设计界面上的按钮与情感指标。

设计原则：
1. 按钮必须贴着这部剧情的具体内容，不要用通用词。同样是"看情绪"，校园题材叫「心事」，宫廷题材叫「眉眼官司」，直播题材叫「弹幕」。
2. 顶部按钮放"随时想查的设定"（人设卡、分幕地图、线索、名册），3 个。
3. 底部按钮放"跟着剧情实时变动的反馈"，4-5 个。必须包含一个 kind 为 notes 的「思路/幕后」类按钮，用来给玩家注入自己的走向。
4. hint 是写给导演引擎的指令，要说清楚这个面板里该放什么、什么格式、多少条，写具体。
   每条 hint 不超过 60 字，面板内容也要克制，避免生成时被截断。
5. 情感指标 5 个，要能真实反映这部剧情里双方关系的走向，别永远是好感度那一套。

只输出 JSON，不要解释，第一个字符必须是 {。结构：
{
  "title": "8字以内的剧情名",
  "emotions": ["指标1","指标2","指标3","指标4","指标5"],
  "topPanels": [{"label":"按钮名","kind":"text|list|kv|notes","hint":"给导演的指令"}],
  "bottomPanels": [{"label":"按钮名","kind":"text|list|kv|notes","hint":"给导演的指令"}]
}`;

  const user = `【题材模板】${draft.templateName || '自定义'}
【世界观与剧情设定】
${draft.scenario || '（用户还没写，请根据角色信息合理推断一个世界）'}

【玩家扮演】${draft.userRole || '（未指定）'}
【核心角色】${draft.targetRole || '（未指定）'}
【开场状态】${draft.opening || '（未指定）'}
【叙事风格】${draft.tone || '沉浸式小说'}；【尺度】${draft.intensity || '成人向的文学化描写'}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${user}\n\n请为这部剧情设计界面。` }
  ];
}

const KINDS = ['text', 'list', 'kv', 'notes'];

function panelId(label, index) {
  const slug = String(label || '').replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 8);
  return `p${index}_${slug || 'panel'}`;
}

function coercePanelList(raw, offset) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  list.forEach((item, i) => {
    if (!item) return;
    const label = String(typeof item === 'string' ? item : item.label || item.name || '').trim();
    if (!label) return;
    const kind = KINDS.includes(item?.kind) ? item.kind : 'text';
    out.push({
      id: panelId(label, offset + i),
      label: label.slice(0, 12),
      kind,
      hint: String(item?.hint || item?.desc || '').trim() || `按当前剧情生成「${label}」应当展示的内容。`
    });
  });
  return out;
}

export function normalizeDesign(raw) {
  const emotions = (Array.isArray(raw.emotions) ? raw.emotions : [])
    .map((e) => String(e || '').trim())
    .filter(Boolean)
    .slice(0, 6);
  const bottom = coercePanelList(raw.bottomPanels, 20);
  if (bottom.length && !bottom.some((p) => p.kind === 'notes')) {
    bottom[bottom.length - 1].kind = 'notes';
  }
  return {
    title: String(raw.title || '').trim().slice(0, 20),
    emotions: emotions.length ? emotions : null,
    topPanels: coercePanelList(raw.topPanels, 10),
    bottomPanels: bottom
  };
}

/* ---------------- 解析 ---------------- */

function stripFences(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

export function extractJson(text) {
  const raw = stripFences(text);
  if (!raw) throw new Error('模型返回为空');

  const start = raw.indexOf('{');
  if (start < 0) throw new Error('未找到 JSON 起始符');

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return JSON.parse(repair(slice));
        }
      }
    }
  }
  // 走到这里说明括号没闭合（多半是被 max_tokens 截断）——尽力抢救已经写出来的部分
  try {
    return JSON.parse(repair(raw.slice(start)));
  } catch {
    throw new Error('模型输出被截断且无法解析，请把「最大输出 tokens」调大后重试');
  }
}

function repair(slice) {
  const out = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (esc) { out.push(ch); esc = false; continue; }
    if (ch === '\\') { out.push(ch); esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out.push(ch); continue; }
    if (inStr) {
      if (ch === '\n') out.push('\\n');
      else if (ch === '\r') continue;
      else if (ch === '\t') out.push('\\t');
      else if (ch.charCodeAt(0) < 0x20) out.push(' ');
      else out.push(ch);
    } else {
      out.push(ch);
    }
  }
  let text = out.join('');
  text = text.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  text = text.replace(/,\s*$/, '');
  text = text.replace(/,\s*([}\]])/g, '$1');
  let braces = 0;
  let brackets = 0;
  let str = false;
  let e = false;
  for (const ch of text) {
    if (e) { e = false; continue; }
    if (ch === '\\') { e = true; continue; }
    if (ch === '"') { str = !str; continue; }
    if (str) continue;
    if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
  }
  if (str) text += '"';
  while (brackets-- > 0) text += ']';
  while (braces-- > 0) text += '}';
  return text;
}

/** 流式增量解析：从半截 JSON 里尽力抽出已经完整的 block */
export function partialBlocks(buffer) {
  const idx = buffer.indexOf('"blocks"');
  if (idx < 0) return [];
  const open = buffer.indexOf('[', idx);
  if (open < 0) return [];

  const out = [];
  let i = open + 1;
  while (i < buffer.length) {
    while (i < buffer.length && /[\s,\]]/.test(buffer[i])) {
      if (buffer[i] === ']') return out;
      if (/[\s,]/.test(buffer[i])) i += 1;
      else return out;
    }
    if (buffer[i] !== '{') break;
    const end = findObjectEnd(buffer, i);
    if (end < 0) break;
    try {
      const obj = JSON.parse(repair(buffer.slice(i, end + 1)));
      if (obj && obj.type) out.push(obj);
    } catch { /* 跳过残缺对象 */ }
    i = end + 1;
  }
  return out;
}

function findObjectEnd(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ---------------- 归一化 ---------------- */

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

function coerceBlocks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const blocks = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (item.trim()) blocks.push({ type: 'narration', text: item.trim() });
      continue;
    }
    const type = ['tag', 'narration', 'dialogue', 'note'].includes(item.type) ? item.type : 'narration';
    const text = String(item.text ?? item.content ?? '').replace(/\r?\n+/g, ' ').trim();
    if (!text) continue;
    blocks.push(type === 'dialogue'
      ? { type, speaker: String(item.speaker || '').trim(), text }
      : { type, text });
  }
  return blocks;
}

function coerceEmotions(raw, keys) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of keys) {
    const hit = src[key] ?? Object.entries(src).find(([k]) => k.includes(key) || key.includes(k))?.[1];
    out[key] = clamp(hit);
  }
  return out;
}

function coerceOptions(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const options = list
    .map((o) => (typeof o === 'string' ? o : o?.text || o?.label || ''))
    .map((s) => String(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const fallback = ['继续观察他的反应，等他自己开口', '保持沉默，把节奏压住', '直接推进到下一步'];
  const out = options.slice(0, 3);
  while (out.length < 3) out.push(fallback[out.length]);
  return out;
}

function coercePanelValue(value, kind) {
  if (value === null || value === undefined) return kind === 'list' ? [] : kind === 'kv' ? [] : '';
  if (kind === 'list') {
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : v?.text || JSON.stringify(v))).filter(Boolean);
    if (typeof value === 'string') return value.split(/\n+/).map((s) => s.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
    return [String(value)];
  }
  if (kind === 'kv') {
    if (Array.isArray(value)) {
      return value.map((v) => (v && typeof v === 'object' ? { k: String(v.k ?? v.key ?? v.标题 ?? ''), v: String(v.v ?? v.value ?? v.内容 ?? '') } : { k: '', v: String(v) })).filter((x) => x.k || x.v);
    }
    if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => ({ k, v: String(v) }));
    return [{ k: '', v: String(value) }];
  }
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}：${v}`).join('\n');
  return String(value);
}

export function normalizeRound(raw, session, prevEmotions) {
  const setup = session.setup;
  const emotionKeys = setup.emotions;
  const sceneRaw = raw.scene && typeof raw.scene === 'object' ? raw.scene : {};
  const last = session.rounds[session.rounds.length - 1];
  const scene = {
    act: String(sceneRaw.act || last?.scene.act || '第一幕').slice(0, 24),
    location: String(sceneRaw.location || last?.scene.location || setup.opening || '').slice(0, 40),
    time: String(sceneRaw.time || last?.scene.time || '00:00').slice(0, 12),
    phase: String(sceneRaw.phase || last?.scene.phase || '深夜').slice(0, 20)
  };

  const panels = {};
  const rawPanels = raw.panels && typeof raw.panels === 'object' ? raw.panels : {};
  for (const def of [...(setup.topPanels || []), ...(setup.bottomPanels || [])]) {
    const value = rawPanels[def.id] ?? rawPanels[def.label];
    panels[def.id] = coercePanelValue(value, def.kind);
  }

  return {
    scene,
    memory: String(raw.memory || last?.memory || '').slice(0, 400),
    emotions: coerceEmotions(raw.emotions, emotionKeys),
    prevEmotions: { ...prevEmotions },
    blocks: coerceBlocks(raw.blocks),
    options: coerceOptions(raw.options),
    panels
  };
}

export { blocksToText };
