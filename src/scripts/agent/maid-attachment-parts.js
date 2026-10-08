const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

export const normalizeMaidImageAttachments = (attachments = []) => (
  (Array.isArray(attachments) ? attachments : [])
    .map(item => ({
      id: trim(item?.id),
      name: trim(item?.name),
      mime: trim(item?.mime),
      size: Number(item?.size || 0) || 0,
      url: trim(item?.llmUrl || item?.url),
      kind: trim(item?.kind, 'image'),
    }))
    .filter(item => item.kind === 'image' && item.url)
);

export const getMaidImageAttachmentsFromContext = (context = {}) => (
  normalizeMaidImageAttachments(context?.maidAttachments)
);

export const buildMaidImageAttachmentSummary = (attachments = []) => {
  const images = normalizeMaidImageAttachments(attachments);
  if (!images.length) return '';
  return images
    .map((image, index) => {
      const meta = [image.name, image.mime, image.size ? `${image.size} bytes` : ''].filter(Boolean).join(', ');
      return `图片${index + 1}${meta ? `：${meta}` : ''}`;
    })
    .join('\n');
};

export const buildMaidUserContentWithImages = (text = '', attachments = []) => {
  const prompt = trim(text);
  const images = normalizeMaidImageAttachments(attachments);
  if (!images.length) return prompt;
  return [
    { type: 'text', text: prompt || '请查看我附上的图片。' },
    ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } })),
  ];
};

const FILE_TARGET_LABELS = Object.freeze({
  global: '全局',
  role_card: '角色卡',
  chat_room: '聊天室',
  role_card_worldbook: '角色卡已绑定的世界书',
  worldbook: '指定世界书',
  preset: '预设',
  new_role_card: '新建角色卡',
  preset_library: '预设库（导入后切换为当前预设）',
});

// 一句话描述本地解析结果，例如「世界书「星港」：24 条」
export const describeMaidFileAttachment = (file = {}) => {
  const counts = file?.counts || {};
  const label = trim(file?.label, '文件');
  const title = trim(file?.title);
  const parts = [];
  if (file?.format === 'character_card') {
    parts.push(`开场白 ${counts.greetings || 0}`);
    if (counts.worldbookEntries) parts.push(`内嵌世界书 ${counts.worldbookEntries} 条`);
    if (counts.regexRules) parts.push(`正则 ${counts.regexRules} 条`);
    if (counts.scripts) parts.push(`脚本 ${counts.scripts} 个`);
    if (counts.expressions) parts.push(`表情 ${counts.expressions} 张（导入为该角色的表情贴图包）`);
    if (counts.backgrounds) parts.push('背景 1 张（设为该角色创意写作的聊天背景）');
  } else if (file?.format === 'worldbook') {
    parts.push(`${counts.entries || 0} 条`);
    if (counts.boundRegexSets) parts.push(`附带正则 ${counts.boundRegexSets} 组`);
  } else if (file?.format === 'regex') {
    parts.push(`${counts.rules || 0} 条规则`);
  } else if (file?.format === 'script') {
    parts.push(`${counts.scripts || 0} 个脚本`);
  } else if (file?.format === 'preset') {
    parts.push(`${counts.prompts || 0} 条提示词`);
  }
  return `${label}${title ? `「${title}」` : ''}${parts.length ? `：${parts.join('，')}` : ''}`;
};

const describeFileLine = (item, head) => {
  const file = item.file;
  const targets = (file.targets || []).map(key => FILE_TARGET_LABELS[key] || key);
  const extra = [
    `附件ID ${trim(item.id)}`,
    targets.length ? `可导入到：${targets.join('、')}` : '',
    (file.candidates || []).length > 1 ? `格式存疑，可能是：${file.candidates.join('、')}` : '',
    ...(file.diagnostics || []),
  ].filter(Boolean);
  return `${head}（${extra.join('；')}）`;
};

const FILE_IMPORT_GUIDE = '以上文件由 APP 在本地解析，女仆看不到原文。导入世界书或正则用 attachment.import（传附件ID和目标）；用户没说导入到哪里时只问一次：世界书问全局、哪个角色卡还是哪个聊天室，正则问全局、聊天室还是某张卡的世界书。用户回答后沿用同一个附件ID继续，不要求重新上传。同名世界书冲突时问用户新建副本还是覆盖。角色卡用 target new_role_card，导入为新卡但默认不切换，用户要求切换时带 switchTo: true；重名时问用户是否仍新建同名卡（onNameConflict: copy）；脚本问导入到全局、哪张角色卡还是哪个预设，导入后保持关闭，用户要启用再用 script.toggle_many。预设用 target preset_library，导入后和手动导入一样切换为当前创意写作预设。卡和预设附带的世界书、开场白、正则、脚本、系统提示词默认全部导入，用户说不要哪项时用 exclude 排除。整套预设设定档请用户在预设面板导入。不要用其他工具按摘要重建文件内容。';

// 模型看到的文件摘要：只有本地解析结果和附件 ID，没有文件原文。
// recent：之前上传、尚未导入的文件（追问目标后下一轮继续用）
export const buildMaidFileAttachmentSummary = (attachments = [], { recent = [] } = {}) => {
  // 图片序号与「用户附图」一致（按所有图片排序）
  const imageIds = normalizeMaidImageAttachments(attachments).map(item => item.id);
  const list = (Array.isArray(attachments) ? attachments : []).filter(item => item?.file && trim(item?.id));
  const earlier = (Array.isArray(recent) ? recent : []).filter(item => item?.file && trim(item?.id));
  if (!list.length && !earlier.length) return '';
  let fileIndex = 0;
  const lines = list.map((item) => {
    const imageIndex = imageIds.indexOf(trim(item.id));
    return describeFileLine(item, item.kind === 'image' && imageIndex >= 0
      ? `图片${imageIndex + 1} 同时是${describeMaidFileAttachment(item.file)}`
      : `文件${(fileIndex += 1)}「${trim(item.name, '未命名')}」：${describeMaidFileAttachment(item.file)}`);
  });
  if (earlier.length) {
    lines.push('之前上传、尚未导入的文件：');
    earlier.forEach(item => lines.push(describeFileLine(item, `「${trim(item.name, '未命名')}」：${describeMaidFileAttachment(item.file)}`)));
  }
  return [...lines, FILE_IMPORT_GUIDE].join('\n');
};
