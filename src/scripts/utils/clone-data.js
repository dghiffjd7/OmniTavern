// Copy App data snapshots without relying on structuredClone being installed.
// Native browsers keep their own cloning behavior; the legacy path covers data
// objects, collections, dates, errors and binary attachments. No transfer API.
const objectTag = value => Object.prototype.toString.call(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const errorTypes = new Map([Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].map(type => [type.name, type]));
const typedArrays = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Float16Array']);

const cannotClone = () => {
  if (typeof DOMException === 'function') throw new DOMException('Value cannot be cloned', 'DataCloneError');
  const error = new Error('Value cannot be cloned');
  error.name = 'DataCloneError';
  throw error;
};

const cloneLegacy = (value, seen) => {
  if (typeof value === 'function' || typeof value === 'symbol') return cannotClone();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const tag = objectTag(value);
  let copy;
  if (tag === '[object Date]') copy = new Date(value.getTime());
  else if (tag === '[object RegExp]') copy = new RegExp(value.source, value.flags);
  else if (tag === '[object ArrayBuffer]') copy = value.slice(0);
  else if (ArrayBuffer.isView(value)) {
    const buffer = cloneLegacy(value.buffer, seen);
    const name = tag.slice(8, -1);
    if (name === 'DataView') copy = new DataView(buffer, value.byteOffset, value.byteLength);
    else if (typedArrays.has(name) && typeof globalThis[name] === 'function') copy = new globalThis[name](buffer, value.byteOffset, value.length);
    else return cannotClone();
  } else if (tag === '[object File]' && typeof File === 'function') {
    copy = new File([value], value.name, { type: value.type, lastModified: value.lastModified });
  } else if (tag === '[object Blob]') copy = value.slice(0, value.size, value.type);
  else if (tag === '[object Error]') {
    const ErrorType = errorTypes.get(value.name) || Error;
    copy = new ErrorType(value.message);
    seen.set(value, copy);
    if (typeof value.stack === 'string') copy.stack = value.stack;
    if (hasOwn(value, 'cause')) Object.defineProperty(copy, 'cause', { value: cloneLegacy(value.cause, seen), writable: true, configurable: true });
    return copy;
  } else if (tag === '[object Map]') {
    copy = new Map();
    seen.set(value, copy);
    value.forEach((entry, key) => copy.set(cloneLegacy(key, seen), cloneLegacy(entry, seen)));
    return copy;
  } else if (tag === '[object Set]') {
    copy = new Set();
    seen.set(value, copy);
    value.forEach(entry => copy.add(cloneLegacy(entry, seen)));
    return copy;
  } else if (Array.isArray(value) || tag === '[object Object]') {
    copy = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      // Define data properties so a literal __proto__ key stays data.
      Object.defineProperty(copy, key, { value: cloneLegacy(value[key], seen), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  } else return cannotClone();
  seen.set(value, copy);
  return copy;
};

export const cloneData = value => {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return cloneLegacy(value, new Map());
};
