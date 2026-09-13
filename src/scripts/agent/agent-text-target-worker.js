import { resolveAgentTextTarget } from './agent-text-target.js';
self.onmessage = event => {
  const { source, rule, options } = event.data;
  self.postMessage(resolveAgentTextTarget(source, rule, options));
};
