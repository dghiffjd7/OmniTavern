import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const configSource = await readFile(path.join(root, 'src/scripts/ui/config-panel.js'), 'utf8');
const imageParamsSource = await readFile(path.join(root, 'src/scripts/ui/image-generation-params-panel.js'), 'utf8');
const secondarySource = await readFile(path.join(root, 'src/assets/css/api-config-secondary.css'), 'utf8');
const indexSource = await readFile(path.join(root, 'src/index.html'), 'utf8');

assert.match(configSource, /const apiConfigIconSvg\s*=/);
assert.match(configSource, /const API_CONFIG_ICONS\s*=\s*Object\.freeze/);
assert.match(configSource, /id="config-close"[\s\S]*?\$\{API_CONFIG_ICONS\.close\}/);
assert.match(configSource, /id="profile-new"[\s\S]*?\$\{API_CONFIG_ICONS\.plus\}/);
assert.match(configSource, /id="profile-rename"[\s\S]*?\$\{API_CONFIG_ICONS\.pencil\}/);
assert.match(configSource, /id="profile-delete"[\s\S]*?\$\{API_CONFIG_ICONS\.trash\}/);
assert.match(configSource, /id="manage-keys"[\s\S]*?\$\{API_CONFIG_ICONS\.key\}/);
assert.match(configSource, /id="refresh-models"[\s\S]*?\$\{API_CONFIG_ICONS\.refresh\}/);
assert.match(configSource, /id="open-generation-param-filter"[\s\S]*?\$\{API_CONFIG_ICONS\.filter\}/);
assert.match(configSource, /id="config-test"[\s\S]*?\$\{API_CONFIG_ICONS\.zap\}/);
assert.match(configSource, /id="config-save"[\s\S]*?\$\{API_CONFIG_ICONS\.save\}/);

const filterDialogSource = await readFile(path.join(root, 'src/scripts/ui/request-params-panel.js'), 'utf8');
assert.match(configSource, /openRequestParamsPanel\(\{/);
for (const name of ['api-param-filter-overlay', 'api-param-filter-dialog', 'api-param-filter-header', 'api-param-filter-body', 'api-param-filter-footer']) {
  assert.ok(filterDialogSource.includes(name));
}
assert.match(filterDialogSource, /role="tablist"/);
assert.match(filterDialogSource, /data-rp-role="json"/);
assert.match(filterDialogSource, /data-rp-field="enabled"/);
assert.doesNotMatch(filterDialogSource, /style="/, 'request parameters use the shared theme stylesheet');

assert.doesNotMatch(imageParamsSource, /STYLE_ID|ensureStyles/, '图片参数页面样式应迁移到独立样式表');
assert.match(imageParamsSource, /const ICONS\s*=\s*Object\.freeze/);
assert.match(imageParamsSource, /class="igp-header"/);
assert.match(imageParamsSource, /class="igp-fields-grid"/);
assert.match(imageParamsSource, /field\.variant\s*\?\s*`is-\$\{field\.variant\}`/);
assert.match(configSource, /showImageParamsPage\(\)[\s\S]*?classList\.add\('is-image-params-page'\)/);
assert.match(configSource, /hideImageParamsPage\(\)[\s\S]*?classList\.remove\('is-image-params-page'\)/);
assert.match(configSource, /isOpen\(\)\s*\{[\s\S]*?style\.display !== 'none'/);

assert.match(indexSource, /api-config\.css[\s\S]*?api-config-secondary\.css/);
assert.match(secondarySource, /\.api-param-filter-overlay\s*\{[\s\S]*?backdrop-filter:\s*blur\(1\.5px\)/);
assert.match(secondarySource, /\.api-param-filter-dialog\s*\{[\s\S]*?width:\s*min\(600px,\s*100%\)[\s\S]*?border-radius:\s*18px/);
assert.match(secondarySource, /animation:\s*api-param-filter-dialog-in 0\.24s cubic-bezier\(0\.2,\s*1\.1,\s*0\.35,\s*1\)/);
assert.match(secondarySource, /\.api-param-filter-common-chip\.is-active/);
assert.match(secondarySource, /\.api-param-filter-selected\s*\{/);
assert.match(secondarySource, /#config-panel\.api-config-panel\.is-image-params-page[\s\S]*?\.api-config-header\s*\{[\s\S]*?display:\s*none/);
assert.match(secondarySource, /\.igp-panel-embedded\s+\.igp-fields-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
assert.match(secondarySource, /\.igp-field\s*\{[\s\S]*?border-radius:\s*14px[\s\S]*?padding:\s*16px/);
assert.match(secondarySource, /\.igp-field\.is-full-width\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
assert.match(secondarySource, /\.igp-field\.is-persistent-negative\s*\{[\s\S]*?var\(--app-accent-soft\)/);
assert.match(secondarySource, /\.igp-field-badge\s*\{/);
assert.match(secondarySource, /@media \(prefers-reduced-motion:\s*reduce\)/);
assert.match(secondarySource, /body\[data-reduced-motion='on'\][\s\S]*?\.api-param-filter-dialog/);
assert.doesNotMatch(secondarySource, /#[0-9a-fA-F]{3,8}\b/, '次级 API 配置页面应使用主题 token，不新增硬编码色值');

console.log('ok - API config secondary surfaces carry reference SVG, filter dialog, and image parameter design');
