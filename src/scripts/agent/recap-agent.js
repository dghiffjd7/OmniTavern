// 前情提要：每个聊天与角色卡默认都有、默认不启用的手动 Agent，挂在正文旁；删除后不再出现。
// 也作为手动小房子的模板，新建副本时沿用同一份配置。
import { t } from '../i18n/index.js';

export const RECAP_AGENT_ID = 'text-edit:recap';

export const buildRecapAgentConfig = () => ({
  title: t('前情提要'), icon: 'book', invocationMode: 'manual', outputMode: 'note', modelMode: 'follow_current',
  target: { mode: 'rendered' },
  context: { history: { enabled: true, unit: 'turns', count: 20, includeTarget: true }, maxChars: 20000 },
  prompt: t('阅读参考的对话历史与这条回复，整理到目前为止的前情提要：按时间顺序分条列出关键事件、人物关系的变化和尚未解决的线索。只总结已经发生的内容，不续写、不评价。'),
});
