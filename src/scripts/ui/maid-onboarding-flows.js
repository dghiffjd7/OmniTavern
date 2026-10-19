const clicked = target => (event, payload) => event === 'target-click' && payload?.target === target;

export const MAID_ONBOARDING_TARGET_SELECTORS = Object.freeze({
  // 写作房间没有列表顶栏的设置按钮：「设定」「API设定」在房间右上角「≡」菜单里
  'settings-entry': [
    '[data-maid-guide-target="settings-entry"]',
    '.qq-message-topbar .user-settings-btn',
    'body[data-ui-mode="rp"] #chat-menu-btn',
  ],
  'settings-api-config': [
    '[data-maid-guide-target="settings-api-config"]',
    '#settings-menu button[data-action="config"]',
    '#rp-chatroom-menu button[data-action="config"]',
  ],
  'settings-general': [
    '[data-maid-guide-target="settings-general"]',
    '#settings-menu button[data-action="settings"]',
    '#rp-chatroom-menu button[data-action="settings"]',
  ],
  'general-ui-advanced': [
    '[data-maid-guide-target="general-ui-advanced"]',
    '#general-ui-advanced-toggle',
  ],
  'general-rich-iframe-scripts': [
    '[data-maid-guide-target="general-rich-iframe-scripts"]',
    '#general-rich-iframe-scripts',
  ],
  'config-profile-select': [
    '[data-maid-guide-target="config-profile-select"]',
    '#config-profile-btn',
    '#config-profile',
  ],
  'config-provider-select': [
    '[data-maid-guide-target="config-provider-select"]',
    '#config-provider-btn',
    '#config-provider',
  ],
  'config-connection-fields': [
    '[data-maid-guide-target="config-connection-fields"]',
    '#config-main-page',
  ],
  'config-api-key-input': [
    '[data-maid-guide-target="config-api-key-input"]',
    '#config-apikey',
  ],
  'config-custom-fields': [
    '[data-maid-guide-target="config-custom-fields"]',
    '#config-custom-fields',
  ],
  'config-base-url-input': [
    '[data-maid-guide-target="config-base-url-input"]',
    '#config-baseurl',
  ],
  'config-service-account-input': [
    '[data-maid-guide-target="config-service-account-input"]',
    '#config-serviceaccount',
  ],
  'config-refresh-models': [
    '[data-maid-guide-target="config-refresh-models"]',
    '#refresh-models',
  ],
  'config-model-section': [
    '[data-maid-guide-target="config-model-section"]',
    '#config-model-section',
  ],
  'config-model-picker': [
    '[data-maid-guide-target="config-model-picker"]',
    '#config-model-picker',
  ],
  'config-model-select': [
    '[data-maid-guide-target="config-model-select"]',
    '#config-model',
  ],
  'config-save-btn': [
    '[data-maid-guide-target="config-save-btn"]',
    '#config-save',
  ],
  'top-plus-entry': [
    '[data-maid-guide-target="top-plus-entry"]',
    '.qq-message-topbar .topbar-plus-btn',
    '#plus-button',
  ],
  'quick-add-friend': [
    '[data-maid-guide-target="quick-add-friend"]',
    '#quick-menu button[data-action="add-friend"]',
  ],
  'add-friend-search-input': [
    '[data-maid-guide-target="add-friend-search-input"]',
    '#session-name',
  ],
  'add-friend-recommendation': [
    '[data-maid-guide-target="add-friend-recommendation"]',
    '.session-recommend-row',
  ],
  'add-friend-confirm': [
    '[data-maid-guide-target="add-friend-confirm"]',
    '.session-add-confirm-action.is-confirm',
  ],
  'contact-list-entry': [
    '[data-maid-guide-target="contact-list-entry"]',
    '.contact-item',
  ],
  'contact-detail-message': [
    '[data-maid-guide-target="contact-detail-message"]',
    '[data-action="contact-detail-message"]',
    '#contact-detail [data-action="contact-detail-message"]',
  ],
  'chat-input': [
    '[data-maid-guide-target="chat-input"]',
    '#composer-input',
  ],
  'chat-send': [
    '[data-maid-guide-target="chat-send"]',
    '#send-button',
  ],
  'chat-body': [
    '[data-maid-guide-target="chat-body"]',
    '#chat-messages',
    '.msgcontent',
  ],
  'format-repair-banner': [
    '[data-maid-guide-target="format-repair-banner"]',
    '#rejected-format-repair-banner',
  ],
  'maid-ball': ['#mode-switch'],
  'maid-command-input': ['.maid-command-input-field'],
  'maid-command-settings': ['.maid-command-input-settings'],
  'settings-agent-center': [
    '[data-maid-guide-target="settings-agent-center"]',
    '#settings-menu button[data-action="agent-center"]',
  ],
  'agent-center-entry': [
    '[data-maid-guide-target="settings-agent-center"]',
    '[data-maid-guide-target="agent-center-entry"]',
    '.agent-status-chip',
  ],
  'agent-center-card': [
    '[data-maid-guide-target="agent-center-card"]',
    '[data-agent-card-open]',
  ],
  'agent-center-detail-close': [
    '[data-maid-guide-target="agent-center-detail-close"]',
    '[data-agent-float-close]',
  ],
  'agent-center-close': [
    '[data-maid-guide-target="agent-center-close"]',
    '.agent-center-overlay [data-action="close"]',
  ],
});

export const MAID_ONBOARDING_FLOWS = Object.freeze([
  {
    id: 'setup-api',
    title: '给女仆接上大脑',
    goal: '保存一份可用的聊天 API 配置',
    reward: '初次接线',
    doneText: 'API 接线教学 · 完成',
    steps: [
      {
        action: 'observe',
        text: '欢迎回来，主人～女仆要先接上一份 API 配置才能真正替你做事。跟着聚光灯走，大约两分钟就能完成。',
        primaryLabel: '开始接线',
      },
      {
        target: 'settings-entry',
        placement: 'bottom',
        action: 'click',
        text: '先点开右上角的设置入口，我会替主人守住其他按钮。',
        hint: '点击高亮的设置按钮',
        fallback: { kind: 'open-settings-menu' },
        canAdvance: clicked('settings-entry'),
      },
      {
        target: 'settings-api-config',
        placement: 'left',
        action: 'click',
        text: '找到「API 设定」，打开连线配置面板。',
        hint: '点击 API 设定',
        fallback: { kind: 'open-api-config' },
        canAdvance: clicked('settings-api-config'),
      },
      {
        target: 'config-provider-select',
        placement: 'right',
        action: 'wait-event',
        configRequirement: 'provider',
        text: '先选择主人要使用的服务商。即使继续使用默认的 OpenAI，也请在列表里确认一次。女仆要真正动手做事，这个渠道需支持工具调用；女仆一次任务会连发多次请求，用限流严的渠道容易撞 RPM。',
        hint: '打开列表并选择服务商',
        fallback: { kind: 'click-target', target: 'config-provider-select' },
        canAdvance: (event, payload) => event === 'config-provider-confirmed' && Boolean(payload?.provider),
      },
      {
        target: 'config-api-key-input',
        placement: 'right',
        action: 'type',
        configRequirement: 'credentials',
        text: '把服务商要求的连接资料填在这里。Key 只留在本机配置里，引导事件只检查是否填写，不会读取内容。',
        hint: '填写必要的连接资料',
        fallback: { kind: 'focus-target', target: 'config-api-key-input' },
        canAdvance: (event, payload) => event === 'config-credentials-ready' && payload?.ready === true,
      },
      {
        target: 'config-model-section',
        placement: 'left',
        action: 'wait-event',
        configRequirement: 'model-refresh',
        text: '连接资料齐了。点击刷新拉取可用模型；如果服务商不支持列表，也可以直接手动填写模型 ID。',
        hint: '刷新列表，或手动填写模型',
        fallback: { kind: 'click-target', target: 'config-refresh-models' },
        canAdvance: (event, payload) => (
          (
            event === 'config-models-refreshed'
            && payload?.tab === 'chat'
            && Number(payload?.count || 0) > 0
          )
          || (event === 'config-model-selected' && Boolean(String(payload?.model || '').trim()))
        ),
      },
      {
        target: 'config-model-picker',
        placement: 'left',
        action: 'type',
        configRequirement: 'model-selection',
        text: '从刚拉取的候选模型中选一个。也可以手动填写服务商支持的模型 ID。',
        hint: '选择一个模型',
        fallback: { kind: 'focus-target', target: 'config-model-select' },
        canAdvance: (event, payload) => event === 'config-model-selected' && Boolean(String(payload?.model || '').trim()),
      },
      {
        target: 'config-save-btn',
        placement: 'top',
        action: 'wait-event',
        text: '最后按下保存。只有配置真的保存成功，我才会把这堂课记为完成。',
        hint: '保存可用配置',
        canAdvance: (event, payload) => event === 'config-profile-saved' && Number(payload?.profileCount || 0) > 0,
      },
    ],
  },
  {
    id: 'add-friend',
    title: '添加第一位好友',
    goal: '从推荐列表添加一位角色好友',
    reward: '初次相遇',
    doneText: '添加好友教学 · 完成',
    steps: [
      {
        action: 'observe',
        text: '我们来认识第一位朋友：打开添加好友，挑一位推荐角色，再确认添加。',
        primaryLabel: '去认识朋友',
      },
      {
        target: 'top-plus-entry',
        placement: 'bottom',
        action: 'click',
        text: '先点顶部的「+」打开快捷菜单。',
        hint: '点击高亮的加号',
        fallback: { kind: 'open-quick-menu' },
        canAdvance: clicked('top-plus-entry'),
      },
      {
        target: 'quick-add-friend',
        placement: 'left',
        action: 'click',
        text: '选择「添加好友」。',
        hint: '点击添加好友',
        fallback: { kind: 'open-add-friend' },
        canAdvance: clicked('quick-add-friend'),
      },
      {
        target: 'add-friend-search-input',
        placement: 'bottom',
        action: 'click',
        text: '点一下名称输入框，推荐角色会从这里展开。',
        hint: '点击输入框查看推荐',
        fallback: { kind: 'focus-target' },
        canAdvance: clicked('add-friend-search-input'),
      },
      {
        target: 'add-friend-recommendation',
        placement: 'right',
        action: 'click',
        text: '挑一位喜欢的角色。之后也可以随时回来继续添加。',
        hint: '点击任意推荐角色',
        fallback: { kind: 'click-target' },
        canAdvance: clicked('add-friend-recommendation'),
      },
      {
        target: 'add-friend-confirm',
        placement: 'top',
        action: 'wait-event',
        text: '确认后会建立联系人、聊天室与对应世界书。完成写入后我会自动继续。',
        hint: '确认添加好友',
        fallback: { kind: 'click-target' },
        canAdvance: (event, payload) => event === 'friend-added' && Boolean(payload?.sessionId),
      },
    ],
  },
  {
    id: 'first-chat',
    title: '第一次对话',
    goal: '发送消息并收到第一条 AI 回复',
    reward: '聊落成花',
    doneText: '第一次对话 · 完成',
    steps: [
      {
        action: 'observe',
        text: 'API 已经接好啦。现在进入一个聊天室、发句话，再等角色回复。',
        primaryLabel: '开始聊天',
      },
      {
        target: 'contact-list-entry',
        placement: 'right',
        action: 'click',
        text: '先打开「联系人」，选择任意一位联系人或群聊。没有聊过的人也会显示在这里。',
        hint: '选择一位联系人',
        canAdvance: clicked('contact-list-entry'),
      },
      {
        target: 'contact-detail-message',
        placement: 'top',
        action: 'wait-event',
        text: '在联系人详情里点击「发消息」；群聊则点击「进入群聊」。',
        hint: '点击发消息进入聊天室',
        canAdvance: (event, payload) => (
          event === 'chat-room-entered' && Boolean(payload?.sessionId)
        ),
      },
      {
        target: 'chat-input',
        placement: 'top',
        action: 'type',
        text: '在输入框写一句想说的话。',
        hint: '输入任意内容',
        fallback: { kind: 'focus-target' },
        canAdvance: (event, payload) => event === 'chat-composer-input' && Number(payload?.length || 0) > 0,
      },
      {
        target: 'chat-send',
        placement: 'top',
        action: 'wait-event',
        text: '按发送，把第一句话交给角色。',
        hint: '发送消息',
        canAdvance: (event, payload) => event === 'chat-message-sent' && Boolean(payload?.sessionId),
      },
      {
        target: 'chat-body',
        placement: 'top',
        action: 'wait-event',
        text: '角色正在回复。收到完整的 AI 消息后，这堂课就完成了。',
        hint: '等待 AI 回复',
        canAdvance: (event, payload) => event === 'chat-message-received' && payload?.role === 'assistant',
      },
    ],
  },
  {
    id: 'meet-maid',
    title: '认识女仆与 Agent Center',
    goal: '打开女仆指令条并认识 Agent Center',
    reward: '工位巡视员',
    doneText: '女仆与 Agent Center · 完成',
    steps: [
      {
        action: 'observe',
        text: '最后来认识女仆的工作台：从悬浮球打开指令条，再看看 Agent Center 里的小帮手。',
        primaryLabel: '出发',
      },
      {
        target: 'maid-ball',
        placement: 'bottom',
        action: 'wait-event',
        text: '长按这颗悬浮球打开女仆指令条。电脑上按住片刻，手机上也是长按。',
        hint: '长按女仆悬浮球',
        fallback: { kind: 'open-maid-command' },
        canAdvance: event => event === 'maid-command-opened',
      },
      {
        target: 'maid-command-input',
        placement: 'bottom',
        action: 'observe',
        text: '这就是女仆指令条。右侧齿轮只负责女仆自己的设定；Agent Center 有独立入口。',
        primaryLabel: '去看 Agent Center',
      },
      {
        target: 'agent-center-entry',
        placement: 'bottom',
        action: 'click',
        text: '从设置菜单进入 Agent Center；在聊天室或动态页，也可以直接点右上角的「A」。',
        hint: '打开 Agent Center',
        fallback: { kind: 'open-agent-center' },
        canAdvance: (event, payload) => (
          event === 'agent-center-opened'
          || (
            event === 'target-click'
            && ['settings-agent-center', 'agent-center-entry'].includes(payload?.target)
          )
        ),
      },
      {
        target: 'agent-center-card',
        placement: 'bottom',
        action: 'click',
        text: '这些卡片就是不同的小帮手。点开任意卡片，可以查看说明与配置。',
        hint: '点击任意 Agent 卡片',
        fallback: { kind: 'click-target' },
        canAdvance: clicked('agent-center-card'),
      },
      {
        target: 'agent-center-detail-close',
        placement: 'left',
        action: 'click',
        text: '卡片详情会从右侧展开。看完后先关闭详情，回到 Agent 列表。',
        hint: '关闭卡片详情',
        fallback: { kind: 'click-target' },
        canAdvance: clicked('agent-center-detail-close'),
      },
      {
        target: 'agent-center-close',
        placement: 'left',
        action: 'click',
        text: '点右上角关闭 Agent Center，巡视就完成了。',
        hint: '关闭 Agent Center',
        fallback: { kind: 'close-agent-center' },
        canAdvance: (event, payload) => (
          event === 'agent-center-closed'
          || (event === 'target-click' && payload?.target === 'agent-center-close')
        ),
      },
    ],
  },
  {
    id: 'rich-script-permission',
    title: '让角色卡完成动态渲染',
    goal: '在信任角色卡来源时开启富文本 iframe 脚本',
    doneText: '动态角色卡设置 · 完成',
    steps: [
      {
        action: 'observe',
        expression: 'surprise',
        text: '这张角色卡的开场页面由脚本动态生成；当前安全模式已拦截脚本，所以只剩静态空壳。这个开关会影响所有富文本卡，仅在你信任角色卡来源时开启。',
        hint: '不会自动开启，仍需你确认安全提示',
        primaryLabel: '带我去设置',
      },
      {
        target: 'settings-entry',
        placement: 'bottom',
        action: 'click',
        text: '先打开右上角的设置菜单。角色卡与聊天会保留在原处。',
        hint: '点击高亮的设置按钮',
        fallback: { kind: 'open-settings-menu' },
        // 写作房间高亮的是房间右上角「≡」，它自带 chatroom-menu-entry 标记
        canAdvance: (event, payload) => clicked('settings-entry')(event, payload) || clicked('chatroom-menu-entry')(event, payload),
      },
      {
        target: 'settings-general',
        placement: 'left',
        action: 'click',
        text: '选择「设定」，进入通用设置。',
        hint: '点击设定',
        fallback: { kind: 'open-general-settings' },
        canAdvance: clicked('settings-general'),
      },
      {
        target: 'general-ui-advanced',
        placement: 'left',
        action: 'click',
        text: '在「界面与调试」卡片右上角展开「调试选项」。',
        hint: '展开调试选项',
        fallback: { kind: 'click-target' },
        canAdvance: clicked('general-ui-advanced'),
      },
      {
        target: 'general-rich-iframe-scripts',
        placement: 'left',
        action: 'wait-event',
        expression: 'point',
        text: '开启「富文本 iframe 执行脚本」，再阅读并确认安全提示。只有设置真正启用后，这一步才会完成；不信任来源时请直接退出引导。',
        hint: '仅信任来源时开启并确认',
        fallback: { kind: 'click-target' },
        canAdvance: (event, payload) => event === 'rich-script-enabled' && payload?.enabled === true,
      },
    ],
  },
]);

const FLOW_BY_ID = new Map(MAID_ONBOARDING_FLOWS.map(flow => [flow.id, flow]));

export const getMaidOnboardingFlow = flowId => FLOW_BY_ID.get(String(flowId || '').trim()) || null;

export const createMaidExistingApiReviewFlow = (
  baseFlow = getMaidOnboardingFlow('setup-api'),
) => {
  if (baseFlow?.id !== 'setup-api' || !Array.isArray(baseFlow.steps) || baseFlow.steps.length < 3) {
    return null;
  }
  return {
    ...baseFlow,
    goal: '确认女仆使用的连线设置档与模型',
    steps: [
      ...baseFlow.steps.slice(0, 3),
      {
        target: 'config-profile-select',
        placement: 'right',
        action: 'observe',
        text: '主人已有可用配置。请确认女仆要使用哪一份「连线设置档」；可以展开改选，也可以直接沿用当前这份。挑的渠道需支持工具调用，女仆才能真正执行操作；也留意它的 RPM 限制，女仆一次任务会连发多次请求。',
        hint: '可改选设置档，或沿用当前',
        primaryLabel: '沿用当前连线',
      },
      {
        target: 'config-model-section',
        placement: 'left',
        action: 'wait-event',
        text: '再确认这份设置档里的模型。模型可以改选或手动填写；若当前值就是主人要的，直接保存即可。',
        hint: '模型可选；保存才会绑定女仆',
        primaryLabel: '保存并绑定女仆',
        fallback: { kind: 'click-target', target: 'config-save-btn' },
        canAdvance: (event, payload) => (
          event === 'config-profile-saved'
          && Number(payload?.profileCount || 0) > 0
        ),
      },
    ],
  };
};

export const ONBOARDING_TASKS = Object.freeze([
  {
    id: 'task-setup-api',
    flowId: 'setup-api',
    label: '给女仆接上大脑',
    description: '保存一份可用的聊天 API 配置',
    reward: '初次接线',
    icon: 'plug',
  },
  {
    id: 'task-add-friend',
    flowId: 'add-friend',
    label: '添加第一位好友',
    description: '从推荐列表认识一位角色',
    reward: '初次相遇',
    icon: 'user-plus',
  },
  {
    id: 'task-first-chat',
    flowId: 'first-chat',
    label: '第一次对话',
    description: '发送消息并收到角色回复',
    reward: '聊落成花',
    icon: 'message',
    requires: 'setup-api',
  },
  {
    id: 'task-meet-maid',
    flowId: 'meet-maid',
    label: '认识女仆与 Agent Center',
    description: '巡视女仆工作台与 Agent 小帮手',
    reward: '工位巡视员',
    icon: 'sparkles',
  },
]);
