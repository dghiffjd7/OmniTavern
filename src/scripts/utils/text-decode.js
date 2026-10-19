// 把文件字节解码成文本：识别 BOM（UTF-8／UTF-16LE／UTF-16BE）；没有 BOM 时先按 UTF-8，
// 不合法再按 GB18030（Windows 中文记事本常见）。开头 8KB 内有 NUL 字节视为二进制，返回 null。

const SNIFF_BYTES = 8192;

const decodeWith = (label, bytes, fatal = true) => {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
};

export const looksBinary = (bytes) => {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
};

/** 返回 { text, encoding } 或 null（二进制或无法解码）。 */
export const decodeTextBytes = (input) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = decodeWith('utf-8', bytes.subarray(3), false);
    return text === null ? null : { text, encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = decodeWith('utf-16le', bytes.subarray(2), false);
    return text === null ? null : { text, encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = decodeWith('utf-16be', bytes.subarray(2), false);
    return text === null ? null : { text, encoding: 'utf-16be' };
  }
  if (looksBinary(bytes)) return null;
  const utf8 = decodeWith('utf-8', bytes);
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };
  const gb = decodeWith('gb18030', bytes);
  if (gb !== null) return { text: gb, encoding: 'gb18030' };
  return null;
};
