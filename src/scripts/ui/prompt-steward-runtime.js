// 提示词管家的装配：读取当前会话的系统提示词预设、全局提示词库与变量，交给只读规则检查；app.js 只注入资料来源与入口。
import { getCanonicalBuiltinPromptDefaults } from '../storage/preset-store.js';
import { canonicalizeOfficialPromptRecord } from '../i18n/prompt-locale.js';
import { withoutPhonePromptTime } from '../utils/phone-format-time-prompt.js';
import { normalizeGlobalSemanticPromptLibrary, resolveGlobalSemanticPromptPlan } from '../agent/global-semantic-prompt-library.js';
import { createPromptAuditAgent } from '../agent/prompt-audit-agent.js';
import { createPromptStewardController } from './prompt-steward-card.js';

const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();

/** 内置提示词是否仍是默认：翻译后的默认也算；手机格式的时间行不参与比较。 */
export const isBuiltinPromptDefault = (key, text, defaults = getCanonicalBuiltinPromptDefaults()) => {
  const canonical = defaults[key];
  if (typeof canonical !== 'string') return true;
  const project = value => (key.startsWith('phone_format_') ? withoutPhonePromptTime(value) : String(value ?? ''));
  const original = project(text);
  const back = canonicalizeOfficialPromptRecord({ [key]: original }, { [key]: canonical })[key];
  const target = normalizeText(project(canonical));
  return normalizeText(original) === target || normalizeText(back) === target;
};

// 变量名带路径（a.b、a[0]）时按最外层的键判断
const rootVariableName = name => String(name || '').split(/[.[]/)[0].trim();

export const createPromptStewardRuntime = ({
  documentRef = globalThis.document,
  presetStore,
  chatStore,
  agentTaskRuntime = null,
  getSessionId = () => '',
  getUiMode = () => 'chat',
  getGlobalPromptLibrary = () => null,
  openTarget = null,
  onChange = () => {},
} = {}) => {
  const collect = async () => {
    const sessionId = String(getSessionId() || '').trim();
    const uiMode = getUiMode();
    const resolved = presetStore.getResolvedActiveId('sysprompt', { sessionId, uiMode });
    const record = resolved?.presetId ? presetStore.getPreset('sysprompt', resolved.presetId) : null;
    const openai = presetStore.getResolvedActiveId('openai', { sessionId, uiMode });
    const library = getGlobalPromptLibrary();
    const defaults = getCanonicalBuiltinPromptDefaults();
    return {
      sysprompt: { presetName: String(record?.name || resolved?.presetId || '').trim(), record },
      isDefaultText: (key, text) => isBuiltinPromptDefault(key, text, defaults),
      globalBlocks: normalizeGlobalSemanticPromptLibrary(library).blocks.filter(block => block.scope === 'chat'),
      globalPlan: resolveGlobalSemanticPromptPlan(library, { scope: 'chat', uiMode, hasCustomChatPreset: openai?.hasCustomBinding === true }),
      hasVariable: (name, { global = false } = {}) => {
        const key = rootVariableName(name);
        return (global ? chatStore.getGlobalVariable(key) : chatStore.getVariable(key, sessionId)) !== undefined;
      },
    };
  };
  const audit = createPromptAuditAgent({ agentTaskRuntime, collect });
  const controller = createPromptStewardController({
    documentRef,
    runAudit: options => audit.auditPrompts({ ...options, source: 'agent-center-prompts' }),
    openTarget,
    onChange,
    getSessionId,
  });
  return { controller, audit, collect };
};
