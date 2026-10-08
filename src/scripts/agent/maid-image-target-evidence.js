const trim = value => String(value ?? '').trim();
const nameKey = value => trim(value).normalize('NFKC').toLowerCase();

// Only actual successful identity reads from this task may supply candidates.
// Do not resolve model-invented IDs with fuzzy matching, search other cards, or
// treat text inside descriptions as resource identities.
export const findMaidImageTargetMismatch = ({plan = {}, steps = []} = {}) => {
  if (plan.toolName !== 'media.generate_image' || plan.args?.purpose !== 'avatar') return null;
  const target = trim(plan.args?.target), subject = nameKey(plan.args?.subject);
  if (!target || !subject) return null;
  const known = new Map();
  const add = (rows, kind) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = trim(row?.id), name = trim(row?.name);
      if (id && name) known.set(`${kind}:${id}`, {id, name, kind});
    }
  };
  for (const step of steps) {
    if (step?.status !== 'succeeded' || step.output?.ok === false) continue;
    const output = step.output || {};
    if (step.toolName === 'session.list') add(output.contacts, 'contact');
    if (step.toolName === 'app.read_resource') {
      if (output.resource === 'session') add(output.sessions, 'contact');
      if (output.resource === 'persona') add(output.items, 'persona');
      if (output.resource === 'user') add(output.items, 'user');
    }
  }
  const targets = [...known.values()];
  if (targets.some(row => row.id === target || nameKey(row.name) === nameKey(target))) return null;
  const observedTargets = targets.filter(row => nameKey(row.name) === subject);
  if (!observedTargets.length) return null; // A standalone original-character preview has no stored target.
  return {ok:false, reason:'image_target_not_observed', stage:'preflight', localToolExecutionSkipped:true,
    requestedTarget:target, observedTargets:observedTargets.slice(0,10),
    message:'This target was not found in the actual identity reads for this task. The observedTargets list contains the exact records matching the subject. Use an observed ID or read the intended target; do not retry the same invented ID. No image provider request was sent. This readback does not authorize applying an image.'};
};
