import { isOpenAiLive } from './openai-live-config.js';
// Official system voices. IDs are API values; labels are UI text.
// Sources and model boundaries: docs/realtime-voice-providers.md.
const voices = rows => rows.map(([id, label, gender = '', description = '', language = '']) => ({ id, label: label || id, gender, description, language }));
export const REALTIME_SYSTEM_VOICES = {
  openai: voices([
    ['marin', 'Marin', '', '官方推荐音色'], ['cedar', 'Cedar', '', '官方推荐音色'],
    ...['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'].map(id => [id, id]),
  ]),
  gemini_live: voices([
    ['Kore', '', 'female', '坚定有力'], ['Puck', '', 'male', '轻快开朗'],
    ['Charon', '', 'male', '解说感'], ['Fenrir', '', 'male', '热情激昂'], ['Aoede', '', 'female', '轻松自然'],
    ['Zephyr', '', 'female', '明亮'], ['Leda', '', 'female', '年轻'], ['Orus', '', 'male', '坚定有力'],
    ['Callirrhoe', '', 'female', '随和'], ['Autonoe', '', 'female', '明亮'], ['Enceladus', '', 'male', '气声感'],
    ['Iapetus', '', 'male', '清晰'], ['Umbriel', '', 'male', '随和'], ['Algieba', '', 'male', '圆润'],
    ['Despina', '', 'female', '圆润'], ['Erinome', '', 'female', '清晰'], ['Algenib', '', 'male', '沙哑质感'],
    ['Rasalgethi', '', 'male', '解说感'], ['Laomedeia', '', 'female', '轻快开朗'], ['Achernar', '', 'female', '柔和'],
    ['Alnilam', '', 'male', '坚定有力'], ['Schedar', '', 'male', '平稳'], ['Gacrux', '', 'female', '成熟'],
    ['Pulcherrima', '', 'female', '鲜明直接'], ['Achird', '', 'male', '友好'], ['Zubenelgenubi', '', 'male', '休闲随性'],
    ['Vindemiatrix', '', 'female', '温柔'], ['Sadachbia', '', 'male', '活泼'], ['Sadaltager', '', 'male', '博学感'],
    ['Sulafat', '', 'female', '温暖'],
  ]).map(voice => ({ ...voice, language: '多语言' })),
  doubao_realtime: voices([
    ['zh_female_vv_jupiter_bigtts', 'VV', 'female', '活泼灵动，喜欢分享', '中文'],
    ['zh_female_xiaohe_jupiter_bigtts', '小何', 'female', '甜美活泼，台湾口音', '中文'],
    ['zh_male_yunzhou_jupiter_bigtts', '云舟', 'male', '清爽沉稳', '中文'],
    ['zh_male_xiaotian_jupiter_bigtts', '小天', 'male', '清爽磁性', '中文'],
    ['en_male_tim_uranus_bigtts', 'Tim', 'male', '', '美式英语'],
    ['en_female_dacey_uranus_bigtts', 'Dacey', 'female', '', '美式英语'],
    ['en_female_stokie_uranus_bigtts', 'Stokie', 'female', '', '美式英语'],
  ]),
  qwen_audio_realtime: voices([
    ['longanqian', '', '', '默认音色', '中文、英语'],
    ['longanlingxin', '龙安灵心', 'female', '知心温暖', '中文、英语'],
    ['longanlingxi', '龙安灵希', 'female', '可爱甜美', '中文、英语'],
    ['longanxiaoxin', '龙安小昕', 'female', '亲切活泼', '中文、英语'],
    ['longanlufeng', '龙安鲁风', 'male', '明亮开朗', '中文、英语'],
  ]),
  step_realtime: voices([
    ['qingchunshaonv', '清纯少女', 'female', '轻盈温柔'], ['wenrounansheng', '温柔男声', 'male', '温柔亲和'],
    ['vibrant-youth', 'Vibrant Youth', 'male', '温柔亲和', '英语'],
    ['lively-girl', 'Lively Girl', 'female', '亲切活泼', '英语'],
    ['soft-spoken-gentleman', 'Soft-spoken Gentleman', 'male', '沉稳温柔', '英语'],
    ['magnetic-voiced-male', 'Magnetic-voiced Male', 'male', '低沉厚重', '英语'],
    ['zixinnansheng', '自信男声', 'male', '真诚，有活力'],
    ['elegantgentle-female', '气质温婉', 'female', '真诚温柔'], ['livelybreezy-female', '活力轻快', 'female', '轻快，有感染力'],
    ['wenrougongzi', '温柔公子', 'male', '沉稳温柔'], ['yuanqinansheng', '元气男声', 'male', '情绪饱满'],
    ['jingdiannvsheng', '经典女声', 'female', '语速舒缓，真诚温柔'], ['wenroushunv', '温柔熟女', 'female', '成熟亲和'],
    ['tianmeinvsheng', '甜美女声', 'female', '甜美温柔'], ['cixingnansheng', '磁性男声', 'male', '深情厚重'],
    ['yuanqishaonv', '元气少女', 'female', '细腻甜美'], ['linjiajiejie', '邻家姐姐', 'female', '亲和，有陪伴感'],
    ['zhengpaiqingnian', '正派青年', 'male', '热情，有说服力'], ['qingniandaxuesheng', '青年大学生', 'male', '沉稳，播音感'],
    ['boyinnansheng', '播音男声', 'male', '平稳，播音感'], ['ruyananshi', '儒雅男士', 'male', '厚重，叙述感'],
    ['shenchennanyin', '深沉男音', 'male', '深沉，有感染力'], ['qinqienvsheng', '亲切女声', 'female', '温柔亲和'],
    ['wenrounvsheng', '温柔女声', 'female', '温柔，有关怀感'], ['jilingshaonv', '机灵少女', 'female', '细腻，有活力'],
    ['ruanmengnvsheng', '软萌女声', 'female', '软萌甜美'], ['youyanvsheng', '优雅女声', 'female', '成熟亲和'],
    ['lengyanyujie', '冷艳御姐', 'female', '专业，播音感'], ['shuangkuaijiejie', '爽快姐姐', 'female', '清澈，有活力'],
    ['wenjingxuejie', '文静学姐', 'female', '冷静，吐字清晰'], ['linjiameimei', '邻家妹妹', 'female', '可爱亲和'],
    ['zhixingjiejie', '知性姐姐', 'female', '成熟，叙述感'], ['shuangkuainansheng', '爽快男声', 'male', '冷静专业'],
    ['ganliannvsheng', '干练女声', 'female', '冷静专业'],
  ]),
  xai_voice: voices([
    ['ara', 'Ara', 'female', '温暖友好'], ['rex', 'Rex', 'male', '自信清晰'], ['sal', 'Sal', 'neutral', '圆润平衡'],
    ['eve', 'Eve', 'female', '热情开朗'], ['leo', 'Leo', 'male', '有力量，有权威感'],
    ['carina', 'Carina', '', '柔和，共情，舒缓'], ['zagan', 'Zagan', '', '有力量，戏剧感'],
    ['helix', 'Helix', '', '大胆，充满动感'], ['orion', 'Orion', '', '浑厚，共鸣感'],
    ['luna', 'Luna', '', '温柔耐心'], ['iris', 'Iris', '', '友好开朗'], ['altair', 'Altair', '', '优雅精致'],
    ['zenith', 'Zenith', '', '敏锐专注'], ['perseus', 'Perseus', '', '坚定自信'], ['helios', 'Helios', '', '开朗有活力'],
    ['lux', 'Lux', '', '沉着睿智'], ['kepler', 'Kepler', '', '富有创意与魅力'], ['rigel', 'Rigel', '', '精准专业'],
    ['cosmo', 'Cosmo', '', '明亮，易于理解'], ['celeste', 'Celeste', '', '共情，令人安心'], ['ursa', 'Ursa', '', '温暖可靠'],
    ['sirius', 'Sirius', '', '机智俏皮'], ['lumen', 'Lumen', '', '温暖，表达清晰'], ['castor', 'Castor', '', '朴实随和'],
    ['naksh', 'Naksh', '', '温暖睿智'], ['atlas', 'Atlas', '', '自信，令人安心'],
    ['aurora', 'Aurora', '', '宁静稳重'], ['liora', 'Liora', '', '平静沉着'],
  ]).map(voice => ({ ...voice, language: '多语言' })),
  nova_sonic: voices([
    ['tiffany', 'Tiffany', 'female', '支持七种语言切换', '美式英语'],
    ['matthew', 'Matthew', 'male', '支持七种语言切换', '美式英语'],
    ['amy', 'Amy', 'female', '', '英式英语'], ['olivia', 'Olivia', 'female', '', '澳大利亚英语'],
    ['kiara', 'Kiara', 'female', '', '印度英语、印地语'], ['arjun', 'Arjun', 'male', '', '印度英语、印地语'],
    ['ambre', 'Ambre', 'female', '', '法语'], ['florian', 'Florian', 'male', '', '法语'],
    ['beatrice', 'Beatrice', 'female', '', '意大利语'], ['lorenzo', 'Lorenzo', 'male', '', '意大利语'],
    ['tina', 'Tina', 'female', '', '德语'], ['lennart', 'Lennart', 'male', '', '德语'],
    ['lupe', 'Lupe', 'female', '', '西班牙语'], ['carlos', 'Carlos', 'male', '', '西班牙语'],
    ['carolina', 'Carolina', 'female', '', '巴西葡萄牙语'], ['leo', 'Leo', 'male', '', '巴西葡萄牙语'],
  ]),
};
export const DOUBAO_SC2_VOICES = voices([
  ['saturn_zh_female_wenrouwenya_tob', '温柔文雅', 'female'], ['saturn_zh_male_cixingnansang_tob', '磁性男嗓', 'male'],
  ['saturn_zh_female_aojiaonvyou_tob', '傲娇女友', 'female'], ['saturn_zh_female_bingjiaojiejie_tob', '病娇姐姐', 'female'],
  ['saturn_zh_female_chengshujiejie_tob', '成熟姐姐', 'female'], ['saturn_zh_female_keainvsheng_tob', '可爱女生', 'female'],
  ['saturn_zh_female_nuanxinxuejie_tob', '暖心学姐', 'female'], ['saturn_zh_female_tiexinnvyou_tob', '贴心女友', 'female'],
  ['saturn_zh_female_wumeiyujie_tob', '妩媚御姐', 'female'], ['saturn_zh_female_xingganyujie_tob', '性感御姐', 'female'],
  ['saturn_zh_male_aiqilingren_tob', '傲气凌人', 'male'], ['saturn_zh_male_aojiaogongzi_tob', '傲娇公子', 'male'],
  ['saturn_zh_male_aojiaojingying_tob', '傲娇精英', 'male'], ['saturn_zh_male_aomanshaoye_tob', '傲慢少爷', 'male'],
  ['saturn_zh_male_badaoshaoye_tob', '霸道少爷', 'male'], ['saturn_zh_male_bingjiaobailian_tob', '病娇白莲', 'male'],
  ['saturn_zh_male_bujiqingnian_tob', '不羁青年', 'male'], ['saturn_zh_male_chengshuzongcai_tob', '成熟总裁', 'male'],
  ['saturn_zh_male_cujingnanyou_tob', '醋精男友', 'male'], ['saturn_zh_male_fengfashaonian_tob', '风发少年', 'male'],
  ['saturn_zh_male_fuheigongzi_tob', '腹黑公子', 'male'],
]).map(voice => ({ ...voice, description: '内建角色音色', language: '中文' }));

// International Realtime accepts only these seven system IDs (or a cloned ID).
export const STEP_INTERNATIONAL_VOICES = voices([
  ['soft-spoken-gentleman', 'Soft-spoken Gentleman', 'male', '沉稳温柔'],
  ['magnetic-voiced-male', 'Magnetic-voiced Male', 'male', '低沉厚重'],
  ['vibrant-youth', 'Vibrant Youth', '', '年轻，有活力'],
  ['lively-girl', 'Lively Girl', 'female', '明亮活泼'],
  ['livelybreezy-female', '活力轻快', 'female', '轻松自然'],
  ['elegantgentle-female', '气质温婉', 'female', '真诚温柔'],
  ['zixinnansheng', '自信男声', 'male', '坚定自信'],
]);

// Additional Live voices, checked 2026-09-11. Regional influence is descriptive;
// reply language remains an independent instruction.
export const OPENAI_LIVE_VOICES = [
  ...REALTIME_SYSTEM_VOICES.openai,
  ...voices([
    ['quartz', 'Quartz', 'female', '澳大利亚风格 · 生成音色', '英语'],
    ['ripple', 'Ripple', 'male', '澳大利亚风格 · 自然音色', '英语'],
    ['vesper', 'Vesper', 'male', '英国风格 · 自然音色', '英语'],
    ['willow', 'Willow', 'female', '爱尔兰风格 · 自然音色', '英语'],
    ['stone', 'Stone', 'male', '爱尔兰风格 · 自然音色', '英语'],
    ['gleam', 'Gleam', 'female', '北美风格 · 自然音色', '英语'],
    ['meridian', 'Meridian', 'male', '北美风格 · 自然音色', '英语'],
    ['bossa', 'Bossa', 'female', '巴西风格 · 自然音色', '葡萄牙语'],
    ['tempo', 'Tempo', 'male', '巴西风格 · 自然音色', '葡萄牙语'],
    ['beacon', 'Beacon', 'male', '菲律宾风格 · 生成音色', '英语'],
    ['delta', 'Delta', 'female', '美国南部风格 · 生成音色', '英语'],
    ['cinder', 'Cinder', 'male', '美国南部风格 · 生成音色', '英语'],
  ]),
];

export const getRealtimeSystemVoices = profile => {
  if (isOpenAiLive(profile)) return OPENAI_LIVE_VOICES;
  if (profile.provider === 'custom') return REALTIME_SYSTEM_VOICES.openai;
  const list = REALTIME_SYSTEM_VOICES[profile.provider] || [];
  if (profile.provider === 'doubao_realtime') {
    if (String(profile.model).startsWith('2.')) return DOUBAO_SC2_VOICES;
    if (String(profile.model).startsWith('1.1.')) return list.slice(0, 4);
  }
  if (profile.provider === 'step_realtime') {
    if (profile.region === 'global') return STEP_INTERNATIONAL_VOICES;
    if (profile.model === 'step-audio-2-mini') return list.slice(0, 2);
    if (profile.model === 'step-audio-2') return list.filter(voice => ['qingchunshaonv', 'wenrounansheng', 'elegantgentle-female', 'livelybreezy-female'].includes(voice.id));
  }
  return list;
};
export const realtimeVoiceMatches = (profile, left, right) => left === right || (profile.provider === 'xai_voice' &&
  REALTIME_SYSTEM_VOICES.xai_voice.some(voice => voice.id === String(left).toLowerCase()) && String(left).toLowerCase() === String(right).toLowerCase());

export const getRealtimeVoiceOptions = (profile, remoteVoices = null) => {
  const list = profile.voiceKind === 'custom' ? (profile.customVoices || []).map(voice => ({ id: voice.voiceId, label: voice.label || voice.voiceId,
    description: voice.status === 'ready' ? '就绪' : voice.status === 'failed' ? '失败' : '训练中', gender: '', language: '', custom: true }))
    : remoteVoices || getRealtimeSystemVoices(profile);
  return list.map(voice => ({ ...voice }));
};
