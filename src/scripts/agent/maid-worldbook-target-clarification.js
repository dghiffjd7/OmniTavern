import { t } from '../i18n/index.js';
import { stripNegatedMaidCapabilityActions } from './maid-capability-concept-retriever.js';
import { classifyMaidPendingActionReply } from './maid-pending-action.js';

const trim = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const outputOf = step => step?.output?.result && typeof step.output.result === 'object'
  ? step.output.result : step?.output;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// This is conservative presentation eligibility, not an operation parser or
// authorization. Background lore reads must not replace a different task.
const isSettingEdit = input => {
  const text = stripNegatedMaidCapabilityActions(input);
  // Questions and hypothetical wording are deliberately left to the model.
  // A clarification control is not proof that the user requested an edit.
  if (/[?？]|为什么|為什麼|为何|為何|如何|怎么|怎麼|是否|原因|解释|解釋|说明|說明|如果|假如|假设|假設|要是|\b(?:why|how|what|whether|if|suppose|supposing|hypothetically)\b/iu.test(String(input))) return false;
  if (String(input).split(/[，,。；;！？!?\n]/u).some(clause => classifyMaidPendingActionReply(clause) === 'cancel')) return false;
  if (/然后|然後|并且|並且|顺便|順便|顺手|順手|同时|同時|还要|還要|另外|接着|接著|\b(?:then|also)\b/iu.test(text)) return false;
  return /世界[书書]|设定|設定|\b(?:lore\s*books?|world\s*books?|settings?)\b/iu.test(text)
    && /补|補|追加|添加|修改|更新|改成|改为|改為|\b(?:add|append|update|edit|modify)\b/iu.test(text)
    && !/比较|比較|对比|對比|合并|合併|并回|併回|删|刪|清空|移除|覆盖|覆蓋|替换|替換|导入|導入|联系人|聯絡人|聯繫人|会话|會話|聊天室|群聊|角色卡|切换|切換|打开|打開|新建|创建|創建|建立|生成|\b(?:compare|merge|delete|remove|clear|replace|overwrite|import|contacts?|sessions?|chats?|groups?|switch|open|create|generate)\b/iu.test(text);
};
const referenceKey = value => trim(value).normalize('NFKC').toLocaleLowerCase();
const mentions = (input, reference) => {
  const value = referenceKey(reference);
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const start = /^[a-z0-9_-]/u.test(value) ? '(?:^|[^a-z0-9_-])' : '';
  const end = /[a-z0-9_-]$/u.test(value) ? '(?=$|[^a-z0-9_-])' : '';
  return new RegExp(`${start}${escaped}${end}`, 'u').test(referenceKey(input));
};

// Resource names are observed data, never Markdown or instructions. Keep the
// complete IDs/names in evidence; visible labels are bounded, single-line text.
const label = value => {
  const plain = trim(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ');
  const bounded = plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
  return bounded.replace(/[\\`*_{}\[\]()#+\-.!|<>~]/gu, '\\$&');
};
const currentCardOf = value => ({
  personaId: trim(value?.personaId), personaName: trim(value?.personaName), worldbookId: trim(value?.worldbookId),
});
const bindingsOf = value => list(value).map(binding => ({
  personaId: trim(binding?.personaId), personaName: trim(binding?.personaName), enabled: binding?.enabled,
})).sort((a, b) => a.personaId.localeCompare(b.personaId));

const readEvidence = ({ input, step, context, stepIndex }) => {
  const output = outputOf(step), args = step.args || {};
  // This first presentation path only accepts a complete generic inventory.
  // Reject target/scope selectors, even where today's reader merely uses a
  // worldbook ID to order the inventory rather than filter it.
  const inventoryArgs = new Set(['resource', 'query', 'entryId', 'entryTitle', 'includeContent', 'limit', 'maxEntries', 'maxContentLength', 'maxTextLength']);
  if (Object.keys(args).some(key => !inventoryArgs.has(key))) return null;
  if (step.status !== 'succeeded' || output?.ok !== true || output.resource !== 'worldbook'
    || output.partial === true || output.truncated === true || output.sessionLookup?.matched === false) return null;
  const books = list(output.worldbooks), current = currentCardOf(output.currentCard);
  // The generic reader limits books and matching entries separately. Neither
  // omitted pages nor a single-book read can establish this choice of targets.
  if (!books.length || !Number.isSafeInteger(output.count) || output.count !== books.length
    || !current.personaId || current.personaId !== trim(context.roleCardId) || !current.personaName
    || output.currentCard?.worldbookId !== ''
    || new Set(books.map(book => trim(book?.id))).size !== books.length
    || books.some(book => !trim(book?.id) || book.ownershipKnown !== true || book.truncated !== false
      || !Array.isArray(book.entries) || book.returnedEntryCount !== book.entries.length)) return null;

  const matches = books.flatMap(book => book.entries.map(entry => ({ book, entry })));
  if (matches.length !== 1) return null;
  const { book, entry } = matches[0], evidence = book.targetSelectionEvidence;
  const card = currentCardOf(evidence?.currentCard), bookId = trim(book.id), entryId = trim(entry?.id);
  if (!entryId || !trim(entry?.title) || !trim(book.name) || book.currentCard !== false
    || evidence?.currentCard?.bindingState !== 'unbound' || evidence.currentCard.worldbookId !== ''
    || !same(card, current) || trim(evidence?.observedWorldbook?.worldbookId) !== bookId) return null;
  // All book projections in the same read must agree on the current card.
  if (books.some(item => !same(currentCardOf(item.targetSelectionEvidence?.currentCard), current)
    || item.targetSelectionEvidence?.currentCard?.bindingState !== 'unbound'
    || item.targetSelectionEvidence.currentCard.worldbookId !== '')) return null;
  const owners = bindingsOf(book.personaBindings);
  if (!owners.length || owners.length > 4 || owners.some(owner => !owner.personaId || !owner.personaName
    || owner.personaId === current.personaId || typeof owner.enabled !== 'boolean')
    || new Set(owners.map(owner => owner.personaId)).size !== owners.length
    || !same(owners, bindingsOf(evidence.observedWorldbook.personaBindings))
    || !same(list(book.ownerCards).map(trim).sort(), owners.map(owner => owner.personaName).sort())
    || !same(list(book.otherOwnerCards).map(trim).sort(), owners.map(owner => owner.personaName).sort())) return null;
  const options = list(evidence.targetOptions);
  if (options.length !== 2 || options.filter(option => option.target === 'current_card'
    && option.intent === 'create_and_bind' && option.personaId === current.personaId && option.worldbookId === '').length !== 1
    || options.filter(option => option.target === 'observed_worldbook'
      && option.intent === 'use_observed_worldbook' && option.worldbookId === bookId).length !== 1) return null;

  // Require a concrete identity both in the user's request and in the actual
  // read filter. Do not infer the target from the model's reply or a body match.
  const explicitIdentities = [entryId, trim(entry.title)];
  if (!explicitIdentities.some(reference => mentions(input, reference))) return null;
  // Keywords can validate the executed filter after identity is established;
  // generic triggers such as pronouns cannot identify the user's target.
  const identities = [...explicitIdentities, ...list(entry.keys).map(trim)].filter(Boolean);
  const filters = ['query', 'entryId', 'entryTitle'].filter(key => trim(args[key]));
  if (!filters.length || filters.some(key => {
    const refs = key === 'entryId' ? [entryId] : identities;
    return !refs.some(ref => referenceKey(ref) === referenceKey(args[key]));
  })) return null;
  if ([bookId, book.name, ...owners.flatMap(owner => [owner.personaId, owner.personaName])]
    .some(reference => mentions(input, reference))) return null;

  return {
    currentCard: { ...card, bindingState: 'unbound' },
    observedWorldbook: { id: bookId, name: book.name, personaBindings: owners },
    entry: { id: entryId, title: entry.title },
    targetOptions: options.map(option => ({ ...option })),
    sourceStepIndex: stepIndex,
    sourceStep: step.index,
  };
};

/** Called only after the shared presentation boundary verifies successful,
 * actual registry reads and this request's identity. This does not grant write
 * permission or interpret a plain-text question as a structured clarification.
 */
export const buildMaidWorldbookTargetClarification = ({ input = '', context = {}, steps = [], decision = {} } = {}) => {
  const requestRoleCardId = trim(context.roleCardId);
  const requestRunId = trim(context.submissionId || context.runId || context.capabilityRequestId);
  // "补一句" currently classifies as unspecified. It can qualify for this
  // evidence display via the narrow setting-edit check; this never changes the
  // original operation policy, tool selection, permission or write authority.
  if (!requestRoleCardId || !requestRunId || !['write_allowed', 'unspecified'].includes(context.operationIntentPolicy?.mode)
    || !isSettingEdit(input) || decision.ok !== true || decision.providerFcControl !== 'clarify'
    || decision.source !== 'maid_provider_fc') return null;
  let selected = null;
  for (const [stepIndex, step] of list(steps).entries()) {
    const output = outputOf(step);
    if (step.toolName === 'worldbook.read') return null;
    // A prior current-card observation cannot contradict the evidence used to
    // render this question, even if later reads happen to look consistent.
    if (output?.currentCard && (output.currentCard.personaId !== requestRoleCardId
      || output.currentCard.worldbookId !== '')) return null;
    if (step.toolName !== 'app.read_resource' || step.args?.resource !== 'worldbook') continue;
    const observed = readEvidence({ input, step, context, stepIndex });
    if (!observed) return null;
    if (selected && !same({ ...selected, sourceStepIndex: 0, sourceStep: 0 }, { ...observed, sourceStepIndex: 0, sourceStep: 0 })) return null;
    selected = observed;
  }
  if (!selected) return null;
  const params = {
    currentCard: label(selected.currentCard.personaName), entry: label(selected.entry.title),
    worldbook: label(selected.observedWorldbook.name),
    ownerCards: selected.observedWorldbook.personaBindings.map(owner => label(owner.personaName)).join('、'),
  };
  return {
    source: 'app', kind: 'worldbook_target_clarification', status: 'clarify',
    requestRoleCardId, requestRunId, evidence: selected,
    message: [
      t('APP 目标确认：本次读取时，当前角色卡「{currentCard}」尚未绑定世界书。', params),
      t('条目「{entry}」位于角色卡「{ownerCards}」的世界书「{worldbook}」中。', params),
      t('请选择：① 修改「{worldbook}」中的「{entry}」；② 为当前角色卡「{currentCard}」新建并绑定世界书，再添加设定。您选哪一项？', params),
      t('本次尚未写入；选定目标后仍会按 APP 的权限与目标检查执行。'),
    ].join('\n'),
  };
};
