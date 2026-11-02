import assert from 'node:assert/strict';

// 最小 canvas 桩：记录底色，toDataURL 回传底色以便断言
globalThis.document = {
  createElement: () => {
    const ctx = { fillStyle: '', background: '', fillRect() { this.background = this.fillStyle; }, fillText() {} };
    return { getContext: () => ctx, toDataURL: () => `data:test,${ctx.background}` };
  },
};

const { resolveLineAvatar, STRANGER_COLOR_SCHEME, TAG_COLOR_SCHEMES } = await import('../../src/scripts/utils/line-avatar.js');
const background = url => url.replace('data:test,', '');

{
  const names = ['路人甲', '店小二', '神秘人', 'Guard', '老板娘', '黑衣人'];
  const strangers = names.map(name => background(resolveLineAvatar({ name, palette: 'stranger' })));
  assert.ok(strangers.every(color => STRANGER_COLOR_SCHEME.includes(color)), 'non-member speakers use the colorful palette');
  assert.ok(new Set(strangers).size > 1, 'different names get different colors');
  assert.equal(background(resolveLineAvatar({ name: '路人甲', palette: 'stranger' })), strangers[0], 'the same name keeps its color');

  const untagged = background(resolveLineAvatar({ name: '路人甲' }));
  assert.ok(TAG_COLOR_SCHEMES.default.includes(untagged), 'untagged contacts keep the grey palette');
  assert.equal(resolveLineAvatar({ avatar: 'https://x/a.png', name: '路人甲', palette: 'stranger' }), 'https://x/a.png', 'a real avatar always wins');
  console.log('ok - non-member group speakers get a stable colorful letter avatar');
}

console.log('line-avatar-tests passed');
