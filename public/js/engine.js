/**
 * engine.js — 本地示例引擎（离线兜底）
 * 不依赖任何模型服务，让整套交互（轮次推进 / 情感变化 / 选项 / 面板）先跑起来。
 * 一旦配置了 API Key，会自动切换到真实模型，这里就只作为降级方案。
 */

const STAGES = ['起', '承', '转', '陷', '收'];

const FLAVOR = {
  live_studio: {
    acts: ['初始录制', '镜头之下', '越界', '失控边缘', '收尾',
      '禁忌释放', '加码', '临界', '崩溃', '封面镜头'],
    tags: ['[J市 · 五星级酒店 · 录制现场]', '[J市 · 五星级酒店 · 行政套房]', '[加密直播间 · 主机位]', '[导播间 · 监视器前]'],
    props: ['红色指示灯', '监视器的冷光', '麦克风的电流声', '架在三脚架上的机器', '那份签过字的合约'],
    audience: ['狂热粉丝007', '控场狂', '白衬衫控', 'VIP会员', '夜班剪辑师', '打赏榜第一', '镜头语言爱好者'],
    income: [3200, 4800, 5600, 7200, 9000],
    place: 'J市 · 五星级酒店行政套房（录制中）'
  },
  urban_romance: {
    acts: ['雨夜', '试探', '越界', '拉扯', '收束'],
    tags: ['[便利店屋檐下 · 雨夜]', '[写字楼 27 层 · 深夜]', '[出租车后座 · 凌晨]', '[她家楼下 · 路灯]'],
    props: ['便利店的暖光', '湿透的伞', '没喝完的美式', '手机屏幕上未发出的消息'],
    audience: ['同事小林', '楼下保安', '闺蜜群', '便利店店员'],
    income: [0, 0, 1200, 2600],
    place: '城中村一居室（月租 2300）'
  },
  court: {
    acts: ['入宫', '初觐', '暗涌', '交锋', '定局'],
    tags: ['[未央宫 · 偏殿]', '[御花园 · 暮色]', '[长阶之上]', '[灯下的书案前]'],
    props: ['鎏金香炉', '半盏冷茶', '袖中的一方旧帕', '殿外传更的梆子'],
    audience: ['掌事嬷嬷', '御前内侍', '隔壁宫的宫女', '朝中言官'],
    income: [0, 0, 50, 200],
    place: '宫城西侧偏院（一桌一榻）'
  },
  campus: {
    acts: ['开学', '同桌', '晚自习', '心动', '毕业前'],
    tags: ['[高三(7)班 · 下午]', '[教学楼天台 · 黄昏]', '[图书馆三楼 · 闭馆前]', '[校门口 · 晚自习后]'],
    props: ['摊开的错题本', '半瓶没喝完的橘子汽水', '被风掀起的卷子', '窗外的蝉声'],
    audience: ['后桌男生', '班长', '年级群', '贴吧小号'],
    income: [0, 0, 300, 800],
    place: '老小区六楼（与外婆同住）'
  },
  mystery: {
    acts: ['抵达', '第一次问询', '矛盾', '第二具', '真相'],
    tags: ['[招待所 · 走廊尽头]', '[案发现场 · 封条内]', '[值班室 · 凌晨三点]', '[档案室 · 尘封的铁柜]'],
    props: ['坏掉的走廊灯', '半页被撕掉的记录', '还在滴水的伞', '登记簿上被划掉的一行'],
    audience: ['值班民警', '前台小姑娘', '当地向导', '匿名来电'],
    income: [0, 0, 0, 500],
    place: '县城招待所 302'
  },
  survival: {
    acts: ['天亮前', '补给点', '选择', '失去', '下一站'],
    tags: ['[高架桥下 · 天将亮]', '[废弃加油站]', '[医院一楼 · 应急灯]', '[隧道口 · 风声]'],
    props: ['柴油发动机的低鸣', '快要用尽的手电', '半桶水', '生锈的消防斧'],
    audience: ['电台里的女声', '楼顶的哨兵', '隔壁小队', '无线电杂音'],
    income: [0, 0, 0, 0],
    place: '改装过的皮卡车厢'
  },
  fantasy: {
    acts: ['委托', '上路', '荒野', '旧誓', '决断'],
    tags: ['[灰鹭酒馆 · 深夜]', '[王都北门 · 破晓]', '[断桥营地]', '[旧神殿 · 石阶]'],
    props: ['快要熄的油灯', '羊皮地图的边缘', '剑柄上磨平的纹路', '空气中残留的魔法余味'],
    audience: ['醉酒的佣兵', '酒馆老板娘', '同行的商人', '神殿的老祭司'],
    income: [0, 0, 120, 800],
    place: '旅馆最便宜的单间（一晚 3 银币）'
  },
  blank: {
    acts: ['开端', '试探', '转折', '抉择', '余波'],
    tags: ['[此地 · 此刻]', '[场景之外]', '[静下来的那一刻]'],
    props: ['窗外的光', '桌上的一杯水', '空气里没有说完的话'],
    audience: ['旁观者', '路人甲', '旧识'],
    income: [0, 100, 300],
    place: '暂居之处'
  }
};

const OPENINGS = [
  '一切开始得很安静。你比约定时间早到了六分钟，而对方早就等在那里了，只是没有抬头。',
  '空气里有种被反复排练过的沉默。你们都知道接下来要发生什么，也都装作不确定。',
  '灯亮起来的时候，你注意到对方的手指不自觉地收紧了 —— 那是他唯一没能控制住的地方。'
];

const NARRATION = [
  '对方把呼吸压得很轻，却压不住肩线的起伏。你能看到他在努力把自己整理成一个“没问题”的样子。',
  '房间里只剩下设备的低鸣。那点声音在这种情况下显得格外刺耳，像有人拿着秒表。',
  '你做得很慢。慢是一种权力 —— 你有的是时间，而他必须等。',
  '他终于抬眼看你，那一眼里有些东西没能藏住：不是恐惧，比恐惧更麻烦，是一种近乎期待的东西。',
  '你注意到一个很细微的变化：他不再纠正自己的姿势了。抵抗变成了一种默许。',
  '窗外的城市还在运转，隔着玻璃是别人的生活。而这里，只有被安排好的下一步。',
  '他开口之前先咽了一下。那个动作很小，但你知道这句话对他来说很难。'
];

const DIALOGUE = [
  { speaker: '', text: '……我知道规则。我没有要反悔。' },
  { speaker: '', text: '你能不能，别看着我？你一直看着，我就……' },
  { speaker: '', text: '再给我一点时间。就一点点。' },
  { speaker: '', text: '我不是不配合。我只是不太习惯被人这么看得起。' },
  { speaker: '', text: '你想听真话吗？真话是我今天出门的时候，其实犹豫过。' },
  { speaker: '', text: '……好。听你的。' }
];

const OPTIONS = [
  {
    advance: ['加快节奏，把进度推进到下一阶段', '直接给出下一步指令，不解释理由', '抬手示意继续，把沉默拉长'],
    probe: ['问他一个他一定会回避的问题', '停下来，仔细读他此刻的表情', '用一句轻描淡写的话试探他的底线'],
    flip: ['故意打破原本的安排，让他意外', '告诉他今天的收益比昨天翻倍', '把决定权交给他，看他怎么用'],
    soften: ['放缓语气，说一句与身份不符的软话', '给他留出位置，把节奏交出去']
  }
];

const INNER = [
  '脑子里一片空白，只剩下等待。他在心里反复演练过每一句该说的话，结果一句都用不上。',
  '羞耻感已经变成一种实体的重量，压在胸口。他痛恨这种失序，却又发现自己正在习惯它。',
  '他告诉自己这只是交易。可交易不会让人心跳成这样 —— 这个借口今晚就要撑不住了。',
  '他其实希望有人叫停。但他更怕的是真的被叫停。',
  '这是他第一次觉得，被人看得这么清楚，居然会让人有点上瘾。'
];

const IDEA_NOTE = [
  '本幕可以往两个方向收：一是「直接推进」，把张力一次性释放；二是「边缘锁定」，把节奏拖到下一幕再引爆，观众的停留时长会更好看。',
  '如果想让人物更立体，可以在这轮插入一个现实向的细节 —— 一条催款信息、一个没接的电话，让镜头外的处境进来打扰一次。',
  '下一幕建议换机位：从全景切到特写，把叙事重心从动作转到表情。风险是节奏会慢，收益是情感更实。',
  '幕后提醒：他已经退让了两轮，这一轮适合反过来让他主动一次，反差会比继续加压更有冲击力。'
];

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function extractName(text, fallback) {
  const s = String(text || '');
  const quoted = s.match(/[「『“"]([^」』”"]{1,8})[」』”"]/);
  if (quoted) return quoted[1];
  const labeled = s.match(/(?:代号|姓名|名字|名为|叫做|叫)\s*[「『“"]?([^\s，。、,；;「」『』“”"]{1,6})/);
  if (labeled) return labeled[1];
  const first = s.trim().split(/[。，,、\s]/)[0];
  if (first && first.length <= 8) return first.replace(/^(一位|一个|那个|这个)/, '');
  return fallback;
}

const POSITIVE = /好感|愉悦|兴奋|心动|信任|士气|斗志|羁绊|依赖/;
const NEGATIVE_SOFT = /羞耻|尴尬|压力|疑虑|警惕|猜忌|畏惧|恐惧|厌恶/;
const HEAVY = /痛苦|伤势|沉溺|执念/;

function initialBase(key) {
  const span = POSITIVE.test(key) ? 34 : NEGATIVE_SOFT.test(key) ? 12 : 18;
  return 10 + (hash(key) % span);
}

function driftEmotions(setup, prev, action, index) {
  const next = {};
  const strength = 3 + (index % 3) * 3;
  const act = String(action || '');
  const gentle = /温柔|安抚|放缓|轻|软|解释|道歉|陪伴|倾听/.test(act);
  const harsh = /命令|惩罚|强制|加快|逼|压|冷|警告|拒绝/.test(act);
  const bold = /主动|直白|坦白|表白|靠近|触碰|亲吻|拥抱/.test(act);

  setup.emotions.forEach((key, i) => {
    const base = prev && prev[key] !== undefined ? Number(prev[key]) : initialBase(key);
    let delta = ((hash(key + index) % (strength * 2 + 1)) - strength) * 0.7;
    if (POSITIVE.test(key)) delta += bold ? 7 : 3;
    if (NEGATIVE_SOFT.test(key)) delta += harsh ? 6 : gentle ? -5 : 1.5;
    if (HEAVY.test(key)) delta += bold || harsh ? 5 : 2;
    if (POSITIVE.test(key) && gentle) delta += 4;
    if (NEGATIVE_SOFT.test(key) && bold) delta -= 2;
    delta += (i === 0 ? 2 : 0);
    next[key] = Math.max(0, Math.min(100, Math.round(base + delta)));
  });
  return next;
}

function nextClock(prev, index) {
  const [h, m] = String(prev?.time || '23:40').split(':').map((n) => Number(n) || 0);
  const total = (h * 60 + m + 4 + ((index * 7) % 19)) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function phaseOf(clock) {
  const h = Number(String(clock).split(':')[0]) || 0;
  if (h >= 5 && h < 11) return '清晨';
  if (h >= 11 && h < 14) return '正午';
  if (h >= 14 && h < 18) return '午后';
  if (h >= 18 && h < 23) return '夜晚';
  return '深夜';
}

function buildPanels(setup, ctx) {
  const out = {};
  const all = [...(setup.topPanels || []), ...(setup.bottomPanels || [])];
  for (const def of all) {
    const id = def.id;
    const label = def.label;
    if (id === 'inner_voice') out[id] = `${ctx.target}：${pick(INNER, ctx.seed)}`;
    else if (id === 'bullet') out[id] = Array.from({ length: 6 }, (_, i) => `[${pick(ctx.flavor.audience, ctx.seed + i * 5 + 1)}]: ${pick(BULLETS, ctx.seed + i * 13)}`);
    else if (id === 'roster') out[id] = ctx.roster;
    else if (id === 'ideas') out[id] = pick(IDEA_NOTE, ctx.seed);
    else if (id === 'living') {
      out[id] = [
        { k: '当前', v: ctx.flavor.place },
        { k: '你的日常居所', v: ctx.flavor.place.includes('酒店') ? '20㎡出租屋' : ctx.flavor.place },
        { k: '本次预计收益', v: `${(ctx.flavor.income[ctx.index % ctx.flavor.income.length] / 1000).toFixed(1)}k - ${(ctx.flavor.income[(ctx.index + 1) % ctx.flavor.income.length] / 1000).toFixed(1)}k` },
        { k: '最想改善', v: pick(['换一个有热水的房子', '把这个月的账还上', '攒够离开这座城市的钱', '给家里打一次电话'], ctx.seed) }
      ];
    } else if (id === 'mood') {
      out[id] = [
        `进门时：${pick(['压着嗓子说话', '不看你的眼睛', '把外套叠得很整齐'], ctx.seed)}`,
        `被点破后：${pick(['沉默了三秒', '呼吸乱了一拍', '手指扣紧了桌沿'], ctx.seed + 3)}`,
        `现在：${pick(['开始配合', '在等你下一步', '把抵抗换成了别的东西'], ctx.seed + 5)}`
      ];
    } else if (id === 'relationship') {
      out[id] = [
        `[${ctx.target}] 核心对象 — ${pick(['在等你先开口', '已经退了一步', '还没决定要不要信你'], ctx.seed)}`,
        `[${pick(ctx.flavor.audience, ctx.seed + 2)}] 旁观者 — ${pick(['什么都知道一点', '消息很灵', '在场但没说话'], ctx.seed + 2)}`,
        '[你自己] 主角 — 手里握着时间和条件，也握着代价'
      ];
    } else if (id === 'rumor' || id === 'campus' || id === 'tavern' || id === 'radio') {
      out[id] = Array.from({ length: 5 }, (_, i) => `[${pick(ctx.flavor.audience, ctx.seed + i * 5)}]: ${pick(RUMORS, ctx.seed + i * 11)}`);
    } else if (id === 'evidence') {
      out[id] = ['[01] 现场的第一处矛盾 — 待验证', '[02] 有人比约定时间早到 — 指向明确', '[03] 被划掉的那一行记录 — 还差一个名字'];
    } else if (id === 'suspects') {
      out[id] = [`[${ctx.target}] 中心人物 — 嫌疑 62 — 说辞每次都刚好避开关键`, '[值班的人] 目击者 — 嫌疑 30 — 太配合了', '[来过的客人] 关联人 — 嫌疑 48 — 有不在场证明'];
    } else if (id === 'supplies' || id === 'purse' || id === 'ledger') {
      out[id] = [{ k: '存量', v: pick(['还能撑四天', '够用两次', '见底了'], ctx.seed) }, { k: '消耗速度', v: '比预想快' }, { k: '风险', v: pick(['再走两天就必须做决定', '需要一次补给', '勉强够用'], ctx.seed + 4) }];
    } else if (id === 'party' || id === 'club') {
      out[id] = [`[${ctx.target}] 同行 — 状态稳定 — 有事没告诉你`, `[${pick(ctx.flavor.audience, ctx.seed + 1)}] 熟人 — 状态一般 — 关键时刻靠得住`];
    } else if (id === 'threads') {
      out[id] = ['〔已触发〕你比约定时间更早掌握了节奏', '〔已触发〕对方第一次主动开口', '〔待引爆〕那份合约里还有一条你没读到的条款', '〔待引爆〕镜头外有第三个人知道今晚的事'];
    } else if (id === 'act_map') {
      out[id] = `全剧按四幕推进：起（建立关系与规则）→ 承（试探与退让）→ 转（越界与代价）→ 收（选择与后果）。当前处于第 ${ctx.index + 1} 轮，正在「${ctx.state.act}」。下一步的岔路口是：继续加压，还是把节奏交还给他。`;
    } else if (id === 'persona_card') {
      out[id] = [{ k: '代号', v: ctx.target }, { k: '身份', v: pick(['受过高等教育的体面人', '签了合约的当事人', '被安排到这里的角色'], ctx.seed) }, { k: '软肋', v: pick(['在意别人怎么看他', '怕被看穿，又怕被无视', '还欠着一笔人情'], ctx.seed + 2) }, { k: '此刻', v: pick(['在等你先动', '已经退了一步', '在算什么时候可以不用装'], ctx.seed + 6) }];
    } else {
      out[id] = def.kind === 'list'
        ? [`[${label}] ${pick(RUMORS, ctx.seed)}`]
        : `${label}：${pick(NARRATION, ctx.seed)}`;
    }
  }
  return out;
}

const BULLETS = [
  '这个节奏我爱了，求剪辑别切太快', '就这一句台词能回票价', '他刚才那个吞咽是认真的吗',
  '镜头再近一点，我要看表情', '导演是懂留白的，急死我了', '这一版比上一版高级太多',
  '不要停在这里啊', '打赏已到，继续', '这个人物的反差感太强了', '今晚的封面就用这一帧'
];

const RUMORS = [
  '听说他昨天又熬到了三点', '有人看到他们一起上了电梯', '这单的价码比市面高了三倍',
  '别信他说的那句没关系', '合约里还有一条补充条款，没人提过', '外面的车已经等了两个小时了',
  '上一个这么干的人，现在不在这个城市了', '今晚会有第三方介入'
];

function buildRoster(setup, index, flavor) {
  const base = [
    '[01] 白衬衫 — 第一支 — 状态：已完成并归档',
    '[02] 灰帽 — 第三支 — 状态：素材未过审，待重录'
  ];
  const dynamic = [
    `[0${(index % 7) + 3}] ${pick(flavor.audience, index * 3)} — 第 ${index + 2} 支 — 状态：录制中，预计今晚收尾`,
    `[0${(index % 5) + 4}] 匿名委托方 — 第 ${index + 3} 支 — 状态：已预约下周`
  ];
  return [...base, ...dynamic];
}

/**
 * 生成一轮本地剧情
 * @param {{session:object, cursor:number, action?:string, onProgress?:(blocks:any[])=>void}} opts
 */
export async function localRound({ session, cursor, action, onProgress }) {
  const setup = session.setup;
  const prev = cursor >= 0 ? session.rounds[cursor] : null;
  const index = prev ? prev.i + 1 : 0;
  const flavor = FLAVOR[setup.templateId] || FLAVOR.blank;
  const seed = hash(`${session.id}|${index}|${action || ''}`);
  const target = extractName(setup.targetRole, '对方');

  const state = {
    act: `${index < flavor.acts.length ? flavor.acts[index] : flavor.acts[flavor.acts.length - 1]}`,
    phase: phaseOf(nextClock(prev?.scene, index))
  };
  const ctx = { setup, index, seed, target, flavor, roster: buildRoster(setup, index, flavor), state };

  const blocks = [];
  const tag = `[${(setup.opening || '').match(/\[[^\]]+\]/)?.[0]?.slice(1, -1) || flavor.tags[index % flavor.tags.length].slice(1, -1)}]`;
  blocks.push({ type: 'tag', text: tag });
  blocks.push({ type: 'narration', text: index === 0 && !action ? pick(OPENINGS, seed) : `${action ? `你选择了：${action}。` : ''}${pick(NARRATION, seed)}` });
  blocks.push({ type: 'narration', text: pick(NARRATION, seed + 5) });
  const line = pick(DIALOGUE, seed + 2);
  blocks.push({ type: 'dialogue', speaker: target, text: line.text });
  if (index > 0) blocks.push({ type: 'narration', text: pick(NARRATION, seed + 9) });

  const bank = OPTIONS[0];
  const options = [
    pick(bank.advance, seed),
    pick(bank.probe, seed + 3),
    pick(index % 2 === 0 ? bank.flip : bank.soften, seed + 7)
  ];

  // 模拟逐段写作，让离线模式也有“正在生成”的感觉
  if (onProgress) {
    for (let i = 1; i <= blocks.length; i += 1) {
      onProgress(blocks.slice(0, i));
      await new Promise((r) => setTimeout(r, 90 + Math.random() * 120));
    }
  }

  const emotions = driftEmotions(setup, prev?.emotions, action, index);
  const panels = buildPanels(setup, ctx);

  return {
    scene: {
      act: `第${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][index] || index + 1}幕 · ${state.act}`,
      location: tag.slice(1, -1),
      time: nextClock(prev?.scene, index),
      phase: state.phase
    },
    memory: `${prev?.memory ? `${prev.memory} ` : ''}第${index + 1}轮：${blocks.filter((b) => b.type === 'narration').map((b) => b.text).join(' ').slice(0, 60)}…`,
    emotions,
    blocks,
    options,
    panels,
    engine: 'local'
  };
}
