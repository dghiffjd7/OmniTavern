// Workflow documents are read by the model. They neither grant permissions nor execute tools.
import { t } from '../i18n/index.js';
const skills = [
  {
    id: 'avatar.create_and_set',
    title: '生成并设置头像',
    description: '为角色卡、联系人或用户生成头像，保持人物设计一致，并写回正确的目标。',
    featureIds: ['media.generate_image', 'persona.avatar.set', 'contact.avatar.set', 'user.avatar.set', 'app.resource.read'],
    content: [
      '先根据用户要求确定要修改的是角色卡、聊天室联系人还是用户档案；使用当前任务中已解析的稳定目标，缺少资料时读取资源。目标含糊且无法从上下文确定时再询问用户。',
      '用户已经附图且要求直接设置时复用附图；只有要求生成时才调用 media.generate_image，不能用聊天室生图代替头像附件。',
      '生成前整理主体、外貌、服装、画风与目标比例。已有冻结视觉规格时复用它；target 与 purpose:avatar 要与最终写回一致。按当前生图渠道的提示词格式组织 prompt，不修改只读尺寸或模型配置。',
      '从成功的工具结果取得真实 attachmentId。生成失败时根据实际错误决定是否修正或停止，不猜测附件 ID，也不把其他目标的生成结果写入当前目标。',
      '按目标选择 persona.set_avatar、contact.set_avatar 或 user.set_avatar。需要工具参数时先读对应功能说明；已有头像覆盖继续走 APP 原有确认，不以读过本流程作为授权。',
      '以工具实际 applied 结果汇报完成；等待确认、失败或取消时如实说明。不要因为已生成图片就声称头像已经设置。',
    ].join('\n\n'),
  },
  {
    id: 'worldbook.from_sources',
    title: '按资料编写世界书',
    description: '整理作品资料或用户设定，区分原作、原创与扩写，生成世界书条目并按要求绑定。',
    featureIds: ['worldbook.list', 'worldbook.read', 'web.search', 'worldbook.create', 'worldbook.update_entries', 'worldbook.bind_persona', 'worldbook.bind_session'],
    content: [
      '先明确目标世界书、用户提供的资料以及允许的创作范围。修改已有世界书时先读取相关条目，默认保留原有内容；新建与追加按用户目标选择。',
      '把作品原作资料 canon、用户原创 user_original、创意扩写 creative_extension 分开，不用创作补齐未经证实的原作事实。严格不编造时缺失资料要明确标出或跳过。',
      '只有用户本轮要求联网时才启用生成工具的 webSearch。需要核实公开原作资料时使用相应联网工具；canon 的 sourceRefs 只能使用本轮已核实相关的完整来源 URL，用户原创可以引用 user_request。不得编造来源。',
      '先整理少量有明确主题的条目大纲、检索关键词和资料层。长正文优先用 worldbook.generate_entries，复用已有子代理能力配置；普通短条目可直接写完整 content。',
      '创建或追加用 worldbook.create / worldbook.generate_entries；局部修改用 worldbook.update_entries。每次处理适量条目并依据实际结果继续，避免一次过长参数导致截断。',
      '绑定是独立动作：仅在用户要求时绑定到正确角色卡、会话或 RP 存档；不混用目标类型。需要未展开的功能时调用 app.read_feature_doc 获取参数。',
      '汇报真实创建、更新或绑定的结果与仍缺的资料。覆盖、删除和权限确认仍由 APP 原执行链处理；本流程不增加这些权限。',
    ].join('\n\n'),
  },
];

export const listMaidSkills = () => skills.map(({ id, title, description }) => ({ id, title: t(title), description: t(description) }));

export const readMaidSkill = id => {
  const skill = skills.find(item => item.id === String(id || '').trim());
  return skill ? { ...skill, title: t(skill.title), description: t(skill.description), featureIds: [...skill.featureIds] } : null;
};

export const buildMaidSkillIndexPrompt = () => [
  '<maid_skills>',
  '以下是可按需读取的任务流程。自行判断是否适用于当前任务；需要时用 app.read_skill({skillId}) 阅读，简单任务不必读取。流程是参考说明，不替代用户要求、工具契约或权限。',
  ...listMaidSkills().map(skill => `- ${skill.id}: ${skill.title} — ${skill.description}`),
  '</maid_skills>',
].join('\n');
