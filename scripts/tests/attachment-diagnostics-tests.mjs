import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { describeJsonSyntaxError, diagnoseRegexRules, diagnoseScripts } = await import('../../src/scripts/import/attachment-diagnostics.js');
const { inspectAttachmentFile } = await import('../../src/scripts/import/attachment-file-inspector.js');

const parseError = (source) => { try { JSON.parse(source); } catch (error) { return error; } return null; };

{
  const source = '{\n  "name": "星港",\n  "entries": {\n    "0": { "content": "港口" }\n    "1": { "content": "灯塔" }\n  }\n}';
  const info = describeJsonSyntaxError(source, parseError(source));
  assert.deepEqual([info.line, info.column], [5, 5], 'the missing comma is located on the next key');
  assert.match(info.excerpt, /^3\| {3}"entries": \{/m);
  assert.match(info.excerpt, /5\| {5}"1": \{ "content": "灯塔" \}\n \| {5}\^/);
  const cut = describeJsonSyntaxError('{"a": [1, 2', parseError('{"a": [1, 2'));
  assert.equal(cut.line, 1, 'a truncated file points at its end');
  assert.deepEqual(describeJsonSyntaxError('x', new Error('weird')), { line: 0, column: 0, message: 'weird', excerpt: '' });
  console.log('ok - JSON syntax errors are located by line and column with nearby lines');
}

{
  const rules = [
    { scriptName: '好的', findRegex: '/<think>[\\s\\S]*?<\\/think>/g' },
    { scriptName: '少括号', findRegex: '/(abc/g' },
    { scriptName: '停用的坏规则', findRegex: '(', disabled: true },
    { name: '空的', findRegex: '' },
  ];
  const found = diagnoseRegexRules(rules);
  assert.equal(found.length, 2);
  assert.match(found[0], /^正则「少括号」无法使用：/);
  assert.equal(found[1], '正则「空的」无法使用：查找内容是空的');
  const many = diagnoseRegexRules(Array.from({ length: 8 }, (_v, i) => ({ scriptName: `坏${i}`, findRegex: '[' })));
  assert.deepEqual([many.length, many[5]], [6, '另有 3 条正则无法使用']);
  console.log('ok - regex rules are compiled one by one and broken ones are named');
}

{
  const tree = [
    { type: 'script', name: '普通', content: 'console.log(1)' },
    { type: 'folder', name: '夹', scripts: [{ type: 'script', name: '改页面', content: 'window.parent.document.body.append(x)' }] },
    { type: 'script', name: '顶层等待', content: 'await fetchSomething();' },
  ];
  const found = diagnoseScripts(tree);
  assert.equal(found.length, 1, 'only unsupported or limited scripts are listed (top-level await just runs as a module)');
  assert.match(found[0], /^脚本「改页面」：/);
  console.log('ok - scripts that need the host page are reported by name');
}

{
  const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const broken = inspectAttachmentFile({ name: '书.json', bytes: encode('{\n  "entries": {\n    "0": { "content": "a" },\n  }\n}') });
  assert.equal(broken.format, 'invalid_json');
  assert.match(broken.diagnostics[0], /^JSON 语法错误：第 4 行第 3 列/);
  assert.equal(broken.details.jsonError.line, 4);
  const regex = inspectAttachmentFile({ name: '规则.json', bytes: encode([{ scriptName: '坏', findRegex: '/(/', replaceString: '', placement: [2] }]) });
  assert.equal(regex.format, 'regex');
  assert.match(regex.diagnostics.join('\n'), /正则「坏」无法使用/);
  const card = inspectAttachmentFile({ name: '卡.json', bytes: encode({ spec: 'chara_card_v2', data: { name: '卡', first_mes: 'hi', extensions: { regex_scripts: [{ scriptName: '卡里的坏正则', findRegex: '[' }] } } }) });
  assert.match(card.diagnostics.join('\n'), /卡里的坏正则/);
  const js = inspectAttachmentFile({ name: '插件.js', mime: 'text/javascript', bytes: encode('top.document.title = "x"') });
  assert.match(js.diagnostics.join('\n'), /^脚本「插件」：/);
  console.log('ok - the attachment inspector reports located JSON errors, broken regex and unsupported scripts');
}

console.log('attachment-diagnostics-tests passed');
