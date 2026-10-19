import assert from 'node:assert/strict';

import { formatFileTimestamp, resolveChatImageDownloadName, safeFileNamePart } from '../../src/scripts/ui/chat/chat-image-download-name.js';

const at = new Date(2026, 9, 16, 17, 35, 12).getTime();

{
  const generated = (index, extra = {}) => ({
    role: 'assistant',
    type: 'image',
    content: 'http://asset.localhost/C%3A%5CUsers%5Calan%5CAppData%5CRoaming%5Ccom.chatapp.dev%5Cattachments%5Cx.png',
    meta: {
      localPath: `C:\\Users\\alan\\AppData\\Roaming\\com.chatapp.dev\\attachments\\chat_1\\attachment_chat_1_generated_image_${at}_${index}.png_${at}.png`,
      generatedMedia: { createdAt: at, output: { mime: 'image/png' } },
      ...extra,
    },
  });
  assert.equal(resolveChatImageDownloadName(generated(1), { characterName: '星见雅' }), '星见雅_20261016-173512.png');
  assert.equal(resolveChatImageDownloadName(generated(2), { characterName: '星见雅' }), '星见雅_20261016-173512_2.png', 'later images of one generation get a number');
  assert.equal(resolveChatImageDownloadName(generated(1), { characterName: '' }), '生成图片_20261016-173512.png');
  assert.equal(resolveChatImageDownloadName(generated(1), { characterName: 'A/B: 测试?', ext: 'webp' }), 'A_B_测试_20261016-173512.webp', 'illegal characters are replaced');
  const later = generated(1);
  later.meta.generatedMedia.createdAt = new Date(2026, 9, 16, 17, 35, 13).toISOString();
  assert.notEqual(resolveChatImageDownloadName(later, { characterName: '星见雅' }), resolveChatImageDownloadName(generated(1), { characterName: '星见雅' }), 'different images do not share a name');
  console.log('ok - generated images are named after the character and generation time');
}

{
  const uploaded = { role: 'user', type: 'image', name: '哲', timestamp: at, content: 'http://asset.localhost/xxx', meta: { originalName: '旅行 照片.JPG' } };
  assert.equal(resolveChatImageDownloadName(uploaded, { ext: 'jpg' }), '旅行_照片.JPG');
  assert.equal(resolveChatImageDownloadName({ ...uploaded, meta: { originalName: '截图' } }, { ext: 'png' }), '截图.png');
  assert.equal(resolveChatImageDownloadName({ ...uploaded, meta: {} }, { ext: 'png' }), '哲_20261016-173512.png', 'a pasted image without a name never falls back to the image address');
  assert.equal(resolveChatImageDownloadName({ type: 'image', meta: {}, timestamp: at }), '图片_20261016-173512.png');
  console.log('ok - other chat images keep their original name or use sender and time');
}

{
  assert.equal(formatFileTimestamp(at), '20261016-173512');
  assert.equal(safeFileNamePart('  a\tb  c  '), 'a_b_c');
  assert.equal(safeFileNamePart('很长'.repeat(30), 5), '很长很长很', 'cut by characters, not bytes');
  console.log('ok - file name helpers format local timestamps and sanitize name parts');
}
