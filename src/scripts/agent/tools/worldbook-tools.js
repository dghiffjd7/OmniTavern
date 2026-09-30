const PREVIEW_ENTRY_FIELDS_SCHEMA = {
  type: 'object',
  properties: {
    comment: { type: 'string', description: 'Entry title.' },
    content: { type: 'string' },
    key: { type: 'array', items: { type: 'string' } },
    keysecondary: { type: 'array', items: { type: 'string' } },
    constant: { type: 'boolean' },
    disable: { type: 'boolean' },
    order: { type: 'number' },
  },
};

export const createWorldbookAgentTools = ({
  previewWorldbookActions = null,
  getPreviewWorldbookActions = null,
} = {}) => {
  const resolvePreviewWorldbookActions = () => {
    if (typeof previewWorldbookActions === 'function') return previewWorldbookActions;
    if (typeof getPreviewWorldbookActions !== 'function') return null;
    try {
      const fn = getPreviewWorldbookActions();
      return typeof fn === 'function' ? fn : null;
    } catch {
      return null;
    }
  };
  const tools = [];

  if (typeof previewWorldbookActions === 'function' || typeof getPreviewWorldbookActions === 'function') {
    tools.push({
      name: 'worldbook.preview_actions',
      title: 'Preview worldbook actions',
      description: 'Build a worldbook entry diff and rollback preview without writing worldbook data.',
      source: 'worldbook-action-preview',
      permissions: ['worldbook.read'],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['worldId', 'actions'],
        additionalProperties: false,
        properties: {
          worldId: { type: 'string', minLength: 1 },
          actions: {
            type: 'array',
            // 字段须完整声明：Gemini 原生函数调用对未声明字段的对象只会生成 {}
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description: 'insert_entry | update_entry | delete_entry | toggle_entry | disable_entry | enable_entry',
                },
                entryId: { type: 'string', description: 'Target entry id (all actions except insert_entry).' },
                entryIndex: { type: 'integer' },
                position: { type: 'string', description: 'insert_entry position: top or bottom.' },
                entry: { ...PREVIEW_ENTRY_FIELDS_SCHEMA, description: 'insert_entry: the new entry.' },
                patch: { ...PREVIEW_ENTRY_FIELDS_SCHEMA, description: 'update_entry: only the fields to change.' },
                disabled: { type: 'boolean' },
              },
            },
          },
        },
      },
      execute: async (args = {}) => {
        const preview = resolvePreviewWorldbookActions();
        if (typeof preview !== 'function') {
          throw new Error('worldbook action preview runtime not available');
        }
        return preview({
          worldId: String(args.worldId || '').trim(),
          actions: Array.isArray(args.actions) ? args.actions : [],
        });
      },
      summarizeResult: result => `worldbook action preview: ${Number(result?.changed || 0)} change(s), ${Number(result?.skipped || 0)} skipped`,
    });
  }

  return tools;
};

export const registerWorldbookAgentTools = (registry, deps = {}) => {
  const tools = createWorldbookAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
