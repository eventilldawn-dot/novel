/**
 * presets.js — 题材模板、面板定义、情感指标预设
 *
 * 面板（Panel）是「顶部快捷按钮」与「底部反馈按钮」的统一抽象。
 * 每个面板 = 一个可点开的抽屉，内容由导演引擎按 hint 实时生成。
 *   kind: 'text'  一段文字
 *         'list'  条目列表（可带 [来源] 前缀）
 *         'kv'    键值卡片
 *         'notes' 文字 + 可以直接注入下一轮走向的输入框
 */

export const EMOTION_PALETTE = [
  { color: '#e2705f', glow: 'rgba(226,112,95,.35)' },
  { color: '#c9a25e', glow: 'rgba(201,162,94,.35)' },
  { color: '#8fa8d8', glow: 'rgba(143,168,216,.35)' },
  { color: '#b07fd0', glow: 'rgba(176,127,208,.35)' },
  { color: '#5fb59a', glow: 'rgba(95,181,154,.35)' },
  { color: '#d08fa6', glow: 'rgba(208,143,166,.35)' }
];

export const EMOTION_PRESETS = {
  classic: { name: '好感型（通用）', list: ['好感度', '愉悦度', '羞耻度', '痛苦', '沉溺'] },
  live: { name: '拍摄现场型', list: ['兴奋', '愉悦', '厌恶', '痛苦', '沉溺'] },
  court: { name: '宫廷权谋型', list: ['好感', '信任', '畏惧', '猜忌', '依赖'] },
  school: { name: '校园青春型', list: ['好感度', '心动值', '尴尬值', '压力', '依赖'] },
  mystery: { name: '悬疑推理型', list: ['信任', '警觉', '恐惧', '压力', '执念'] },
  survival: { name: '末世求生型', list: ['信任', '士气', '恐惧', '伤势', '依赖'] },
  fantasy: { name: '奇幻冒险型', list: ['好感', '斗志', '敬畏', '疑虑', '羁绊'] }
};

const P = {
  personaCard: {
    id: 'persona_card',
    label: '人设卡',
    freq: 'rare',
    hint: '用 3-5 行列出当前核心角色的姓名/代号、身份、外观细节、此刻的欲望与软肋。',
    kind: 'kv'
  },
  threads: {
    id: 'threads',
    label: '剧情线索',
    freq: 'rare',
    hint: '列出目前已经埋下、尚未收束的 3-5 条剧情线索，每条一句话，标注「已触发 / 待引爆」。',
    kind: 'list'
  },
  actMap: {
    id: 'act_map',
    label: '分幕地图',
    freq: 'rare',
    hint: '用一段话概括整部剧情的三到四幕结构，并标出当前所处幕位与下一步的岔路口。',
    kind: 'text'
  },

  innerVoice: {
    id: 'inner_voice',
    label: '心理活动',
    freq: 'rare',
    hint: '以「角色名：」开头，写 2-4 句对方此刻真实但说不出口的内心活动，要有生理与情绪的具体细节。',
    kind: 'text'
  },
  bullet: {
    id: 'bullet',
    label: '影片弹幕',
    freq: 'each',
    hint: '生成 5-8 条观众视角的实时弹幕，格式为 [用户名]: 内容，用户口味偏猎奇、带节奏、有梗。',
    kind: 'list'
  },
  roster: {
    id: 'roster',
    label: '名单记录',
    freq: 'rare',
    hint: '以列表维护一份「已被记录/已达成」的名册，每条格式 [编号] 代号 — 时间 — 一句状态备注，只增不减。',
    kind: 'list'
  },
  ideas: {
    id: 'ideas',
    label: '自定义思路',
    freq: 'rare',
    hint: '给出 2-3 条本幕可以走的收尾/加码方向，说明各自的风险与收益，语气像幕后导演笔记。',
    kind: 'notes'
  },
  living: {
    id: 'living',
    label: '生活条件',
    freq: 'rare',
    hint: '用键值卡片描述主角的现实处境：当前场所 / 日常居所 / 本次收益预估 / 最想改善的一项，数字要克制可信。',
    kind: 'kv'
  },
  relationship: {
    id: 'relationship',
    label: '关系网',
    freq: 'rare',
    hint: '列出与主角相关的 3-5 个关键人物，每条 [姓名] 关系 — 当前态度（一句话）。',
    kind: 'list'
  },
  mood: {
    id: 'mood',
    label: '情绪波动',
    freq: 'rare',
    hint: '用 3-5 条短句记录对方情绪从上一轮到此刻的变化轨迹，标出触发变化的那一句台词或动作。',
    kind: 'list'
  },
  rumor: {
    id: 'rumor',
    label: '风闻流言',
    freq: 'rare',
    hint: '生成 4-6 条当前场景外流传的流言或密报，格式 [来源]: 内容，真假混杂。',
    kind: 'list'
  },
  ledger: {
    id: 'ledger',
    label: '家底账目',
    freq: 'rare',
    hint: '用键值卡片列出可用资源：银钱 / 人手 / 人脉 / 可动用筹码，并给出一句风险评估。',
    kind: 'kv'
  },
  evidence: {
    id: 'evidence',
    label: '线索板',
    freq: 'rare',
    hint: '列出目前掌握的证据与疑点，每条格式 [编号] 内容 — 指向（明确了什么/还差什么）。',
    kind: 'list'
  },
  suspects: {
    id: 'suspects',
    label: '嫌疑人名单',
    freq: 'rare',
    hint: '列出嫌疑人，每条 [姓名] 身份 — 嫌疑指数 0-100 — 一句话动机或不在场证明。',
    kind: 'list'
  },
  supplies: {
    id: 'supplies',
    label: '物资储备',
    freq: 'rare',
    hint: '用键值卡片列出物资：食物 / 水 / 药品 / 电池 / 武器，注明天数余量与消耗速度。',
    kind: 'kv'
  },
  radio: {
    id: 'radio',
    label: '电台杂音',
    freq: 'each',
    hint: '生成 4-6 条断断续续的外部讯号，格式 [频率]: 内容，营造信息不对称的压迫感。',
    kind: 'list'
  },
  party: {
    id: 'party',
    label: '队伍成员',
    freq: 'rare',
    hint: '列出队伍成员，每条 [姓名] 职业 — 状态 — 一句忠诚度或暗流备注。',
    kind: 'list'
  },
  purse: {
    id: 'purse',
    label: '行囊与金币',
    freq: 'rare',
    hint: '用键值卡片列出金币、消耗品、特殊道具与负重情况。',
    kind: 'kv'
  },
  tavern: {
    id: 'tavern',
    label: '酒馆传言',
    freq: 'rare',
    hint: '生成 4-6 条酒馆里听来的传言，格式 [酒客]: 内容，其中至少一条暗藏真实任务线索。',
    kind: 'list'
  },
  campus: {
    id: 'campus',
    label: '校园流言',
    freq: 'rare',
    hint: '生成 4-6 条校园里的流言与八卦，格式 [来源]: 内容。',
    kind: 'list'
  },
  club: {
    id: 'club',
    label: '社团名录',
    freq: 'rare',
    hint: '列出与剧情相关的社团/班级成员，每条 [姓名] 身份 — 与主角的关系。',
    kind: 'list'
  }
};

export const PANEL_LIBRARY = P;

export const TEMPLATES = [
  {
    id: 'live_studio',
    name: '直播拍摄 · 生活条件',
    emoji: '🎥',
    desc: '主角靠镜头前的交易改善生活条件。顶部情感条随录制实时跳动，底部是弹幕与幕后笔记。',
    scenario:
      '【世界观】现代都市的灰色产业。存在一条成熟的加密直播产业：观众打赏、剧本被编排、被拍摄者签下无法反悔的合约。\n' +
      '【剧情主线】主角靠拍摄这几支片子赚钱，用来改善自己糟糕的生活条件；每一幕都是一次录制，录制过程会被剪辑发布。\n' +
      '【节奏要求】每一轮都要推进录制进度与现实收益，镜头内外的反差是核心张力。',
    userRole: '导演 / 拍摄者。镜头外的人，掌握剧本、时间与节奏，说话克制、精准、偶尔玩味。',
    targetRole:
      '代号「白衬衫」的被拍摄者。原本是受过高等教育的体面人，因债务签下合约。外表冷淡自持，内心极度敏感，越被压制越容易失控。',
    opening: '第一幕 · 初始录制。深夜的酒店套房，设备已经架好，红灯亮起。',
    tone: '冷静克制、镜头感强、旁白像分镜脚本',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.live.list,
    topPanels: [P.personaCard, P.actMap, P.threads],
    bottomPanels: [
      { ...P.innerVoice, id: 'inner_voice', label: '心理活动' },
      { ...P.bullet, id: 'bullet', label: '影片弹幕' },
      { ...P.roster, id: 'roster', label: '已采精名单' },
      { ...P.ideas, id: 'ideas', label: '自定义思路' },
      { ...P.living, id: 'living', label: '生活条件' }
    ]
  },
  {
    id: 'urban_romance',
    name: '现代都市 · 情感拉扯',
    emoji: '🌃',
    desc: '成年人的推拉与试探。顶部跟踪好感与沉溺，底部观察内心与关系网。',
    scenario:
      '【世界观】当代都市，两个成年人在职场与生活夹缝里相遇。\n' +
      '【剧情主线】从试探、越界到互相依赖，每一步都必须付出代价。\n' +
      '【节奏要求】注重潜台词，台词短，信息量大。',
    userRole: '主角本人。有分寸、有试探，懂得在退让里进攻。',
    targetRole: '对方。表面体面克制，实际上早已在心里演练过无数次这场见面。',
    opening: '雨夜的便利店屋檐下，你们同时躲雨。',
    tone: '克制、有留白、都市感',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.classic.list,
    topPanels: [P.personaCard, P.threads, P.actMap],
    bottomPanels: [P.innerVoice, P.mood, P.relationship, P.ideas, P.living]
  },
  {
    id: 'court',
    name: '古风宫廷 · 权谋',
    emoji: '🏯',
    desc: '台阶上每一步都踩着自己的影子。底部是风闻与家底账目。',
    scenario:
      '【世界观】架空王朝，后宫与朝堂互为棋盘。\n' +
      '【剧情主线】主角入局求存，从被摆布的人变成下棋的人。\n' +
      '【节奏要求】用礼数、称呼与器物细节体现权力差。',
    userRole: '新入宫的人。看似柔顺，实则每一步都在算。',
    targetRole: '当朝权贵。喜怒不形于色，最恨别人看穿他。',
    opening: '宫门在身后合拢，铜环轻轻一响。',
    tone: '典雅、清冷、暗流涌动',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.court.list,
    topPanels: [P.personaCard, P.actMap, P.threads],
    bottomPanels: [P.innerVoice, P.rumor, P.relationship, P.ideas, P.ledger]
  },
  {
    id: 'campus',
    name: '校园青春',
    emoji: '🎒',
    desc: '走廊尽头的对视与躲闪。底部是流言与社团名录。',
    scenario: '【世界观】南方城市的重点高中，升学压力与青春冲动并存。\n【剧情主线】从同桌到心动，从误会到靠近。',
    userRole: '转学生。带着不想被知道的过去。',
    targetRole: '年级第一。清冷、整洁、被所有人仰望，但没人真正接近过。',
    opening: '开学第一天，你被安排在最后一排靠窗的位置。',
    tone: '清新、细腻、带一点笨拙',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.school.list,
    topPanels: [P.personaCard, P.threads],
    bottomPanels: [P.innerVoice, P.campus, P.club, P.ideas, P.living]
  },
  {
    id: 'mystery',
    name: '悬疑推理',
    emoji: '🕯️',
    desc: '每个人都在撒谎。底部是线索板与嫌疑人名单。',
    scenario: '【世界观】封闭空间内的连续失踪案。\n【剧情主线】主角以调查者身份进入，逐渐发现自己也在名单上。',
    userRole: '受邀前来的调查者。习惯怀疑一切，包括自己。',
    targetRole: '案件中心人物。合作、配合，但每次开口都避开关键一格。',
    opening: '雨停了，招待所走廊的灯坏了一盏。',
    tone: '冷峻、克制、信息密集',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.mystery.list,
    topPanels: [P.personaCard, P.threads, P.actMap],
    bottomPanels: [P.innerVoice, P.evidence, P.suspects, P.ideas, P.living]
  },
  {
    id: 'survival',
    name: '末世求生',
    emoji: '🛰️',
    desc: '天亮之前必须决定带谁走。底部是物资与外部讯号。',
    scenario: '【世界观】灾变第七年，城市成为废墟，秩序由水源决定。\n【剧情主线】主角带着同伴寻找安全区，代价是不断放弃一些东西。',
    userRole: '小队里做决定的人。理性，但每次理性都要付代价。',
    targetRole: '同行者。曾经的医生，救过很多人，现在手在抖。',
    opening: '柴油发动机在楼下空转，天快亮了。',
    tone: '粗粝、克制、画面感强',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.survival.list,
    topPanels: [P.personaCard, P.threads, P.actMap],
    bottomPanels: [P.innerVoice, P.radio, P.party, P.ideas, P.supplies]
  },
  {
    id: 'fantasy',
    name: '奇幻冒险',
    emoji: '⚔️',
    desc: '酒馆、地图与不敢说出口的誓言。底部是传言与行囊。',
    scenario: '【世界观】剑与魔法的边境王国，旧神已死，新的信仰还没立起来。\n【剧情主线】主角接下一桩报酬过高的委托，同伴各有隐情。',
    userRole: '受托的冒险者。看似随意，实则对每个人都留了一手。',
    targetRole: '同行法师。博学、话少、藏着不能说的契约。',
    opening: '酒馆的门被推开时，所有人的目光都落到了你身上。',
    tone: '传奇叙事、画面开阔、带一点宿命感',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.fantasy.list,
    topPanels: [P.personaCard, P.threads, P.actMap],
    bottomPanels: [P.innerVoice, P.tavern, P.party, P.ideas, P.purse]
  },
  {
    id: 'blank',
    name: '空白画布 · 自定义',
    emoji: '✦',
    desc: '完全按你自己的设定来。所有字段手填，面板按钮也可以自由增删。',
    scenario: '',
    userRole: '',
    targetRole: '',
    opening: '',
    tone: '沉浸式小说',
    pov: '第二人称（你用……）',
    emotions: EMOTION_PRESETS.classic.list,
    topPanels: [P.personaCard, P.threads],
    bottomPanels: [P.innerVoice, P.mood, P.relationship, P.ideas, P.living]
  }
];

export const LENGTH_PRESETS = {
  short: { name: '短（约 200 字）', hint: '正文 150-250 字，节奏快，只写一个瞬间。' },
  medium: { name: '中（约 400 字）', hint: '正文 350-500 字，用 4-6 个自然段，有场景与对白。' },
  long: { name: '长（约 700 字）', hint: '正文 600-900 字，用 6-9 个自然段写完，段落之间要有推进，不要提前收尾。' },
  extra: { name: '超长（约 1200 字）', hint: '正文 1000-1400 字，用 10-14 个自然段把这一整个场景写完：环境、体感、心理、对白、动作都要有。写不够就继续补细节，不许提前收尾、不许用总结句草草结束。' }
};

/**
 * 尺度模式：一键切换「今天想怎么写」
 * 它决定三件事：提示词里的尺度描述、每轮附带的尺度提醒、以及开场基调。
 */
export const MODE_PRESETS = {
  story: {
    name: '剧情为主',
    icon: '📖',
    desc: '以故事、人物和关系为主。亲密场面只在剧情需要时出现，自然带过，不刻意展开。',
    intensity: '本作以剧情、人物与关系为主。涉及亲密场面时按剧情推进自然带过，不需要展开描写。'
  },
  balanced: {
    name: '平衡',
    icon: '⚖️',
    desc: '剧情与亲密场面并重。该发生的关系就正面写，但一切服务于人物与剧情，不为了写而写。',
    intensity: '本作剧情与亲密场面并重：该发生的关系就正面写出来，但一切服务于人物与剧情，不为了写而写。'
  },
  explicit: {
    name: '直球',
    icon: '🔥',
    desc: '以亲密场面为核心内容。按设定尺度直接、完整地写，不省略、不淡出、不插道德提醒。',
    intensity: '本作是成年向的虚构创作，面向成年读者。性爱场面是核心内容：按剧情需要直接、完整地写，动作、体感、身体反应与对白都写出来，尺度不设上限。'
  }
};

export const MODE_ORDER = ['story', 'balanced', 'explicit'];

/** 细档位 → 模式的映射，用来让两套控件保持同步 */
export const INTENSITY_MODE_MAP = {
  全年龄: 'story',
  文学化克制: 'story',
  感官细腻: 'balanced',
  直白强烈: 'explicit',
  无限制: 'explicit'
};

export const TONE_PRESETS = [
  '沉浸式小说', '冷峻克制', '镜头感强、像分镜脚本', '优雅古典', '清爽细腻',
  '黑色幽默', '紧张压迫', '抒情散文'
];

export const POV_PRESETS = ['第二人称（你用……）', '第一人称（我用……）', '第三人称（他用……）'];

export function makePanel(partial) {
  return {
    id: partial.id || `panel_${Math.random().toString(36).slice(2, 8)}`,
    label: partial.label || '新面板',
    hint: partial.hint || '按当前剧情，生成这个面板应当展示的内容。',
    kind: partial.kind || 'text',
    freq: partial.freq === 'each' ? 'each' : 'rare'
  };
}

export function cloneTemplate(t) {
  return JSON.parse(JSON.stringify(t));
}

/* ---------------- 没有模型时的关键词兜底：按剧情挑模板 ---------------- */

const KEYWORDS = {
  live_studio: '直播 拍摄 镜头 影片 合约 打赏 观众 录制 弹幕 导演 视频 主播 流量 网红 直播间 厂牌 剪辑 片场 采精',
  urban_romance: '都市 职场 恋爱 暧昧 重逢 前任 相亲 白领 加班 合租 离婚 婚后 都市情感 霸道总裁 办公室',
  court: '宫 朝堂 皇帝 妃 权谋 王爷 王朝 后宫 太后 太监 圣旨 冷宫 宫廷 江湖 门阀 世家 古代',
  campus: '校园 高中 大学 同桌 教室 社团 学生 青春 毕业 班主任 校服 期中 期末考试',
  mystery: '悬疑 推理 案件 线索 凶手 侦探 失踪 密室 调查 死者 证词 现场 嫌疑人 刑警',
  survival: '末世 丧尸 废土 求生 灾变 物资 幸存 避难所 辐射 感染 末日 末日生存',
  fantasy: '魔法 剑 冒险 奇幻 精灵 法师 勇者 公会 王国 异世界 龙 骑士 神殿 咒语 魔物'
};

export function suggestSetupLocal(draft) {
  const hay = [draft.scenario, draft.userRole, draft.targetRole, draft.opening, draft.title]
    .filter(Boolean).join(' ');
  let best = null;
  let bestScore = 0;
  for (const [id, words] of Object.entries(KEYWORDS)) {
    const score = words.split(' ').reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  const template = TEMPLATES.find((t) => t.id === best) || TEMPLATES.find((t) => t.id === 'urban_romance');
  const title = (draft.title || '').trim()
    || (draft.scenario || '').split('\n')[0].replace(/^【[^】]*】/, '').trim().slice(0, 14)
    || template.name;
  return {
    title,
    emotions: [...template.emotions],
    topPanels: template.topPanels.map((p) => ({ ...p })),
    bottomPanels: template.bottomPanels.map((p) => ({ ...p })),
    matched: template.id
  };
}
