// 只保留“显式保存”编辑器的未提交字段；模型/开关等即时设置不作为草稿恢复。
// 身份包含预设和模板，避免把旧资源的输入恢复到新资源。
const editorSelector = '[data-agent-prompt-editor], [data-memory-agent-editor], [data-agent-format-guide-editor], [data-agent-common-editor]';
const editorKey = node => JSON.stringify([
  node.dataset.agentCommonEditor, node.dataset.agentPromptEditor, node.dataset.agentId, node.dataset.agentPromptProfileType,
  node.dataset.agentPromptPresetId, node.dataset.memoryAgentEditor,
  node.dataset.memoryAgentPresetId, node.dataset.memoryAgentTemplateId,
  node.dataset.agentFormatGuideEditor, node.dataset.formatSessionId, node.dataset.formatScopeId,
]);
const fieldKey = node => `${node.tagName}:${Object.keys(node.dataset).sort().join(',')}:${node.name || ''}`;
const valueOf = node => node.type === 'checkbox' ? node.checked : node.value;
const initialValue = node => {
  if (node.type === 'checkbox') return node.defaultChecked;
  if (node.tagName === 'SELECT') return [...node.options].find(option => option.defaultSelected)?.value ?? node.options[0]?.value ?? '';
  return node.defaultValue;
};

export const captureAgentEditorDrafts = root => {
  const editors = [];
  let focus = null;
  for (const editor of root?.querySelectorAll?.(editorSelector) || []) {
    const key = editorKey(editor);
    const fields = [];
    for (const field of editor.querySelectorAll(editor.dataset.agentCommonEditor ? '[name="agent-config-draft"]' : 'input, select, textarea')) {
      if (valueOf(field) !== initialValue(field)) fields.push({ key: fieldKey(field), value: valueOf(field) });
      if (field === root.ownerDocument?.activeElement) focus = { editor: key, field: fieldKey(field), start: field.selectionStart, end: field.selectionEnd, scrollTop: field.scrollTop };
    }
    if (fields.length) editors.push({ key, fields });
  }
  return { editors, focus };
};

export const restoreAgentEditorDrafts = (root, snapshot) => {
  if (!snapshot) return;
  for (const editor of root?.querySelectorAll?.(editorSelector) || []) {
    const key = editorKey(editor);
    const draft = snapshot.editors.find(item => item.key === key);
    for (const field of editor.querySelectorAll('input, select, textarea')) {
      const fieldId = fieldKey(field);
      const saved = draft?.fields.find(item => item.key === fieldId);
      if (saved) {
        if (field.type === 'checkbox') field.checked = saved.value;
        else field.value = saved.value;
      }
      if (snapshot.focus?.editor === key && snapshot.focus.field === fieldId) {
        field.focus({ preventScroll: true });
        if (snapshot.focus.start != null && typeof field.setSelectionRange === 'function') field.setSelectionRange(snapshot.focus.start, snapshot.focus.end);
        field.scrollTop = snapshot.focus.scrollTop;
      }
    }
  }
};
