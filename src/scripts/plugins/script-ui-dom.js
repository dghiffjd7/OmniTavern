const marker = 'data-chatapp-virtual-node-id';
const keyOf = node => node.nodeType === 1 ? node.getAttribute(marker) || '' : '';
const sameKind = (left, right) => left?.nodeType === right.nodeType
  && (right.nodeType !== 1 || (left.localName === right.localName && left.namespaceURI === right.namespaceURI));

// Preserve the native nodes corresponding to the Worker's virtual node IDs.
// Replacing the shadow tree on each input destroys focus, selection and IME.
export function patchScriptUiChildren(parent, incoming, { composing = new Set() } = {}) {
  const patchNode = (node, next) => {
    if (node.nodeType !== 1) {
      if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
      return;
    }
    const keepComposition = composing.has(keyOf(node));
    for (const attr of Array.from(node.attributes)) {
      if (keepComposition && attr.name === 'value') continue;
      if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    }
    for (const attr of Array.from(next.attributes)) {
      if (keepComposition && attr.name === 'value') continue;
      if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    }
    if (keepComposition && ['INPUT', 'TEXTAREA'].includes(node.tagName)) return;
    patchChildren(node, next);
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) {
      const value = next.tagName === 'SELECT' && next.hasAttribute('value') ? next.getAttribute('value') : next.value;
      // Writing an unchanged value can also disturb an active selection/IME.
      if (node.type !== 'file' && node.value !== value) node.value = value;
      if (node.tagName === 'INPUT' && node.checked !== next.checked) node.checked = next.checked;
    }
    if (node.tagName === 'DETAILS' && node.open !== next.open) node.open = next.open;
  };
  const patchChildren = (target, source) => {
    const old = Array.from(target.childNodes);
    const keyed = new Map(old.filter(keyOf).map(node => [keyOf(node), node]));
    const used = new Set();
    let cursor = target.firstChild;
    for (const next of Array.from(source.childNodes)) {
      const key = keyOf(next);
      let node = key ? keyed.get(key) : old.find(candidate => !used.has(candidate) && !keyOf(candidate) && sameKind(candidate, next));
      if (!node || !sameKind(node, next)) {
        node = next.cloneNode(true);
        // select.value is a live property; cloning only carries attributes.
        for (const select of [node, ...Array.from(node.querySelectorAll?.('select[value]') || [])]) {
          if (select.tagName === 'SELECT' && select.hasAttribute('value')) select.value = select.getAttribute('value');
        }
      } else patchNode(node, next);
      used.add(node);
      if (node !== cursor) target.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    for (const node of old) if (!used.has(node)) node.remove();
  };
  patchChildren(parent, incoming);
}
