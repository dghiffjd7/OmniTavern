// Short, interruptible disclosure transitions. Work happens only on user interaction.
export const bindAgentEditorMotion = root => {
  const active = new Map(), doc = root.ownerDocument;
  const reduced = () => doc.body?.dataset.reducedMotion === 'on'
    || doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const stop = detail => {
    const current = active.get(detail); if (!current) return;
    active.delete(detail); current.animation.cancel(); current.finish();
  };
  const click = event => {
    const summary = event.target.closest?.('summary'), detail = summary?.parentElement;
    if (!detail || detail.tagName !== 'DETAILS' || !root.contains(detail)
      || event.target.closest('button,input,a,[data-help]')) return;
    if (reduced() || typeof detail.animate !== 'function') return;
    event.preventDefault();
    const previous = active.get(detail), expanded = previous ? !previous.expanded : !detail.open;
    const start = detail.getBoundingClientRect().height;
    stop(detail);
    detail.open = true;
    const end = expanded ? detail.scrollHeight : summary.getBoundingClientRect().height
      + parseFloat(doc.defaultView.getComputedStyle(detail).paddingTop || 0)
      + parseFloat(doc.defaultView.getComputedStyle(detail).paddingBottom || 0)
      + parseFloat(doc.defaultView.getComputedStyle(detail).borderTopWidth || 0)
      + parseFloat(doc.defaultView.getComputedStyle(detail).borderBottomWidth || 0);
    detail.dataset.acExpanding = String(expanded);
    detail.style.overflow = 'hidden';
    const finish = () => {
      detail.style.overflow = ''; delete detail.dataset.acExpanding;
      detail.open = expanded;
    };
    const animation = detail.animate([{ height: `${start}px` }, { height: `${end}px` }],
      { duration: expanded ? 190 : 150, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' });
    active.set(detail, { animation, expanded, finish });
    animation.finished.then(() => {
      if (active.get(detail)?.animation !== animation) return;
      active.delete(detail); finish();
    }).catch(() => {});
  };
  root.addEventListener('click', click);
  return {
    pulse: element => {
      if (!element || reduced() || typeof element.animate !== 'function') return;
      element.animate([{ opacity: .65, transform: 'translateY(2px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 160, easing: 'cubic-bezier(.22,1,.36,1)' });
    },
    dispose: () => { root.removeEventListener('click', click); [...active.keys()].forEach(stop); },
  };
};
