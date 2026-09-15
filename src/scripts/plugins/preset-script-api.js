// Both functions are also serialized into the script Worker.
export function toScriptPreset(preset = {}, regexes = []) {
  const copy = value => JSON.parse(JSON.stringify(value));
  const source = copy(preset);
  const prompts = Array.isArray(source.prompts) ? source.prompts : [];
  const blocks = Array.isArray(source.prompt_order) ? source.prompt_order : [];
  const block = blocks.find(item => Number(item.character_id) === 100001) || blocks.at(-1);
  const order = Array.isArray(block?.order) ? block.order : prompts;
  const normalize = (prompt, item = prompt) => ({ ...prompt,
    id: String(prompt.identifier || prompt.id || ''), enabled: item.enabled !== false,
  });
  const used = new Set();
  source.prompts = order.flatMap(item => {
    const id = String(item.identifier || item.id || '');
    const prompt = prompts.find(value => String(value.identifier || value.id || '') === id);
    if (!prompt || used.has(id)) return [];
    used.add(id); return [normalize(prompt, item)];
  });
  source.prompts_unused = [...prompts.filter(item => !used.has(String(item.identifier || item.id || ''))),
    ...(source.prompts_unused || [])].flatMap(item => {
      const id = String(item.identifier || item.id || '');
      if (used.has(id)) return [];
      used.add(id); return [normalize(item)];
    });
  source.regexes = copy(regexes).map(rule => ({ ...rule, name: rule.script_name || rule.scriptName || rule.name || '',
    enabled: rule.enabled !== false && rule.disabled !== true }));
  source.extensions = { ...(source.extensions || {}), regex_scripts: source.regexes };
  return source;
}

export function fromScriptPreset(original, edited) {
  const copy = value => JSON.parse(JSON.stringify(value));
  const result = copy(original);
  // The compatibility surface is data, not executable script metadata or the
  // app's preset bindings. Only prompt and generation fields can be changed.
  for (const key of ['temperature', 'top_p', 'top_k', 'max_tokens', 'openai_max_tokens',
    'frequency_penalty', 'presence_penalty', 'seed', 'stream_openai']) {
    if (Object.hasOwn(edited, key)) result[key] = copy(edited[key]);
  }
  const active = Array.isArray(edited.prompts) ? edited.prompts : [];
  const unused = Array.isArray(edited.prompts_unused) ? edited.prompts_unused : [];
  const originalPrompts = [...(original.prompts || []), ...(original.prompts_unused || [])];
  const originalById = new Map(originalPrompts.map(prompt => [String(prompt.identifier || prompt.id || ''), prompt]));
  const originalView = toScriptPreset(original);
  const originalEnabled = new Map([...originalView.prompts, ...originalView.prompts_unused].map(prompt => [prompt.id, prompt.enabled]));
  const ids = new Set();
  const nextById = new Map([...active, ...unused].map(prompt => {
    const id = String(prompt.id || prompt.identifier || '');
    if (!id || ids.has(id)) throw new Error('预设条目 ID 缺失或重复');
    ids.add(id);
    const stored = originalById.get(id);
    const next = { ...copy(prompt), identifier: id };
    if (!Object.hasOwn(stored || {}, 'id')) delete next.id;
    if (stored && originalEnabled.get(id) === (prompt.enabled !== false)) {
      if (Object.hasOwn(stored, 'enabled')) next.enabled = stored.enabled;
      else delete next.enabled;
    } else next.enabled = prompt.enabled !== false;
    return [id, next];
  }));
  // Raw prompt-array order is independent of prompt_order. Keep existing rows
  // in place so changing one toggle does not rewrite every preset entry.
  result.prompts = originalPrompts.flatMap(prompt => {
    const id = String(prompt.identifier || prompt.id || '');
    const next = nextById.get(id); nextById.delete(id);
    return next ? [next] : [];
  }).concat([...nextById.values()]);
  if (Object.hasOwn(result, 'prompts_unused')) result.prompts_unused = [];
  result.prompt_order = copy(result.prompt_order || []);
  let block = result.prompt_order.find(item => Number(item.character_id) === 100001) || result.prompt_order.at(-1);
  if (!block) { block = { character_id: 100001, order: [] }; result.prompt_order.push(block); }
  const oldOrder = new Map((block.order || []).map(item => [String(item.identifier || item.id || ''), item]));
  block.order = active.map(prompt => ({ ...oldOrder.get(String(prompt.id || prompt.identifier)),
    identifier: String(prompt.id || prompt.identifier), enabled: prompt.enabled !== false }));
  // Preserve the original extension layout when saving regex switches. The
  // bound runtime set and the preset's export source must agree after reload.
  const regexes = edited.extensions?.regex_scripts || edited.regexes || [];
  const flags = new Map(regexes.map(rule => [rule.id, rule.enabled !== false]));
  const applyFlags = list => {
    if (!Array.isArray(list)) return;
    for (const rule of list) if (flags.has(rule.id)) {
      const enabled = flags.get(rule.id);
      if (Object.hasOwn(rule, 'disabled') || !enabled) rule.disabled = !enabled;
      if (Object.hasOwn(rule, 'enabled')) rule.enabled = enabled;
    }
  };
  for (const container of [result, result.extensions]) {
    if (!container) continue;
    for (const key of ['regex_scripts', 'regexScripts', 'regex', 'regexes']) applyFlags(container[key]);
  }
  for (const container of [result, result.SPreset, result.SPresetSettings,
    result.extensions, result.extensions?.SPreset, result.extensions?.SPresetSettings]) {
    const binding = container?.RegexBinding || container?.regexBinding;
    applyFlags(binding?.regexes); applyFlags(binding?.rules);
  }
  return result;
}

// Apply only the updater's actual changes. A concurrent edit to the same field
// is reported instead of silently replacing the user's newer data.
export function mergeScriptPresetChanges(before, edited, current, path = '') {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  if (same(before, edited)) return copy(current);
  if (same(current, before) || same(current, edited)) return copy(edited);
  const objects = [before, edited, current].every(value => value && typeof value === 'object' && !Array.isArray(value));
  if (objects) {
    const next = copy(current);
    for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const value = mergeScriptPresetChanges(before[key], edited[key], current[key], path + '.' + key);
      if (value === undefined) delete next[key]; else next[key] = value;
    }
    return next;
  }
  if (['.prompts', '.prompts_unused', '.regexes', '.extensions.regex_scripts'].includes(path)
    && [before, edited, current].every(Array.isArray)) {
    const maps = [before, edited, current].map(list => new Map(list.map(item => [item.id, item])));
    const [base, after, latest] = maps;
    const baseIds = before.map(item => item.id), afterIds = edited.map(item => item.id), latestIds = current.map(item => item.id);
    if (!same(baseIds, afterIds) && !same(baseIds, latestIds) && !same(afterIds, latestIds)) {
      throw new Error('预设条目顺序已改变，请刷新脚本面板后重试');
    }
    const ids = same(baseIds, afterIds) ? latestIds : afterIds;
    return ids.flatMap(id => {
      const value = mergeScriptPresetChanges(base.get(id), after.get(id), latest.get(id), path + '[' + id + ']');
      return value === undefined ? [] : [value];
    });
  }
  throw new Error('预设内容已改变，请刷新脚本面板后重试：' + path);
}

export function createPresetScriptApi({ getContext, callRpc, clone, updateContext }) {
  const getPreset = (name = 'in_use') => {
    const context = getContext();
    if (name !== 'in_use' && name !== context.presetName && name !== context.openaiPresetId) {
      throw new Error('同步 getPreset 只可读取当前预设；修改其他预设请使用 updatePresetWith');
    }
    return name === 'in_use'
      ? toScriptPreset(context.activePreset || {}, context.presetRegexes || [])
      : toScriptPreset(context.savedPreset || context.activePreset || {}, context.savedPresetRegexes || context.presetRegexes || []);
  };
  const updatePresetWith = async (name, updater) => {
    if (typeof updater !== 'function') throw new TypeError('updatePresetWith 需要更新函数');
    const sessionId = getContext().sessionId;
    const snapshot = await callRpc('preset.getSnapshot', { name, sessionId });
    const draft = clone(snapshot.preset);
    const result = await updater(draft);
    const edited = result === undefined ? draft : result;
    // Both spellings refer to the same bound regex set in getPreset. A JSON
    // snapshot loses that alias, so accept edits made through either spelling.
    if (JSON.stringify(edited.regexes) !== JSON.stringify(snapshot.preset.regexes)
      && JSON.stringify(edited.extensions?.regex_scripts) === JSON.stringify(snapshot.preset.extensions?.regex_scripts)) {
      edited.extensions = { ...edited.extensions, regex_scripts: edited.regexes };
    }
    const saved = await callRpc('preset.update', { name, sessionId, presetId: snapshot.presetId,
      before: snapshot.preset, edited });
    if (saved.context && getContext().sessionId === sessionId) updateContext(saved.context);
    return saved.preset;
  };
  return { getPreset, updatePresetWith,
    getPresetNames: () => clone(getContext().presetNames || []),
    getLoadedPresetName: () => String(getContext().presetName || ''),
  };
}
