// sheet.js — 人设卡（角色卡）的字段定义与组装
//
// 结构：一个玩家角色（me） + 若干「核心角色」（cast，可 1~5 个副主角/攻略对象）
//       + 总体关系（relation） + 世界与剧情（world） + 开场（opening）

export const ME_FIELDS = [
  { key: 'gender', label: '性别', ph: '男', rows: 1 },
  { key: 'name', label: '姓名 / 代号', ph: '例：沈砚，巡捕房翻译', rows: 1 },
  { key: 'identity', label: '身份 · 职业', ph: '例：表面是翻译，实为潜伏的暗线', rows: 2 },
  { key: 'look', label: '外貌 · 体型 · 穿着', ph: '身高体型、脸、常穿什么、身上有什么记号', rows: 2 },
  { key: 'personality', label: '性格 · 说话方式', ph: '遇到事的第一反应、习惯语气、口癖', rows: 3 },
  { key: 'want', label: '想要什么 · 现在的处境', ph: '目的是什么，为什么非要这么做', rows: 2 },
  { key: 'note', label: '其他设定', ph: '身体状态、癖好、不愿被人知道的秘密', rows: 2 }
];

export const CAST_FIELDS = [
  { key: 'gender', label: '性别', ph: '男', rows: 1 },
  { key: 'name', label: '姓名 / 代号 · 身份', ph: '例：Arthur · 王国骑士', rows: 2 },
  { key: 'face', label: '发色 · 发型 · 瞳色 · 面容', ph: '例：麦浪般的浅金短发、晴空般蔚蓝的眼睛、有颗小虎牙', rows: 2 },
  { key: 'body', label: '体型 · 肤色 · 独特标志', ph: '身高、结实还是精瘦、晒成的蜜色、疤/痣/纹身/小动作', rows: 2 },
  { key: 'outfit', label: '着装（分场景）', ph: '日常穿什么、正式场合穿什么、战斗或特殊场合穿什么', rows: 3 },
  { key: 'drive', label: '性格核心 · 驱动力', ph: '他最在乎什么、什么是他绝不会让步的', rows: 2 },
  { key: 'behavior', label: '行为表现', ph: '遇到具体情境他会怎么做，越具体越好', rows: 3 },
  { key: 'metaphor', label: '用一句话比喻他', ph: '例：像一只执拗的护卫犬 / 一座行走的人型灯塔', rows: 1 },
  { key: 'speech', label: '说话方式 · 情绪外显', ph: '音色语速；开心时、愤怒时、紧张时分别什么样', rows: 3 },
  { key: 'past', label: '过往经历（塑造了他）', ph: '什么经历让他变成现在这样', rows: 3 },
  { key: 'weakness', label: '软肋 · 渴望 · 失控点', ph: '怕什么、想要什么、什么话会让他破防', rows: 3 },
  { key: 'habit', label: '日常行为习惯', ph: '独处时做什么、紧张时的小动作、生活方式', rows: 3 },
  { key: 'relation', label: '与「我」的关系', ph: '他把你的角色当成什么人，现在是什么状态', rows: 2 }
];

export const RELATION_FIELDS = [
  { key: 'core', label: '这层关系的核心（一句话）', ph: '例：自愿人质与被囚禁者 / 导演与被拍摄者', rows: 1 },
  { key: 'origin', label: '关系是怎么开始的', ph: '起因、契约、交易、意外 —— 把来龙去脉写清楚', rows: 3 },
  { key: 'now', label: '现在的局面', ph: '表面上是什么关系，实际上是什么关系', rows: 3 },
  { key: 'tension', label: '张力与禁忌', ph: '什么话题不能碰、什么行为会引爆、他最怕我说什么', rows: 3 }
];

export const WORLD_FIELDS = [
  { key: 'setting', label: '世界观 · 时代 · 地点', ph: '例：1937 年上海租界', rows: 2 },
  { key: 'situation', label: '当下处境', ph: '眼下正在发生什么，双方为什么会在同一场景', rows: 2 },
  { key: 'conflict', label: '主线冲突', ph: '他想要什么、什么在挡着他，代价是什么', rows: 3 },
  { key: 'rules', label: '规则 · 限制 · 代价', ph: '这个世界或这段关系里不能违反的东西', rows: 3 }
];

/** 兼容旧代码：引用 SHEET_SCHEMA.me / .relation / .world */
export const SHEET_SCHEMA = { me: ME_FIELDS, relation: RELATION_FIELDS, world: WORLD_FIELDS };

export const MAX_CAST = 5;

export function emptyCastCard() {
  const card = {};
  for (const f of CAST_FIELDS) card[f.key] = '';
  return card;
}

export function emptySheet() {
  const out = { idea: '', mode: 'balanced', orientation: 'mm', opening: '', cast: [emptyCastCard()] };
  for (const [group, fields] of Object.entries(SHEET_SCHEMA)) {
    out[group] = {};
    for (const f of fields) out[group][f.key] = '';
  }
  return out;
}

function fillFields(target, src, fields) {
  for (const f of fields) {
    const v = src?.[f.key];
    if (typeof v === 'string') target[f.key] = v.trim();
    else if (v !== undefined && v !== null && typeof v !== 'object') target[f.key] = String(v).trim();
  }
}

export function normalizeSheet(raw) {
  const base = emptySheet();
  if (!raw || typeof raw !== 'object') return base;

  if (typeof raw.idea === 'string') base.idea = raw.idea.trim();
  if (typeof raw.mode === 'string') base.mode = raw.mode;
  if (typeof raw.orientation === 'string') base.orientation = raw.orientation;
  if (typeof raw.opening === 'string') base.opening = raw.opening.trim();

  for (const [group, fields] of Object.entries(SHEET_SCHEMA)) fillFields(base[group], raw[group] || {}, fields);

  // 核心角色：新结构是 cast 数组；老数据是单个 them 对象，自动迁移
  let cards = [];
  if (Array.isArray(raw.cast)) cards = raw.cast;
  else if (raw.them && typeof raw.them === 'object') cards = [raw.them];
  else if (raw.cast && typeof raw.cast === 'object') cards = [raw.cast];

  const cleaned = cards
    .filter((c) => c && typeof c === 'object')
    .slice(0, MAX_CAST)
    .map((c) => {
      const card = emptyCastCard();
      fillFields(card, c, CAST_FIELDS);
      return card;
    });
  base.cast = cleaned.length ? cleaned : [emptyCastCard()];
  return base;
}

function section(title, fields, group) {
  const lines = fields
    .map((f) => [f.label, (group[f.key] || '').trim()])
    .filter((pair) => pair[1])
    .map((pair) => pair[0] + '：' + pair[1]);
  return lines.length ? '【' + title + '】\n' + lines.join('\n') : '';
}

/** 把角色卡拆成"我 / 对象 / 关系 / 世界"几段文本，回填到设定页的对应字段 */
export function sheetToSetupParts(sheet) {
  const s = normalizeSheet(sheet);
  const castText = s.cast
    .map((card, i) => {
      const title = card.name ? `核心角色 ${i + 1}：${card.name}` : `核心角色 ${i + 1}`;
      return section(title, CAST_FIELDS, card);
    })
    .filter(Boolean)
    .join('\n\n');
  const withRelation = [
    castText,
    section('两人的关系', RELATION_FIELDS, s.relation)
  ].filter(Boolean).join('\n\n');

  return {
    userRole: section('我的角色', ME_FIELDS, s.me),
    targetRole: withRelation,
    scenario: section('世界与剧情', WORLD_FIELDS, s.world) || s.idea,
    idea: s.idea,
    opening: s.opening
  };
}

export function sheetIsEmpty(sheet) {
  const s = normalizeSheet(sheet);
  let n = (s.opening || '').trim().length;
  for (const [group, fields] of Object.entries(SHEET_SCHEMA)) {
    for (const f of fields) n += (s[group][f.key] || '').trim().length;
  }
  for (const card of s.cast) {
    for (const f of CAST_FIELDS) n += (card[f.key] || '').trim().length;
  }
  return n === 0;
}

/** 除了「总设定」与尺度以外几乎什么都没填 —— 这种情况该先让 AI 补全 */
export function sheetOnlyHasIdea(sheet) {
  const s = normalizeSheet(sheet);
  let n = (s.opening || '').trim().length;
  for (const [group, fields] of Object.entries(SHEET_SCHEMA)) {
    for (const f of fields) n += (s[group][f.key] || '').trim().length;
  }
  for (const card of s.cast) {
    for (const f of CAST_FIELDS) n += (card[f.key] || '').trim().length;
  }
  return s.idea.trim().length > 0 && n < 40;
}

/** 有几张"核心角色"卡是填过东西的 */
export function filledCastCount(sheet) {
  const s = normalizeSheet(sheet);
  return s.cast.filter((card) => CAST_FIELDS.some((f) => (card[f.key] || '').trim())).length;
}
