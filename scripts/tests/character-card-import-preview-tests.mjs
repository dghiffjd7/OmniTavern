import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual dialog without importing the storage-writing importer.
const source = await readFile(new URL('../../src/scripts/ui/character-card-importer.js', import.meta.url), 'utf8');
const dialogSource = source.slice(source.indexOf('const promptImportOptions ='), source.indexOf('export class CharacterCardImporter {'));
assert.ok(dialogSource.length > 0);
const elements = [];
const createElement = () => {
  const nodes = new Map();
  const element = {
    style: {}, innerHTML: '', textContent: '', hidden: false, checked: false,
    appendChild() {}, remove() {},
    addEventListener(type, fn) { this[type] = fn; },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, createElement());
      return nodes.get(selector);
    },
  };
  elements.push(element);
  return element;
};
const context = vm.createContext({
  document: { createElement, body: { appendChild() {} } },
  bindBackdropActivation: () => () => {},
});
const prompt = vm.runInContext(`${dialogSource}\npromptImportOptions;`, context);
const displayName = '<b data-import-marker="name">Alice & Bob</b>';
const fileName = '<i data-import-marker="file">card</i>.png';
const pending = prompt({ displayName, fileName, worldCount: 1, greetingCount: 1, regexCount: 1, scriptCount: 1 });
const panel = elements[1];
assert.ok(!panel.innerHTML.includes(displayName), 'card metadata must never be interpolated into HTML');
assert.ok(!panel.innerHTML.includes(fileName), 'filenames must never be interpolated into HTML');
assert.equal(panel.querySelector('[data-cc-import-title]').textContent, `导入角色卡：${displayName}`);
assert.equal(panel.querySelector('[data-cc-import-file]').textContent, `文件：${fileName}`);
panel.querySelector('#cc-opt-world').checked = true;
panel.querySelector('#cc-opt-confirm').click();
assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
  importWorld: true, importGreetings: false, importSystemPrompt: false, importRegex: false, importScripts: false,
});
console.log('ok - import preview renders external names as literal text and keeps import choices intact');
