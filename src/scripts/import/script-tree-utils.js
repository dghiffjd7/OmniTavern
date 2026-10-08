// 脚本树（与脚本面板导入一致的写法）：识别和导入共用，不依赖存储模块
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');

export const extractScriptTree = (json) => {
  const isScriptNode = item => isPlainObject(item)
    && (item.type === 'script' || item.type === 'folder' || (typeof item.content === 'string' && text(item.name)));
  if (Array.isArray(json)) return json.length && json.every(isScriptNode) ? json : [];
  if (!isPlainObject(json)) return [];
  if (Array.isArray(json.scripts) && json.scripts.every(isScriptNode)) return json.scripts;
  if (Array.isArray(json.tavern_helper?.scripts)) return json.tavern_helper.scripts;
  if (Array.isArray(json.extensions?.tavern_helper?.scripts)) return json.extensions.tavern_helper.scripts;
  if (json.type === 'script' || json.type === 'folder') return [json];
  return [];
};

export const countScripts = (nodes = [], depth = 0) => (Array.isArray(nodes) ? nodes : []).reduce((sum, node) => {
  if (!isPlainObject(node) || depth > 8) return sum;
  if (node.type === 'folder' || Array.isArray(node.scripts)) return sum + countScripts(node.scripts, depth + 1);
  return sum + 1;
}, 0);

