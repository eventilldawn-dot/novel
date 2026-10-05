/**
 * prompt.js — 提示词构建 + 模型输出解析（含流式增量解析）
 */

import { SHEET_SCHEMA, CAST_FIELDS, normalizeSheet } from './sheet.js';
import { ORIENTATION_PRESETS, MODE_PRESETS } from './presets.js';

const JSON_SPEC = `{
  "scene": {
    "act": "第N幕 · 幕名（4-8字）",
    "location": "场景地点，可含分隔符 ·",
    "time": "剧内时间，如 00:22",
    "phase": "时段或状态，如 深夜 / 潮湿 / 压抑爆发"
  },
  "memory": "截至目前剧情的滚雪球摘要，200字以内，会作为下一轮的长期记忆",
  "beat": "这一轮属于哪一类：flesh（以情欲为主）/ plot（以剧情推进为主）/ both（过渡与铺垫）",
  "emotions": { "情感名": 0到100的整数 },
  "blocks": [
    { "type": "tag", "text": "[地点 · 场景 · 状态]" },
    { "type": "narration", "text": "旁白段落，一段一个元素，不要换行符，不要 Markdown 标记" },
    { "type": "dialogue", "speaker": "角色名", "text": "只写台词本身：不要带角色名、不要加任何引号（程序会自动排版成 角色名：“台词”）" }
  ],
  "options": ["选项一", "选项二", "选项三"],
  "panels": { "面板id": "该面板的内容" },
  "panelUpdates": {
    "add": [{ "label": "新按钮名", "kind": "text|list|kv|notes", "hint": "这个按钮里该放什么" }],
    "remove": ["要删掉的顶部按钮id"],
    "rename": [{ "id": "顶部按钮id", "label": "换成的名字" }]
  }
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

/** 把角色卡渲染成提示词里的一段权威设定 */
export function buildSheetBlock(sheet) {
  if (!sheet) return '';
  const s = normalizeSheet(sheet);
  const parts = [];
  const dump = (title, group, fields) => {
    const lines = fields
      .map((f) => [f.label, (group[f.key] || '').trim()])
      .filter((pair) => pair[1])
      .map((pair) => `${pair[0]}：${pair[1]}`);
    if (lines.length) parts.push(`【${title}】\n${lines.join('\n')}`);
  };
  dump('玩家扮演的角色', s.me, SHEET_SCHEMA.me);
  const cast = s.cast.filter((card) => CAST_FIELDS.some((f) => (card[f.key] || '').trim()));
  cast.forEach((card, i) => {
    const who = card.name ? `${i + 1}：${card.name}` : `${i + 1}`;
    dump(`核心角色 ${who}（你负责演他）`, card, CAST_FIELDS);
  });
  dump('这几个角色与「我」之间的总体关系', s.relation, SHEET_SCHEMA.relation);
  dump('世界与剧情', s.world, SHEET_SCHEMA.world);
  if (s.opening) parts.push(`【开场】\n${s.opening}`);
  if (!parts.length) return '';
  const castNote = cast.length > 1
    ? `\n本作有 ${cast.length} 个核心角色。你要分别演出他们每一个人：各有各的说话方式、习惯动作与立场，不要把他们写成一个腔调，也不要让他们互相混淆或性格串味。`
    : '';
  return `【角色卡 · 本作的权威设定，必须严格遵守】\n下面每一条都是玩家亲自定下的。不得遗忘、混淆、简化或擅自增改；人物的说话方式、习惯动作、软肋与关系都必须与它一致。写每一轮之前先回想一遍。${castNote}\n\n${parts.join('\n\n')}`;
}

function jsonFields(fields) {
  return fields.map((f) => `"${f.key}": "${f.label}"`).join(', ');
}

/**
 * 单独给「面板内容」用的小提示词：很短、很快，用来在正文出来之后再补面板。
 * 输出只有 panels，不再重复生成正文。
 */
export function buildPanelMessages(session, cursor, defsOverride) {
  const setup = session.setup;
  const round = session.rounds[cursor];
  const defs = defsOverride || [...(setup.topPanels || []), ...(setup.bottomPanels || [])];
  const shape = defs.map((p) => {
    const kind = p.kind === 'list' ? '字符串数组（3-5 条，每条 8-24 字）'
      : p.kind === 'kv' ? '对象数组 [{"k":"标题","v":"内容"}]（3-5 项）'
        : '一段 30-80 字的文字';
    return `- "${p.id}"（${p.label}）：${p.hint}　→ 格式：${kind}`;
  }).join('\n');

  const text = blocksToText(round?.blocks || []).slice(0, 1800);
  const castNames = (normalizeSheet(setup.sheet).cast || [])
    .map((c) => c.name).filter(Boolean).join('、');

  const system = `你是一部中文互动剧情的导演助手。玩家刚看完一轮剧情，现在只需要你**补这一轮的面板内容**，不要再写正文。

要求：
1. 内容必须来自这一轮的实际剧情，不要凭空编。
2. 每个面板都写，但保持精炼：列表 3-5 条、卡片 3-5 项、文字 30-80 字。
3. 字符串里不要出现英文双引号，需要引用时用「」。
4. 只输出 JSON，第一个字符必须是 {：
{ "panels": { ${defs.map((p) => `"${p.id}": 内容`).join(', ')} } }

面板清单：
${shape}`;

  const user = `【场景】${round?.scene?.act || ''} · ${round?.scene?.location || ''} · ${round?.scene?.time || ''}`
    + (castNames ? `\n【在场角色】${castNames}` : '')
    + `\n【这一轮的剧情】\n${text}\n\n`
    + `请输出这一轮的面板内容 JSON。`;

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 让模型把粗略要点扩写成一份（或几份）完整的角色卡 */
export function buildSheetMessages(rough, opts = {}) {
  const mode = opts.mode || 'balanced';
  const intensity = String(opts.intensity || '').trim();
  const adultMode = mode !== 'story';
  const orientation = ORIENTATION_PRESETS[opts.orientation] || ORIENTATION_PRESETS.mm;
  const orientationRule = orientation.rule
    ? `\n0. **关系取向（硬性）**：${orientation.rule} 所有角色的 gender 字段必须与之一致（例如男男设定下，me 与 cast 全部填「男」），不要出现性别错位。\n`
    : '';

  const system = `你是角色设定师。玩家会给你一些粗略的点子，你要把它补全成具体、自洽、可以直接开演的一整套角色卡。
${orientationRule}
要求：
1. 每个字段 20-80 字，写具体的细节（尺寸、物件、口癖、明确的欲望与恐惧），不要写空泛的形容词堆砌。
2. 只写「设定」，不要写剧情经过，不要写成小说段落。
3. 各字段之间必须自洽：外貌、过往、软肋要能互相解释。
4. 玩家已经写了的内容要保留原意，只做扩写和补全，不要推翻。
5. 如果给了「〇 · 总设定」，它就是最高依据：人物、关系、世界观都必须从它长出来，不要另起一套。
6. **核心角色的数量由剧情决定**：玩家提到几个人就写几张卡（通常 1-4 张）。攻略多位角色、群像、只有一个对手戏对象都行。人数不要硬凑，也不要擅自合并成一个人。
7. 每一个核心角色都必须彼此区分：不同的外貌、不同的说话方式、不同的软肋。不要把几个人写成同一个模子。
8. 每个核心角色的 relation 字段只写「他和玩家角色的关系」，不要写别人和他的关系。
${adultMode ? '9. 这是成年向的虚构设定。凡是涉及性、欲望、身体关系、羞耻与征服的内容，都要如实写进人设里（写进 drive / weakness / relation / habit 都行）：不要回避、不要淡化、不要改成"两人只是朋友"、不要把明确的性关系写成暧昧暗示。人设写得越诚实，开演后越不会跑偏。' : ''}
10. 全部用中文；字符串里不要出现英文双引号，需要引用时用「」。

只输出 JSON，第一个字符必须是 {。结构：
{
  "me": { ${jsonFields(SHEET_SCHEMA.me)} },
  "cast": [
    { ${jsonFields(CAST_FIELDS)} }
  ],
  "relation": { ${jsonFields(SHEET_SCHEMA.relation)} },
  "world": { ${jsonFields(SHEET_SCHEMA.world)} },
  "opening": "第一幕从哪一刻开始，一到两句"
}`;
  const roughText = typeof rough === 'string' ? rough : JSON.stringify(rough, null, 1);
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `以下是我现在有的点子（可能很粗糙，也可能只有一部分）：\n\n${roughText}\n\n`
        + `请补全成完整的角色卡 JSON。记住：核心角色有几个由这份设定决定，不要硬凑成两个。`
        + (intensity ? `\n\n【本作的尺度设定】${intensity}` : '')
    }
  ];
}

export function buildSystemPrompt(setup, opts = {}) {
  const emotions = (setup.emotions || []).join('、');
  const lengthHint = setup.lengthHint || '控制在 350-500 字，有场景与对白。';
  const intensity = setup.intensity || '成人向的文学化描写，重心理与氛围，避免直白的器官词与粗俗表达';
  const mode = modeOf(setup);
  const adultMode = mode === 'explicit';
  const sheetBlock = buildSheetBlock(setup.sheet);
  const orientation = ORIENTATION_PRESETS[setup.orientation] || ORIENTATION_PRESETS.mm;
  const orientationBlock = orientation.rule
    ? `\n【关系取向 · 硬性设定，全篇始终遵守】\n${orientation.rule}\n`
    : '';
  const base = `你是「Novel」的导演引擎 —— 一位功力深厚的中文互动小说作者，负责推进一部沉浸式文字剧情。
${orientationBlock}

【世界观与剧情设定】
${setup.scenario || '（未指定，请按你自己的判断构建一个自洽且迷人的世界）'}

【玩家扮演】
${setup.userRole || '（未指定，按剧情合理设定）'}

【核心角色】
${setup.targetRole || '（未指定，按剧情合理设定）'}

【开场状态】
${setup.opening || '（未指定，请自行写出一个有力的开场）'}
${setup.idea ? `\n【总设定 · 玩家的原始构想（一切以它为准）】\n${setup.idea}\n` : ''}
${sheetBlock ? `\n${sheetBlock}\n` : ''}

【叙事风格】${setup.tone || '沉浸式小说'}
【叙事视角】${setup.pov || '第二人称（你用……）'}
【单轮篇幅】${lengthHint}
【内容尺度】${intensity}
${adultMode ? '这是一部成年向的虚构作品，读者是成年人。上面这一档尺度就是本作正常的内容范围：涉及性爱场面时按剧情需要正面、完整地写出来，具体程度与篇幅以这一档为准。' : ''}
${setup.customPrompt ? `\n【玩家指定的写作指令 · 最高优先级】下面每一条都必须严格执行，任何其他习惯性做法都要让位给它：\n${setup.customPrompt}\n` : ''}

【情感指标】${emotions}
情感值范围 0-100 的整数，只随剧情因果变化，不要无理由跳变。上一轮的数值会给你参考。

【写作要求】
1. 每一轮都要推进剧情：出现新的信息、新的动作或新的关系变化，禁止原地复述。
2. blocks 是这一轮的正文，用 3-6 个元素组成：先一个 tag 交代场景，然后旁白与对白交替。对白要有个性、有潜台词，可以直接引用角色原话。
3. 严格遵守【叙事视角】。
4. 描写要具体、有画面感、有生理与心理细节，避免陈词滥调与总结式抒情。
5. options 必须给出三个「方向明显不同」的下一步行动，每条 10-24 字，用动词开头，能让玩家立刻做出判断；三条之间不要只是程度差异。
6. 玩家可能会无视选项、自己输入行动 —— 你必须在逻辑上无缝承接玩家的输入，绝不跳戏。
7. panels 的内容要精炼：列表 3-5 条、每条不超过 30 字，卡片 3-4 组，文字面板不超过 120 字。正文按【单轮篇幅】写足，panels 保持精炼即可。
8. 这是最重要的一条：你的输出会被程序直接 JSON.parse。**所有字符串里绝对不要出现英文双引号 " 和换行符**；要引台词请用中文引号「」或『』。一个多余的英文引号就会让整轮内容作废。
9. 正文长度必须达到【单轮篇幅】给的下限。写不够就继续补环境、补动作、补心理细节，**不要提前收尾**，也不要用一句总结把场面草草结束。
10. **不要在正文里使用任何 Markdown 标记**：不要出现星号、井号、短横线、大于号、反引号、波浪号这些符号 —— 程序不解析 Markdown，会原样显示成乱码。需要强调就用中文标点和句子本身。
11. 对白一律放进 dialogue 块，text 里**只写台词**：不要自己加角色名、不要加引号（程序会自动排成"角色名：「台词」"）；旁白里也不要写"**角色名**"当小标题。
12. 落笔前自检一遍：数字、称呼、代词、时间与前后逻辑要自洽（例如别把三个字说成"这两个字"，别让同一个人换了称呼，别写出与上文矛盾的细节）。
13. **指代必须清楚（这一条最容易翻车）**：场上有两个以上的人时，不要用含糊的「他」——一律用名字、身份或固定特征（例如"穿白衬衫的那个""年纪大的那个"）指代。**每一句话都要让读者一眼知道是谁在做、是谁被写。** 写完自己读一遍，凡是"他"可能指两个人的地方，全部改成名字。
14. **前后要接得上**：每一句都要能回答"它跟上文什么关系"。写之前先想清楚这一轮发生什么、结束时谁在哪儿、谁是什么状态；不要写出与前文矛盾、时间错乱、或不合常理的句子。
15. **用词要自然，不要生搬硬造**：用正常的中文写，别自造词组、别硬凑比喻、别堆砌四字成语、别用翻译腔。比喻一段最多一个，宁朴素也要通顺；拿不准的词就换成最普通的说法。
16. 学范文的节奏感和细节密度，但**不要连它的病句、口水话和重复表达一起学**。

${opts.noPanels ? '\n【本轮不要生成面板】panels 请直接写成一个空对象 {}，程序会另外单独问你。\n' : `${panelBlock(setup.topPanels, '顶部面板')}${panelBlock(setup.bottomPanels, '底部面板')}`}

【顶部按钮是"活"的】玩家随时能点到顶部那排按钮，所以它们要跟着剧情走：
- 出现新的地点、组织、目标、关键人物时，可以 add 一个真正有用的新按钮；顶部最多 6 个，宁缺毋滥。
- 已经没用的按钮可以 remove（用它的 id）。
- 名字不再贴切时可以 rename（用它的 id）。
- 不需要调整时，add / remove / rename 都留空数组。**不要为了显得智能而乱加按钮。**
当前顶部按钮（id → 名称）：${(setup.topPanels || []).map((p) => `${p.id} → ${p.label}`).join('；') || '（暂无）'}
新增按钮时，如果本轮就已经有内容，可以同时在 panels 里用它的 label 作为 key 写进去。

【输出格式】只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字。结构如下：
${JSON_SPEC}

注意：
- panels 里必须包含上面列出的每一个 key，值直接是内容本身（字符串 / 字符串数组 / {k,v} 数组），不要嵌套额外的说明层。
- blocks 中的 text 内部不要出现换行符。
- 只写 JSON，第一个字符必须是 {，最后一个字符必须是 }。`;
  const tail = adultMode
    ? `\n\n【最后一遍，比上面所有话都重要】写作时严格以【内容尺度】和【玩家指定的写作指令】为准。性爱场面是本作的正常内容：按这一档的程度正面写完，不要淡出、不要省略、不要用比喻或省略号带过。

【本轮的笔墨分配】（按下面的动态配比执行）
1. 剧情部分要有实实在在的推进 —— 新的信息、新的动作、关系的变化、外部事件或时间推进，不要停在原地。
2. 情欲部分写到就用直接的词写透，不淡出、不用代称。
3. 让身体与剧情咬合：每一次接触最好都改变处境或关系，而不是单纯的生理描写。
4. 两种偷懒都要避免：**用无关情节岔开去回避情欲**，和**为了写肉而原地打转**，一样不行。
5. 三个选项要给出**方向明显不同**的下一步，并且**每个都能推进剧情**：可以分别是「推进关系/情欲」「推进任务或冲突」「引入新变化或新处境」。**不要三个都是「更用力一点」**，也不要给「离开去做别的事」这种纯逃避选项。
6. 用词不要自我审查：器官、体液、动作就用最直接的词（鸡巴、龟头、精液、射、操、干、骚、穴），禁止换成「那里」「下面」「那个地方」「私处」这类代称，也不要用省略号或破折号跳过。`
    : '';
  const balancedTail = mode === 'balanced'
    ? '\n\n【本轮的笔墨分配】以剧情为主，情欲自然融入（大约剧情 8 : 情欲 2）：剧情必须每轮都有推进；情境到了就正面写、不必回避，但不要整轮只有身体。三个选项方向要明显不同，至少一个指向关系/情欲的推进。'
    : '';
  const rawStyle = String(opts.styleSample || '').trim();
  const style = looksGarbled(rawStyle) ? '' : rawStyle;
  const styleBlock = style
    ? `\n\n【文风参考 · 行文必须向它靠拢】\n下面这段是玩家认可的范文。请学习它的：段落密度、句子的长短节奏、细节落在什么地方（写什么、不写什么）、对白与动作的比例、以及怎么把身体感受与情绪写具体。**不要照抄它的情节、人物名或原句**，只学写法；涉及性爱场面时的写法也向它看齐。\n篇幅仍按【单轮篇幅】的设定，但单位篇幅里的细节浓度、描写密度要和范文一致 —— 不要因为篇幅短就把段落写薄。\n\n---\n${style}\n---`
    : '';
  return base + styleBlock + adultTail(setup, mode, opts.beats);
}

/** 成年向模式的结尾指令：按"剧情:情欲"配比收束 */
function adultTail(setup, mode, beats) {
  const flesh = fleshBlock(setup, beats);
  if (mode === 'explicit') {
    return `\n\n【最后一遍，比上面所有话都重要】写作时严格以【内容尺度】和【玩家指定的写作指令】为准。性爱场面是本作的正常内容，不要淡出、不要省略、不要用比喻或省略号带过。${flesh}`;
  }
  return mode === 'balanced' ? flesh : '';
}

/** 文风样例是不是乱码（编码搞错、复制错源都会这样）——乱码样例会让模型彻底跑偏 */
/** 判定当前尺度模式：优先用显式设置的 mode，老剧情则从尺度文案推断 */
export function modeOf(setup) {
  const m = setup?.mode;
  if (m === 'story' || m === 'balanced' || m === 'explicit') return m;
  const t = String(setup?.intensity || '');
  if (/全年龄|剧情为主|自然带过/.test(t)) return 'story';
  if (/感官细腻|并重/.test(t)) return 'balanced';
  return 'explicit';
}

/** 情欲占比（0-100）。没设过就按模式的默认值 */
export function fleshRatioOf(setup) {
  const r = Number(setup?.fleshRatio);
  if (Number.isFinite(r)) return Math.max(0, Math.min(100, r));
  const m = modeOf(setup);
  return MODE_PRESETS[m]?.fleshRatio ?? 45;
}

/**
 * 整体配比 + 节奏跟踪。
 * 关键：配比是**整部作品**的目标，不是每一轮都要凑 —— 一轮写肉就写透，
 * 换档要在场景交界处完成，而不是同一场戏写一半突然跳走。
 */
function fleshBlock(setup, beats) {
  const flesh = fleshRatioOf(setup);
  const plot = 100 - flesh;
  const map = { flesh: '肉', plot: '剧情', both: '过渡' };
  const list = (beats || []).slice(-6);
  const beatLine = list.length
    ? `\n- 最近几轮的节奏：${list.map((b) => map[b] || '过渡').join(' → ')}。`
    : '';
  const toward = list.length
    ? (() => {
      const fleshCount = list.filter((b) => b === 'flesh').length;
      const plotCount = list.filter((b) => b === 'plot').length;
      if (fleshCount >= 3 && fleshCount > plotCount) return '\n- 目前连着几轮都是肉，**这一轮适合在场景交界处把剧情往前推一步**（新信息、新变化、时间推进）。';
      if (plotCount >= 3 && plotCount > fleshCount) return '\n- 目前连着几轮都在推剧情，**这一轮适合把关系/情欲再往前推一档**。';
      return '';
    })()
    : '';
  return `\n\n【整体配比 · 管整部作品，不是管每一轮】
这部作品整体大致是 **剧情 ${plot}% : 情欲 ${flesh}%**，但**不要在一轮里硬套这个比例**。
- 这一轮怎么写，取决于**当下这一场戏**：正在情欲场景里就把它写透，正在推进剧情就把剧情写足。**不要在同一场戏中间突然切去写别的事** —— 那读起来非常割裂。
- 需要平衡的是整部作品：连着写了几轮肉，就让剧情往前走一步；连着推了几轮剧情，再回到情欲。${beatLine}${toward}
- **换档必须在场景交界处完成**：用一个自然的转折（换了地方、时间过去、有人进来、谈话结束）来过渡，而不是写到一半跳走。
- 情欲场面要写透：器官与体液用直接的词（鸡巴、龟头、精液、射、操、干、骚、穴），不要用「那里」「下面」代指，不要用省略号跳过。
- 三个选项方向要**明显不同**：至少一个是"顺着当前这场继续"，另一个可以"换到另一条线"。`;
}

export function looksGarbled(text) {
  const s = String(text || '');
  if (!s) return false;
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (bad === 0) return false;
  return bad / s.length > 0.02;
}

function blocksToText(blocks) {
  return (blocks || [])
    .map((b) => {
      if (b.type === 'dialogue') return `${b.speaker ? b.speaker + '：' : ''}“${b.text}”`;
      return b.text;
    })
    .join('\n');
}

export function buildMessages(session, cursor, opts = {}) {
  const setup = session.setup;
  const rounds = session.rounds.slice(0, cursor + 1);
  // 把最近几轮的"节奏标签"带过去，让模型知道整部作品目前偏在哪一边
  const beats = rounds.slice(-6).map((r) => r.beat || 'both');
  const system = buildSystemPrompt(setup, { styleSample: opts.styleSample, noPanels: opts.noPanels, beats });
  const messages = [{ role: 'system', content: system }];

  const memory = rounds.length ? rounds[rounds.length - 1].memory : '';
  // 只带最近 2 轮、每轮截断，输入越短开演越快
  const recent = rounds.slice(-2);
  const transcript = recent
    .map((r) => {
      const action = r.playerAction ? `\n〔玩家的行动〕${r.playerAction}` : '';
      return `—— 第 ${r.i + 1} 轮（${r.scene.act}｜${r.scene.time} ${r.scene.phase}）——\n${blocksToText(r.blocks).slice(0, 900)}${action}`;
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

  // 尺度提醒放在每轮的最后（模型对结尾的指令最敏感）
  const mode = modeOf(setup);
  const scaleNote = mode === 'explicit'
    ? '\n〔本轮写法〕顺着当下这一场写透：正在写肉就写透，别中途切去推剧情；该换档时在场景交界处换（整体配比见上）。'
      + '\n〔本轮用词〕器官与体液用直接的词（鸡巴、龟头、精液、射、操、干、骚、穴），不要用「那里」「下面」「那个地方」代指，不要用省略号跳过。'
    : mode === 'balanced'
      ? '\n〔本轮写法〕顺着当下这一场写；剧情与情欲都行，但不要在同一场戏里硬切，换档放在场景交界处。写到时用词直接。'
      : '';
  const firstNote = (mode === 'explicit' && rounds.length === 0) ? '（这是第一轮，就把写法基调立起来。）' : '';
  // 第一轮把完整写作指令再以「玩家的话」发一遍：模型对 user 消息的遵守度通常高于 system
  const userWritingNote = (rounds.length === 0 && setup.customPrompt)
    ? `\n\n【我的写作要求（请照做）】\n${setup.customPrompt}`
    : '';

  messages.push({
    role: 'user',
    content:
      `【长期记忆】${memory || '（暂无，这是开场）'}` +
      (transcript ? `\n\n【最近剧情】\n${transcript}` : '') +
      state +
      actionLine +
      userWritingNote +
      scaleNote +
      `\n\n现在请输出第 ${rounds.length + 1} 轮的 JSON。`
      + firstNote
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
    const text = `${label} ${item?.hint || ''}`;
    const pointTime = /弹幕|实时|观众|评论|打赏|留言/.test(text) || item?.freq === 'each';
    out.push({
      id: panelId(label, offset + i),
      label: label.slice(0, 12),
      kind,
      freq: pointTime ? 'each' : 'rare',
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
        return parseLenient(slice);
      }
    }
  }
  // 走到这里说明括号没闭合（多半是被 max_tokens 截断）——尽力抢救已经写出来的部分
  return parseLenient(raw.slice(start));
}

/**
 * 模型常把英文双引号直接写进中文里（他说"好"），这会让 JSON 结构错位。
 * 规则：字符串内部遇到 " 时，看它后面第一个非空白字符 ——
 *   是 : , } ] " 或已到结尾 → 合法结尾引号；
 *   否则 → 判定为内容里的引号，转义掉。
 */
function fixInnerQuotes(text) {
  const structural = new Set([':', ',', '}', ']', '"']);
  const out = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) { out.push(ch); esc = false; continue; }
    if (ch === '\\') { out.push(ch); esc = true; continue; }
    if (ch !== '"') { out.push(ch); continue; }
    if (!inStr) { inStr = true; out.push(ch); continue; }
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    const next = text[j];
    if (next === undefined || structural.has(next)) {
      inStr = false;
      out.push(ch);
    } else {
      out.push('\\"');
    }
  }
  return out.join('');
}

function parseLenient(slice) {
  try { return JSON.parse(slice); } catch { /* 继续 */ }
  try { return JSON.parse(repair(slice)); } catch { /* 继续 */ }
  try { return JSON.parse(repair(fixInnerQuotes(slice))); } catch { /* 继续 */ }
  try { return JSON.parse(repair(fixInnerQuotes(repair(slice)))); } catch { /* 继续 */ }
  const err = new Error('JSON 结构损坏');
  err.kind = 'json';
  err.raw = slice;
  throw err;
}

/* ---------------- 字段级抢救：整体 JSON 坏了也能把正文捞回来 ---------------- */

function skipWs(s, i) {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j += 1;
  return j;
}

/** 从 i 处（s[i] 必须是 "）扫出一个 JSON 字符串，返回 [值, 结束下标] */
function scanString(s, i) {
  let j = i + 1;
  let buf = '';
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') {
      const nx = s[j + 1];
      if (nx === 'n') buf += '\n';
      else if (nx === 't') buf += '\t';
      else if (nx === 'r') buf += '';
      else buf += nx;
      j += 2;
      continue;
    }
    if (ch === '"') return [buf, j + 1];
    buf += ch;
    j += 1;
  }
  return [buf, s.length];
}

/** 从 i 处（s[i] 是 [ 或 {）扫到配对结束 */
function scanBracket(s, i) {
  const open = s[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < s.length; j += 1) {
    const ch = s[j];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return s.slice(i);
}

function parseMaybe(text) {
  try { return JSON.parse(text); } catch { /* 继续 */ }
  try { return JSON.parse(repair(text)); } catch { /* 继续 */ }
  try { return JSON.parse(repair(fixInnerQuotes(text))); } catch { return undefined; }
}

/** 找 "key" 后面的值并尽可能解析出来 */
function scanValue(src, key) {
  const patterns = [`"${key}"`, `'${key}'`, `${key}`];
  for (const pat of patterns) {
    const idx = src.indexOf(pat);
    if (idx < 0) continue;
    let i = skipWs(src, idx + pat.length);
    if (src[i] !== ':') continue;
    i = skipWs(src, i + 1);
    const ch = src[i];
    if (ch === undefined) return undefined;
    if (ch === '"') return scanString(src, i)[0];
    if (ch === '[' || ch === '{') {
      const seg = scanBracket(src, i);
      const parsed = parseMaybe(seg);
      if (parsed !== undefined) return parsed;
      // 数组解析不出来就退化成"逐个抽字符串"
      if (ch === '[') {
        const items = [];
        let j = i + 1;
        while (j < src.length && src[j] !== ']') {
          if (src[j] === '"') {
            const [v, end] = scanString(src, j);
            items.push(v);
            j = end;
          } else if (src[j] === '{') {
            const objSeg = scanBracket(src, j);
            const obj = parseMaybe(objSeg);
            if (obj && typeof obj === 'object') items.push(obj);
            j += objSeg.length;
          } else j += 1;
        }
        return items;
      }
      return undefined;
    }
    // 数字 / true / false / null
    const m = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(src.slice(i));
    if (m) return parseMaybe(m[1]);
  }
  return undefined;
}

export function salvageRoundFromText(text, session) {
  const src = String(text || '');
  const round = {
    scene: {}, memory: '', emotions: {}, blocks: [], options: [], panels: {}
  };
  for (const key of ['act', 'location', 'time', 'phase']) {
    const v = scanValue(src, key);
    if (typeof v === 'string' && v) round.scene[key] = v;
  }
  const mem = scanValue(src, 'memory');
  if (typeof mem === 'string') round.memory = mem;
  round.blocks = partialBlocks(src);
  round.options = (scanValue(src, 'options') || []).map((o) => String(o)).filter(Boolean);

  const emo = scanValue(src, 'emotions');
  if (emo && typeof emo === 'object') {
    for (const [k, v] of Object.entries(emo)) round.emotions[k] = Number(v) || 0;
  }

  const defs = session
    ? [...(session.setup.topPanels || []), ...(session.setup.bottomPanels || [])]
    : [];
  for (const def of defs) {
    const v = scanValue(src, def.id);
    if (v !== undefined) round.panels[def.id] = v;
  }
  return round;
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
    beat: ['flesh', 'plot', 'both'].includes(raw.beat) ? raw.beat : 'both',
    emotions: coerceEmotions(raw.emotions, emotionKeys),
    prevEmotions: { ...prevEmotions },
    blocks: coerceBlocks(raw.blocks),
    options: coerceOptions(raw.options),
    panels,
    _rawPanels: rawPanels,
    panelUpdates: coercePanelUpdates(raw.panelUpdates)
  };
}

function coercePanelUpdates(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const add = coercePanelList(raw.add, 100);
  const remove = (Array.isArray(raw.remove) ? raw.remove : [])
    .map((r) => String(typeof r === 'string' ? r : r?.id || '').trim())
    .filter(Boolean);
  const rename = (Array.isArray(raw.rename) ? raw.rename : [])
    .map((r) => ({ id: String(r?.id || '').trim(), label: String(r?.label || r?.name || '').trim() }))
    .filter((r) => r.id && r.label);
  if (!add.length && !remove.length && !rename.length) return null;
  return { add, remove, rename };
}

export { blocksToText };
