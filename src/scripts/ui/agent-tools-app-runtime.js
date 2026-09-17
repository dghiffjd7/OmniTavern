import { createTextEditRuntime } from '../agent/text-edit-runtime.js';
import { createAgentConfigurationService } from '../agent/agent-configuration-service.js';
import { bindInputAgentComposer } from './chat/input-agent-composer.js';
import { createRenderedAgentTargetResolver } from './chat/agent-rendered-body.js';
import { createAgentToolbox } from './agent-toolbox.js';

// Agent 配置、输入候选、回复修改与工具箱的装配及生命周期；app.js 提供模型和持久化能力。
export const createAgentToolsAppRuntime = ({ ui, store, getContext, getMessages, findMessage, getRaw, getProfiles, getEvidence,
  captureModel, request, previewRequest, commitReply, notifyReply, getDisplaySource, getReasoningBoundaries, getCurrentModelLabel, resolveReference, listReferenceSources, listAvailableTools, buildFormatPreview, runFormat, getFormatTarget, budget,
  openAgent, openCenter, openFormatResult, toolboxContainer, toolboxAnchor, onToolboxOpen, storage, documentRef = document } = {}) => {
  const win = documentRef.defaultView;
  const resolveTarget = getDisplaySource ? createRenderedAgentTargetResolver({ getDisplaySource, getReasoningBoundaries, documentRef }) : undefined;
  const changed = event => () => win.dispatchEvent(new win.CustomEvent(event));
  const textEditRuntime = createTextEditRuntime({ getContext, getMessage: findMessage || ((mid,sid) => getMessages(sid)?.find(m => m.id === mid)), getMessages, getRaw,
    getConfig: (id,sid) => store.read(id,getContext(sid)).config,
    getBodyRule: sid => store.read('body-selector',getContext(sid)).config?.target,
    captureModel: (config,sid) => captureModel(config,getContext(sid)),
    request: (payload,model,signal,sid,execution) => request(payload,model,signal,getContext(sid),execution),
    review: options => ui.openFormatPatchReview(options), commit: commitReply, notify: notifyReply,
    onChange: changed('agent-text-edit-changed'), resolveTarget, resolveReference,
  });
  const inputAgents = bindInputAgentComposer({ input:ui.inputEl, getContext, getMessages,
    getConfig: (id,context,scope) => store.read(id,context,scope).config,
    listConfigs: () => store.list(getContext()).map(r => r.config), captureModel, request, resolveReference,
    review: options => ui.openFormatPatchReview(options), onChange: changed('agent-input-changed'), budget,
  });
  const actions = createAgentConfigurationService({ store,getContext,getMessages,getRaw,getProfiles,getEvidence,
    runtime:textEditRuntime, runFormat, getFormatTarget, buildFormatPreview, previewRequest, resolveTarget, getCurrentModelLabel, resolveReference, listReferenceSources, listAvailableTools,
    getInput: () => ({before:ui.inputEl.value.slice(0,ui.inputEl.selectionStart),after:ui.inputEl.value.slice(ui.inputEl.selectionEnd)}),
    getInputRuntime: () => inputAgents, buildInputPreview: config => inputAgents.preview(config),
  });
  const toolbox = createAgentToolbox({input:ui.inputEl,actions,getContext,getMessages,getInputSnapshot:inputAgents.snapshot,openAgent,openCenter,openFormatResult,
    triggerContainer:toolboxContainer,anchorEl:toolboxAnchor,targetEventRoot:ui.scrollEl,beforeOpen:onToolboxOpen,documentRef,storage});
  const reconcile = () => {textEditRuntime.reconcile();inputAgents.reconcile();runFormat?.reconcile?.();};
  win.addEventListener('agent-feature-settings-changed',reconcile);
  win.addEventListener('session-changed',reconcile);
  return {actions,textEditRuntime,inputAgents,toolbox,
    dispose:()=>{win.removeEventListener('agent-feature-settings-changed',reconcile);win.removeEventListener('session-changed',reconcile);toolbox.dispose();inputAgents.dispose();textEditRuntime.dispose();},
  };
};
