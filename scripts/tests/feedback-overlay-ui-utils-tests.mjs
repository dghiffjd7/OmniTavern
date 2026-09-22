import assert from 'node:assert/strict';

import { createFeedbackOverlayUiRuntime } from '../../src/scripts/ui/chat/feedback-overlay-ui-utils.js';

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.className = '';
      this.style = {};
      this.textContent = '';
      let inner = '';
      Object.defineProperty(this, 'innerHTML', {
        get: () => inner,
        set: (value) => {
          inner = String(value || '');
          this.children = [];
        },
      });
    }
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    }
  }
  return {
    body: new FakeElement('body'),
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
};

{
  const documentLike = createFakeDocument();
  const runtime = createFeedbackOverlayUiRuntime({
    documentLike,
    scheduleHide: () => {},
  });
  const overlay = runtime.openLightbox('image.png');
  assert.equal(documentLike.body.children[0], overlay);
  assert.equal(overlay.className, 'lightbox');
  assert.equal(overlay.children[0].src, 'image.png');
  overlay.onclick();
  assert.equal(documentLike.body.children.length, 0);
  console.log('ok - openLightbox mounts preview overlay and removes it on click');
  const quotedUrl = 'https://example.test/" data-filename="reference.png';
  const quoted = runtime.openLightbox(quotedUrl);
  assert.equal(quoted.children.length, 1);
  assert.equal(quoted.children[0].src, quotedUrl, 'image URLs are assigned as a property instead of interpolated into markup');
  quoted.onclick();
}

{
  const documentLike = createFakeDocument();
  const scheduled = [];
  const retries = [];
  const runtime = createFeedbackOverlayUiRuntime({
    documentLike,
    scheduleHide: (handler, delay) => scheduled.push([handler, delay]),
  });
  let banner = runtime.showErrorBanner(null, 'failed', {
    label: '重试一次',
    handler: () => retries.push('retry'),
  });
  assert.equal(documentLike.body.children[0], banner);
  assert.equal(banner.children[0].textContent, 'failed');
  assert.equal(banner.children[1].textContent, '重试一次');
  assert.equal(scheduled[0][1], 6000);
  banner.children[1].onclick();
  assert.deepEqual(retries, ['retry']);
  scheduled[0][0]();
  assert.equal(banner.style.display, 'none');
  banner = runtime.showErrorBanner(banner, 'warn', null);
  assert.equal(scheduled[1][1], 4000);
  assert.equal(banner.children.length, 1);
  console.log('ok - showErrorBanner reuses banner and varies auto-hide delay by action presence');
}
