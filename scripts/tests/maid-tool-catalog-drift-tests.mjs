import assert from 'node:assert/strict';

import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { registerAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { registerAppSessionAgentTools } from '../../src/scripts/agent/tools/app-session-tools.js';
import { registerGroupChatAgentTools } from '../../src/scripts/agent/tools/group-chat-agent-tools.js';
import { registerAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';
import { registerMaidMediaAssetTools } from '../../src/scripts/agent/tools/media-asset-tools.js';
import { registerAppUiCaptureTools } from '../../src/scripts/agent/tools/app-ui-capture-tools.js';
import { registerMaidTodoTools } from '../../src/scripts/agent/tools/maid-todo-tools.js';
import { registerMaidMemoryTools } from '../../src/scripts/agent/tools/maid-memory-tools.js';
import { registerGuideStartFlowTools } from '../../src/scripts/agent/tools/guide-start-flow-tools.js';
import { registerChatFormatRepairTools } from '../../src/scripts/agent/tools/chat-format-tools.js';
import { registerWebSearchAgentTools } from '../../src/scripts/agent/tools/web-search-tools.js';
import { registerMomentsAgentTools } from '../../src/scripts/agent/tools/moments-tools.js';
import { registerPresetRegexScriptAgentTools } from '../../src/scripts/agent/tools/preset-regex-script-tools.js';

// 已注册但不进入功能目录的元工具/本地工具。
// 新工具默认必须进目录；确需豁免时在这里登记并写明原因。
const CATALOG_EXEMPT_TOOLS = new Set([
  // 四项内建新手流程由本地意图路由直接启动，不进入女仆模型上下文。
  'guide.start_flow',
]);

const registry = createAgentToolRegistry();
registerAppNavigationAgentTools(registry, {});
registerAppSessionAgentTools(registry, {});
registerGroupChatAgentTools(registry, {});
registerAppContentAgentTools(registry, {});
registerMaidMediaAssetTools(registry, {});
registerAppUiCaptureTools(registry, {});
registerMaidTodoTools(registry, {});
registerMaidMemoryTools(registry, {});
registerGuideStartFlowTools(registry, {});
registerChatFormatRepairTools(registry, {});
registerWebSearchAgentTools(registry, {});
registerMomentsAgentTools(registry, {});
registerPresetRegexScriptAgentTools(registry, {});

const registeredNames = new Set(registry.listTools().map(tool => tool.name));
const features = listAppFeatures();
const catalogToolNames = new Set(
  features.flatMap(feature => (Array.isArray(feature.tools) ? feature.tools : [])),
);

{
  const missingInRegistry = Array.from(catalogToolNames)
    .filter(name => !registeredNames.has(name));
  assert.deepEqual(
    missingInRegistry,
    [],
    `功能目录引用了未注册的工具：${missingInRegistry.join(', ')}`,
  );
  console.log('ok - 功能目录引用的每个工具都已在 registry 注册');
}

{
  const missingInCatalog = Array.from(registeredNames)
    .filter(name => !catalogToolNames.has(name) && !CATALOG_EXEMPT_TOOLS.has(name));
  assert.deepEqual(
    missingInCatalog,
    [],
    `已注册工具未进入功能目录（如确属元工具请登记豁免并说明原因）：${missingInCatalog.join(', ')}`,
  );
  console.log('ok - 每个已注册女仆工具都在功能目录或豁免清单中');
}

{
  const staleExemptions = Array.from(CATALOG_EXEMPT_TOOLS)
    .filter(name => !registeredNames.has(name) || catalogToolNames.has(name));
  assert.deepEqual(
    staleExemptions,
    [],
    `豁免清单过期（工具已删除或已进目录）：${staleExemptions.join(', ')}`,
  );
  console.log('ok - 豁免清单没有过期条目');
}

{
  const missingVerificationDecl = features
    .filter(feature => feature.writes === true)
    .filter(feature => !Object.prototype.hasOwnProperty.call(feature, 'verification'))
    .map(feature => feature.id);
  assert.deepEqual(
    missingVerificationDecl,
    [],
    `写入类功能必须显式声明 verification（对象或 null）：${missingVerificationDecl.join(', ')}`,
  );
  const invalidVerificationTools = features
    .filter(feature => feature.verification?.tool)
    .filter(feature => !registeredNames.has(feature.verification.tool))
    .map(feature => `${feature.id} -> ${feature.verification.tool}`);
  assert.deepEqual(
    invalidVerificationTools,
    [],
    `verification.tool 指向未注册工具：${invalidVerificationTools.join(', ')}`,
  );
  console.log('ok - 写入类功能都显式声明了 verification 且验证工具已注册');
}

{
  const directActionMissing = features
    .filter(feature => feature.directAction)
    .filter(feature => !registeredNames.has(feature.directAction))
    .map(feature => `${feature.id} -> ${feature.directAction}`);
  assert.deepEqual(
    directActionMissing,
    [],
    `功能目录 directAction 指向未注册工具：${directActionMissing.join(', ')}`,
  );
  console.log('ok - 每个功能的 directAction 都指向已注册工具');
}

{
  // v3 概念检索表硬编码 feature id；catalog 改名时 available.has(id) 会静默跳过而非报错，
  // 这里用源扫描把概念表引用锁定到真实目录，防止静默漂移。
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    resolve(here, '../../src/scripts/agent/maid-capability-concept-retriever.js'),
    'utf8',
  );
  const referenced = new Set();
  for (const match of source.matchAll(/add\(\s*(\[[^\]]*\]|'[^']+')/g)) {
    for (const id of match[1].match(/'([^']+)'/g) || []) {
      referenced.add(id.slice(1, -1));
    }
  }
  assert.ok(referenced.size >= 10, '概念表 id 提取异常（提取数过少，检查正则）');
  const catalogIds = new Set(features.map(feature => feature.id));
  const stale = Array.from(referenced).filter(id => !catalogIds.has(id));
  assert.deepEqual(stale, [], `概念检索表引用了目录中不存在的 feature：${stale.join(', ')}`);
  console.log(`ok - 概念检索表 ${referenced.size} 个 feature 引用全部存在于功能目录`);
}

console.log('maid-tool-catalog-drift-tests passed');
