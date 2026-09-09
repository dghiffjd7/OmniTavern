import assert from 'node:assert/strict';
import { cloneData } from '../../src/scripts/utils/clone-data.js';

const nativeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
assert.equal(typeof nativeDescriptor?.value, 'function');
try {
  for (const mode of ['native', 'legacy']) {
    if (mode === 'legacy') delete globalThis.structuredClone;
    const shared = { value: 1, missing: undefined };
    const buffer = new ArrayBuffer(12);
    const source = {
      first: shared, second: shared, undefined: undefined, nan: NaN, infinity: Infinity, negativeZero: -0, big: 12n,
      sparse: new Array(3), date: new Date('2026-09-08T00:00:00Z'), regex: /hello/gi,
      map: new Map([[shared, shared]]), set: new Set([shared]), buffer,
      bytes: new Uint8Array(buffer, 2, 4), view: new DataView(buffer, 3, 2),
      literal: JSON.parse('{"__proto__":{"value":7}}'),
      error: new TypeError('snapshot error', { cause: shared }),
    };
    source.self = source;
    source.sparse[1] = shared;
    source.regex.lastIndex = 3;
    source.bytes[0] = 8;
    const result = cloneData(source);
    assert.notEqual(result, source);
    assert.equal(result.self, result);
    assert.equal(result.first, result.second);
    assert.equal(result.map.get(result.first), result.first);
    assert(result.set.has(result.first));
    assert.equal(result.sparse[1], result.first);
    assert.equal(result.sparse.length, 3);
    assert.equal(0 in result.sparse, false);
    assert(Object.hasOwn(result, 'undefined'));
    assert(Object.hasOwn(result.first, 'missing'));
    assert(Number.isNaN(result.nan));
    assert.equal(result.infinity, Infinity);
    assert(Object.is(result.negativeZero, -0));
    assert.equal(result.big, 12n);
    assert.equal(result.date.getTime(), source.date.getTime());
    assert.equal(result.regex.source, 'hello');
    assert.equal(result.regex.flags, 'gi');
    assert.equal(result.regex.lastIndex, 0);
    assert.notEqual(result.buffer, buffer);
    assert.equal(result.bytes.buffer, result.buffer);
    assert.equal(result.view.buffer, result.buffer);
    assert.equal(result.bytes.byteOffset, 2);
    assert.equal(result.view.byteOffset, 3);
    assert.equal(result.view.byteLength, 2);
    assert.equal(result.bytes[0], 8);
    result.bytes[0] = 9;
    result.first.value = 5;
    assert.equal(source.bytes[0], 8);
    assert.equal(shared.value, 1);
    assert.equal(Object.getPrototypeOf(result.literal), Object.prototype);
    assert(Object.hasOwn(result.literal, '__proto__'));
    assert.equal(result.literal.__proto__.value, 7);
    assert(result.error instanceof TypeError);
    assert.equal(result.error.message, source.error.message);
    assert.equal(result.error.cause, result.first);
    assert.equal(result.error.stack, source.error.stack);
    const frozen = Object.freeze({ child: Object.freeze({ value: 1 }) });
    const thawed = cloneData(frozen);
    thawed.child.value = 2;
    assert.equal(frozen.child.value, 1);
    const blob = new Blob(['voice sample'], { type: 'audio/wav' });
    const blobCopy = cloneData(blob);
    assert.notEqual(blobCopy, blob);
    assert.equal(blobCopy.type, blob.type);
    assert.equal(await blobCopy.text(), 'voice sample');
    for (const value of [() => {}, Symbol('private'), { callback() {} }, new WeakMap()]) {
      assert.throws(() => cloneData(value), error => error.name === 'DataCloneError');
    }
    if (mode === 'legacy') assert.equal(typeof globalThis.structuredClone, 'undefined', 'helper does not alter global APIs');
    console.log(`ok - ${mode} data cloning preserves graph identity, values, attachments and snapshot isolation`);
  }
} finally {
  Object.defineProperty(globalThis, 'structuredClone', nativeDescriptor);
}
