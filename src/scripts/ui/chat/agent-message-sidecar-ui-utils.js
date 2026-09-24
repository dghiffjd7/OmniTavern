import { buildAgentMessagePartViewModel } from '../agent-message-parts-view.js';
import { isFormatCheckStatusPart } from './format-check-feedback.js';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const createElement = (documentLike, tagName, {
  className = '',
  text = '',
  style = '',
} = {}) => {
  const el = documentLike.createElement(tagName);
  if (className) el.className = className;
  if (text) el.textContent = text;
  if (style && el.style) el.style.cssText = style;
  return el;
};

export const AGENT_MESSAGE_SIDECAR_STYLES = Object.freeze({
  root: `
    width:min(100%, 520px);
    max-height:min(30vh, 240px);
    display:grid;
    gap:6px;
    overflow:auto;
    box-sizing:border-box;
    padding:2px 0;
  `,
  header: `
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:8px;
    font-size:11px;
    font-weight:800;
    color:var(--app-text-muted);
  `,
  details: `
    flex:0 0 auto;
    min-height:36px;
    border:1px solid var(--app-border-default);
    border-radius:8px;
    background:var(--app-surface-card);
    overflow:hidden;
  `,
  summary: `
    cursor:pointer;
    display:grid;
    grid-template-columns:10px minmax(0, 1fr) auto;
    align-items:center;
    gap:8px;
    min-height:36px;
    padding:6px 8px;
    box-sizing:border-box;
    list-style:none;
    font-size:11px;
    line-height:1.3;
    color:var(--app-text-primary);
    background:var(--app-surface-subtle);
  `,
  dot: `
    width:8px;
    height:8px;
    border-radius:999px;
  `,
  title: `
    min-width:0;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
    font-weight:800;
  `,
  badge: `
    border:1px solid currentColor;
    border-radius:999px;
    padding:1px 6px;
    font-size:10px;
    font-weight:800;
    line-height:1.2;
  `,
  body: `
    display:grid;
    gap:3px;
    padding:6px 8px 8px 26px;
    font-size:11px;
    line-height:1.35;
    color:var(--app-text-muted);
    overflow-wrap:anywhere;
  `,
  actionRow: `
    display:flex;
    flex-wrap:wrap;
    gap:6px;
    padding-top:4px;
  `,
  actionButton: `
    border:1px solid var(--app-border-default);
    border-radius:8px;
    background:var(--app-surface-subtle);
    color:var(--app-text-primary);
    min-height:24px;
    padding:3px 8px;
    font-size:11px;
    font-weight:800;
    line-height:1.2;
    cursor:pointer;
  `,
});

const buildActionButton = ({
  documentLike,
  text = '',
  action = '',
  datasetKey = '',
  style = AGENT_MESSAGE_SIDECAR_STYLES.actionButton,
  onClick = null,
  disabled = false,
} = {}) => {
  const button = createElement(documentLike, 'button', {
    text,
    style: disabled ? `${style}opacity:.55;cursor:not-allowed;` : style,
  });
  button.type = 'button';
  button.disabled = disabled === true;
  if (datasetKey && action) button.dataset[datasetKey] = action;
  if (!disabled && typeof onClick === 'function') button.addEventListener?.('click', onClick);
  return button;
};

export const getAgentMessagePartsForMessage = (message = {}) => {
  const meta = isPlainObject(message?.meta) ? message.meta : {};
  if (Array.isArray(meta.agentMessageParts)) return meta.agentMessageParts;
  if (Array.isArray(message?.agentMessageParts)) return message.agentMessageParts;
  return [];
};

export const buildAgentMessageSidecarSignature = (message = {}) => {
  const parts = buildAgentMessagePartViewModel(getAgentMessagePartsForMessage(message));
  if (!parts.length) return '';
  return JSON.stringify(parts.map(part => ({
    id: part.id,
    type: part.type,
    status: part.status,
    title: part.titleLabel,
    summary: part.summary,
    updatedAt: part.updatedAt,
    errorMessage: part.errorMessage,
  })));
};

// 格式检查的状态提示（检查中 / 无需修改 / 已检查）：一行简洁说明，不展开调试信息
const buildFormatCheckStatusElement = ({ documentLike, part, message, translateText, onChatFormatGuardianAction }) => {
  const state = trim(part.metadata?.state, 'checking');
  const row = createElement(documentLike, 'div', { className: 'chat-format-check-status' });
  row.dataset.state = state;
  row.setAttribute?.('role', 'status');
  row.appendChild(createElement(documentLike, 'span', { className: 'chat-format-check-status-icon' }));
  const copy = createElement(documentLike, 'div', { className: 'chat-format-check-status-copy' });
  copy.appendChild(createElement(documentLike, 'strong', { text: translateText(part.title) }));
  if (trim(part.summary)) {
    const reason = createElement(documentLike, 'span', { text: part.summary });
    if (state === 'checked') row.title = part.summary;
    else copy.appendChild(reason);
  }
  row.appendChild(copy);
  const actions = (Array.isArray(part.metadata?.decisionActions) ? part.metadata.decisionActions : [])
    .filter(action => action?.enabled !== false && trim(action?.id));
  if (actions.length && typeof onChatFormatGuardianAction === 'function') {
    const actionRow = createElement(documentLike, 'div', { className: 'chat-format-check-status-actions' });
    actions.forEach((action) => {
      const button = createElement(documentLike, 'button', { text: translateText(trim(action.label, action.id)) });
      button.type = 'button';
      button.dataset.chatFormatGuardianAction = trim(action.id);
      button.addEventListener?.('click', () => onChatFormatGuardianAction({ action: trim(action.id), actionMeta: action, part, message }));
      actionRow.appendChild(button);
    });
    row.appendChild(actionRow);
  }
  return row;
};

export const buildAgentMessageSidecarElement = ({
  documentLike = globalThis.document,
  message = {},
  maxParts = 6,
  translateText = value => String(value ?? ''),
  onProviderToolPermissionAction = null,
  onProviderToolContinuationAction = null,
  onChatFormatGuardianAction = null,
} = {}) => {
  if (!documentLike?.createElement) return null;
  const allParts = buildAgentMessagePartViewModel(getAgentMessagePartsForMessage(message));
  if (!allParts.length) return null;
  const statusParts = allParts.filter(isFormatCheckStatusPart);
  const parts = allParts.filter(part => !isFormatCheckStatusPart(part));
  const statusElements = statusParts.map(part => buildFormatCheckStatusElement({
    documentLike, part, message, translateText, onChatFormatGuardianAction,
  }));
  if (!parts.length) {
    if (statusElements.length === 1) return statusElements[0];
    const stack = createElement(documentLike, 'div', { className: 'chat-format-check-statuses' });
    statusElements.forEach(el => stack.appendChild(el));
    return stack;
  }
  const visible = parts.slice(-Math.max(1, Math.trunc(Number(maxParts)) || 6));
  const root = createElement(documentLike, 'div', {
    className: 'chat-agent-sidecar',
    style: AGENT_MESSAGE_SIDECAR_STYLES.root,
  });
  root.dataset.agentPartsCount = String(parts.length);

  const header = createElement(documentLike, 'div', {
    className: 'chat-agent-sidecar-header',
    style: AGENT_MESSAGE_SIDECAR_STYLES.header,
  });
  const title = createElement(documentLike, 'span', { text: 'Agent' });
  const count = createElement(documentLike, 'span', { text: `${visible.length}/${parts.length}` });
  header.appendChild(title);
  header.appendChild(count);
  root.appendChild(header);

  visible.forEach((part) => {
    const details = createElement(documentLike, 'details', {
      className: 'chat-agent-sidecar-item',
      style: AGENT_MESSAGE_SIDECAR_STYLES.details,
    });
    details.open = part.open;
    const summary = createElement(documentLike, 'summary', {
      style: AGENT_MESSAGE_SIDECAR_STYLES.summary,
    });
    const dot = createElement(documentLike, 'span', {
      style: `${AGENT_MESSAGE_SIDECAR_STYLES.dot}background:${part.accent};`,
    });
    const label = createElement(documentLike, 'span', {
      text: translateText(part.titleLabel || part.summaryLabel),
      style: AGENT_MESSAGE_SIDECAR_STYLES.title,
    });
    const badge = createElement(documentLike, 'span', {
      text: translateText(part.statusLabel || trim(part.status, 'running')),
      style: `${AGENT_MESSAGE_SIDECAR_STYLES.badge}color:${part.accent};`,
    });
    summary.appendChild(dot);
    summary.appendChild(label);
    summary.appendChild(badge);
    details.appendChild(summary);

    const body = createElement(documentLike, 'div', {
      style: AGENT_MESSAGE_SIDECAR_STYLES.body,
    });
    part.rows.slice(0, 4).forEach(([rowLabel, value]) => {
      const row = createElement(documentLike, 'div', {
        text: `${translateText(rowLabel)}: ${translateText(value)}`,
      });
      body.appendChild(row);
    });
    const interaction = isPlainObject(part.metadata?.interaction) ? part.metadata.interaction : null;
    if (part.type === 'provider_tool_permission_request' && part.status === 'waiting_permission' && interaction) {
      const strategy = createElement(documentLike, 'div', {
        text: `approval: ${trim(interaction.presentation, 'message_part')} · default=${trim(interaction.defaultAction, 'deny')}`,
      });
      body.appendChild(strategy);
      if (typeof onProviderToolPermissionAction === 'function') {
        const actionRow = createElement(documentLike, 'div', {
          style: AGENT_MESSAGE_SIDECAR_STYLES.actionRow,
        });
        (Array.isArray(interaction.allowedActions) ? interaction.allowedActions : [])
          .filter(action => action === 'allow_once' || action === 'deny' || action === 'remember_allow')
          .forEach((action) => {
            const label = action === 'allow_once'
              ? 'Allow Once'
              : (action === 'remember_allow' ? 'Remember' : 'Deny');
            const button = buildActionButton({
              documentLike,
              text: translateText(label),
              action,
              datasetKey: 'providerToolPermissionAction',
              onClick: () => onProviderToolPermissionAction({
                action,
                part,
                message,
              }),
            });
            actionRow.appendChild(button);
          });
        if (actionRow.children?.length) body.appendChild(actionRow);
      }
      if (typeof onProviderToolContinuationAction === 'function' && trim(part.metadata?.pendingPermissionId)) {
        const continuationRow = createElement(documentLike, 'div', {
          style: AGENT_MESSAGE_SIDECAR_STYLES.actionRow,
        });
        [
          ['preview_continue', 'Preview Continue'],
          ['disable_gate', 'Disable Gate'],
        ].forEach(([action, label]) => {
          const button = buildActionButton({
            documentLike,
            text: translateText(label),
            action,
            datasetKey: 'providerToolContinuationAction',
            onClick: () => onProviderToolContinuationAction({
              action,
              part,
              message,
            }),
          });
          continuationRow.appendChild(button);
        });
        if (continuationRow.children?.length) body.appendChild(continuationRow);
      }
    }
    if (
      (part.kind === 'chat_format.validate' || part.kind === 'chat_body_quality.review') &&
      typeof onChatFormatGuardianAction === 'function'
    ) {
      const actions = (Array.isArray(part.metadata?.decisionActions) ? part.metadata.decisionActions : [])
        .filter(action => action?.enabled !== false)
        .slice(0, 5);
      if (actions.length) {
        const actionRow = createElement(documentLike, 'div', {
          style: AGENT_MESSAGE_SIDECAR_STYLES.actionRow,
        });
        actions.forEach((action) => {
          const actionId = trim(action?.id);
          const label = trim(action?.label, actionId);
          const button = buildActionButton({
            documentLike,
            text: translateText(label),
            action: actionId,
            datasetKey: 'chatFormatGuardianAction',
            onClick: () => onChatFormatGuardianAction({
              action: actionId,
              actionMeta: action,
              part,
              message,
            }),
          });
          actionRow.appendChild(button);
        });
        if (actionRow.children?.length) body.appendChild(actionRow);
      }
    }
    details.appendChild(body);
    root.appendChild(details);
  });
  statusElements.forEach(el => root.appendChild(el));

  return root;
};
