export const installAgentRequestPreviewStyle = doc => {
  if (doc.getElementById('agent-request-preview-style')) return;
  const style = doc.createElement('style'); style.id = 'agent-request-preview-style';
  style.textContent = `
  .agent-center-floating-card.has-wide-request-preview{width:min(1120px,calc(100vw - 48px))}
  .agent-center-floating-face-back.has-request-preview{overflow:hidden}
  .hop-request-workspace{position:relative;display:flex;flex:1;min-height:0;min-width:0;overflow:hidden;margin:0 -16px -18px}
  .hop-request-editor{display:grid;align-content:start;gap:16px;flex:0 0 100%;box-sizing:border-box;min-width:0;padding:0 40px 0 16px;overflow:auto;scrollbar-width:thin;transition:none}
  .hop-request-workspace[data-preview=split] .hop-request-editor{flex-basis:50%}
  .hop-request-workspace[data-preview=full] .hop-request-editor{visibility:hidden}
  .hop-request-pane{position:absolute;inset:0 0 0 auto;display:flex;flex-direction:column;width:50%;background:var(--app-surface-card);border-left:1px solid var(--app-border-default);transform:translateX(102%);visibility:hidden;transition:none}
  .hop-request-workspace:not([data-preview=closed]) .hop-request-pane{transform:none;visibility:visible}
  .hop-request-workspace[data-preview=full] .hop-request-pane{width:100%;border-left:0}
  .hop-request-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 16px;border-bottom:1px solid var(--app-border-subtle)}
  .hop-request-head>div{min-width:0}.hop-request-head>div:last-child{display:flex;flex:none;gap:4px}
  .hop-request-head strong{font-size:13px;font-weight:600}.hop-request-meta{display:block;font-size:11px;color:var(--app-text-secondary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
  .hop-request-current{display:block;flex:none;height:44px;min-height:44px;margin:0;padding:8px 18px;border:0;border-bottom:1px solid var(--app-border-subtle);background:var(--app-accent-soft);color:var(--app-accent-primary);font:inherit;font-size:11px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hop-request-current[hidden]{display:none}.hop-request-current:disabled{background:var(--app-surface-subtle);color:var(--app-text-secondary);cursor:default}
  .hop-request-current:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:-3px}
  .hop-request-editor,.hop-request-scroll{overflow-anchor:none}
  [data-prompt-key][data-preview-active]{background:var(--app-accent-soft);border-radius:3px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
  [data-prompt-context-key][data-preview-active]>summary{color:var(--app-accent-primary)}
  .agent-memory-prompt-block summary[data-preview-active]{color:var(--app-accent-primary)}
  .hop-request-button{display:inline-flex;align-items:center;justify-content:center;min-width:44px;width:44px;height:44px;padding:0;border:0;border-radius:var(--app-radius-md,12px);color:var(--app-text-secondary);background:transparent;cursor:pointer}
  .hop-request-button:hover{color:var(--app-accent-primary);background:var(--app-accent-soft)}
  .hop-request-button:focus-visible,.hop-request-field-link:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
  .hop-request-button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
  .hop-request-workspace .hop-request-handle{position:absolute;z-index:3;top:50%;width:26px;min-width:26px;height:76px;padding:0;transform:translate(var(--hop-handle-x,0),-50%);border:0;background:transparent;cursor:ew-resize;touch-action:none;opacity:.55;transition:opacity 160ms ease-out}
  .hop-request-handle::before{content:'';position:absolute;inset:-6px -10px}
  .hop-request-handle::after{content:'';position:absolute;top:50%;left:50%;width:3px;height:var(--pull-handle-anchor-height,52px);border-radius:8px;background:linear-gradient(to bottom,transparent,var(--pull-handle-anchor-color,var(--app-text-secondary)) 48%,var(--pull-handle-anchor-color,var(--app-text-secondary)) 52%,transparent);filter:var(--pull-handle-rest-filter);transform:translate(-50%,-50%);pointer-events:none}
  .hop-request-handle:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:-4px;border-radius:12px}
  .hop-request-workspace .hop-request-handle:is(:hover,:focus-visible,:active){opacity:1;background:transparent}
  .hop-request-open{right:0}.hop-request-workspace :is(.hop-request-expand,.hop-request-collapse){left:50%;height:56px}
  .hop-request-workspace .hop-request-expand{--hop-handle-x:-100%;top:calc(50% - 32px)}
  .hop-request-workspace .hop-request-collapse{top:calc(50% + 32px)}.hop-request-return{left:0}
  .hop-request-workspace:not([data-preview=closed]) .hop-request-open,.hop-request-workspace:not([data-preview=split]) :is(.hop-request-expand,.hop-request-collapse),.hop-request-workspace:not([data-preview=full]) .hop-request-return{display:none}
  /* 26px handle + 10px hit slop stay in the 40px gutter, outside selectable text. */
  .hop-request-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:18px 24px 28px 40px;scrollbar-width:thin;user-select:text}
  .hop-request-message{margin:0 0 24px;content-visibility:auto;contain-intrinsic-size:auto 160px}
  .hop-request-message>header{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--app-text-secondary);font-size:11px;letter-spacing:normal;flex-wrap:wrap}
  .hop-request-message>header>span{padding:4px 8px;border-radius:6px;color:var(--app-accent-primary);background:var(--app-accent-soft)}
  .hop-request-message>header>small{font-variant-numeric:tabular-nums}.hop-request-message>header::after{content:'';flex:1;height:1px;background:var(--app-border-subtle)}
  .hop-request-message pre,.hop-request-params pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--app-font-family,inherit);font-size:12px;line-height:1.85;color:var(--app-text-primary)}
  .hop-request-params{padding-top:12px;border-top:1px solid var(--app-border-subtle)}.hop-request-params summary{min-height:44px;display:flex;align-items:center;font-size:12px;color:var(--app-text-secondary);cursor:pointer}
  .hop-request-params pre{font-family:ui-monospace,Consolas,monospace}.hop-request-empty{font-size:12px;color:var(--app-text-secondary);line-height:1.8}
  .hop-request-sources{padding:0 0 16px;margin-bottom:18px;border-bottom:1px solid var(--app-border-default)}
  .hop-request-source-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--app-text-secondary)}
  .hop-request-source-links{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .hop-request-field-link{display:inline-flex;align-items:center;gap:6px;min-height:36px;max-width:100%;padding:6px 10px;border:1px solid var(--app-border-default);border-radius:9px;background:var(--app-surface-subtle);color:var(--app-text-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left;overflow-wrap:anywhere}
  .hop-request-field-link[aria-pressed=true]{border-color:var(--app-accent-primary);color:var(--app-accent-primary)}
  .hop-request-field-editor{display:grid;gap:8px;margin-top:12px}.hop-request-field-editor[hidden]{display:none}
  .hop-request-field-editor textarea{box-sizing:border-box;width:100%;min-height:156px;max-height:38vh;resize:vertical;padding:12px 14px;border:1px solid var(--app-border-default);border-radius:12px;background:var(--app-surface-subtle);color:var(--app-text-primary);font:inherit;font-size:13px;line-height:1.8}
  .hop-request-field-editor textarea:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
  .hop-request-field-editor small,.hop-request-boundary{font-size:11px;color:var(--app-text-secondary);line-height:1.6}
  .hop-request-output[aria-busy=true]{opacity:.6}.hop-request-status:empty{display:none}.hop-request-status{font-size:11px;color:var(--app-text-secondary);padding-bottom:10px}
  .hop-request-edit-status:empty{display:none}.hop-request-edit-status{font-size:12px;color:var(--app-text-secondary);padding-bottom:10px;overflow-wrap:anywhere}
  .prompt-diff-editor,.prompt-diff-surface{display:block;position:relative;min-width:0;max-width:100%}
  .prompt-diff-surface>textarea{display:block;margin:0}
  .prompt-selection-layer{position:absolute;display:block;overflow:hidden;pointer-events:none;border-radius:10px;user-select:none}
  .prompt-selection-mirror{display:block;position:absolute;inset:0 auto auto 0;box-sizing:border-box;color:transparent;white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none}
  ::highlight(agent-prompt-linked-selection){background:rgba(var(--app-accent-rgb,25,154,255),.3)}
  .prompt-diff-layer{position:absolute;display:block;overflow:hidden;pointer-events:none;border-radius:10px;user-select:none}
  .prompt-diff-mirror{display:block;box-sizing:border-box;color:transparent;white-space:pre-wrap;overflow-wrap:break-word;position:absolute;inset:0 auto auto 0}
  .prompt-diff-line{display:block;min-height:1lh}
  .prompt-diff-line.is-added{background:rgba(var(--app-diff-add-rgb,var(--app-success-rgb,46,160,67)),.15);box-shadow:inset 2px 0 rgba(var(--app-diff-add-rgb,var(--app-success-rgb,46,160,67)),.6)}
  .prompt-diff-delete-mark{display:block;position:relative;height:0}.prompt-diff-delete-mark::after{content:'';position:absolute;inset:0 0 auto;border-top:2px solid rgba(var(--app-diff-del-rgb,var(--app-danger-rgb,248,81,73)),.7)}
  .prompt-diff-review{display:block;max-height:260px;overflow:auto;overscroll-behavior:contain;margin-top:8px;padding:10px 12px;border:1px solid var(--app-border-subtle);border-radius:10px;background:var(--app-surface-card);color:var(--app-text-primary);font:12px/1.85 var(--app-font-family,inherit);white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-width:thin}
  .prompt-diff-review[hidden]{display:none}
  .prompt-diff-feedback{display:block;margin-top:6px;color:var(--app-text-secondary);font-size:11px;line-height:1.6;overflow-wrap:anywhere}.prompt-diff-feedback:empty{display:none}
  .prompt-diff-add{color:inherit;text-decoration:none;background:rgba(var(--app-diff-add-rgb,var(--app-success-rgb,46,160,67)),.16);box-shadow:inset 2px 0 rgba(var(--app-diff-add-rgb,var(--app-success-rgb,46,160,67)),.65);box-decoration-break:clone}
  .prompt-diff-del{color:inherit;text-decoration:line-through;background:rgba(var(--app-diff-del-rgb,var(--app-danger-rgb,248,81,73)),.14);box-shadow:inset 2px 0 rgba(var(--app-diff-del-rgb,var(--app-danger-rgb,248,81,73)),.6);opacity:.82;box-decoration-break:clone}
  .prompt-diff-actions{display:inline-flex;align-items:center;vertical-align:middle;gap:2px;margin-left:6px;white-space:nowrap;user-select:none}
  .prompt-diff-actions button{display:inline-flex;align-items:center;justify-content:center;width:32px;min-height:32px;padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer;vertical-align:middle}
  .prompt-diff-actions .prompt-diff-accept{color:var(--app-success-text,#15803d)}.prompt-diff-actions .prompt-diff-reject{color:var(--app-danger-text,#b91c1c)}
  .prompt-diff-actions button:hover{background:var(--app-surface-subtle)}.prompt-diff-actions button:focus-visible{outline:2px solid currentColor;outline-offset:1px}.prompt-diff-actions button:disabled{opacity:.4;cursor:default}
  .prompt-diff-actions svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.prompt-diff-actions .prompt-diff-depth{stroke-width:4.4;opacity:.13}
  .prompt-inline{cursor:text;caret-color:var(--app-accent-primary);white-space:pre-wrap;overflow-wrap:anywhere}.prompt-inline:focus-visible{outline:1.5px dashed var(--app-accent-primary);outline-offset:3px;border-radius:3px}
  @media(pointer:coarse){.prompt-diff-actions button{min-width:44px;min-height:44px}}
  .agent-center-agent-editor:has([data-agent-prompt-rules]),.agent-config-editor .ac-task,.agent-config-editor .ac-block{border:1px solid var(--app-border-default);border-radius:14px;padding:14px;background:var(--app-surface-subtle)}
  .agent-center-agent-editor textarea,.agent-config-editor .ac-task textarea{background:var(--app-surface-card)}
  .agent-center-agent-editor [data-agent-prompt-rules]{min-height:176px}.agent-prompt-context{border-top:1px solid var(--app-border-default);padding-top:14px}
  .agent-prompt-context pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-family:var(--app-font-family,inherit);font-size:12px;line-height:1.8;color:var(--app-text-secondary)}
  .agent-prompt-boundary{display:grid;gap:4px;color:var(--app-text-secondary);font-size:12px;line-height:1.7}
  .agent-prompt-boundary .agent-center-card-actions{margin-top:4px}.agent-prompt-intro .agent-center-icon{width:14px;height:14px}
  .agent-memory-prompt-blocks{display:grid;gap:10px;margin-block:16px}.agent-memory-prompt-block{min-width:0;border:1px solid var(--app-border-default);border-radius:14px;background:var(--app-surface-subtle);padding:0 14px}
  .agent-memory-prompt-block summary,.agent-prompt-context summary{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:48px;cursor:pointer;list-style:none;font-size:13px;color:var(--app-text-primary)}
  .agent-memory-prompt-block summary::before,.agent-prompt-context summary::before{content:'›';color:var(--app-text-secondary);font-size:18px;transform:rotate(0deg)}
  .agent-memory-prompt-block[open]>summary::before,.agent-prompt-context details[open]>summary::before{transform:rotate(90deg)}
  .agent-memory-prompt-block summary span,.agent-prompt-context summary span{font-size:10px;color:var(--app-text-secondary);margin-left:auto}
  .agent-memory-prompt-block .agent-center-agent-field{margin-block:12px;display:grid;gap:8px;font-size:12px;color:var(--app-text-secondary)}
  .agent-memory-prompt-block .is-compact{min-height:78px}.agent-memory-prompt-block summary:focus-visible,.agent-prompt-context summary:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px;border-radius:6px}
  .agent-prompt-context details{border-bottom:1px solid var(--app-border-subtle)}.agent-prompt-context pre{margin:0 0 14px;padding:12px 14px;border-radius:12px;background:var(--app-surface-subtle)}
  .agent-memory-prompt-blocks textarea,.hop-request-source-links select{width:100%;box-sizing:border-box}.hop-request-source-links select{min-height:44px}
  .agent-memory-assembly{margin-top:16px}.agent-memory-assembly .agent-center-agent-field-grid{grid-template-columns:repeat(2,minmax(0,1fr));padding-bottom:14px}
  .agent-memory-assembly .agent-center-agent-field{margin-block:0}
  .agent-memory-save{position:sticky;bottom:0;padding:12px 0 max(12px,env(safe-area-inset-bottom,0px));background:var(--app-surface-card);border-top:1px solid var(--app-border-subtle);z-index:1}
  .hop-request-editor>[data-memory-agent-editor]{padding-bottom:0}
  .agent-center-agent-textarea[data-preview-active]{outline:2px solid var(--app-accent-primary);outline-offset:2px}
  @media(max-width:600px){.agent-center-floating-card.has-wide-request-preview{width:calc(100vw - 24px)}.hop-request-workspace{margin:0 -12px -16px}.hop-request-editor{padding-left:12px}.hop-request-head{padding-inline:14px}.hop-request-scroll{padding:16px 18px max(24px,env(safe-area-inset-bottom)) 40px}.hop-request-field-link{min-height:44px}.hop-request-field-editor textarea{max-height:32dvh}}
  @media(prefers-reduced-motion:reduce){.hop-request-workspace *{transition:none!important;animation:none!important}}
  body[data-reduced-motion=on] .hop-request-workspace *{transition:none!important;animation:none!important}
  `;
  doc.head.append(style);
};
