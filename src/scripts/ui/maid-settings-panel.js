import {
  MAID_SUB_AGENT_SKILLS,
  MAID_REACT_STEP_LIMIT_DEFAULT,
  MAID_REACT_STEP_LIMIT_MIN,
  MAID_REACT_STEP_LIMIT_MAX,
  normalizeMaidReactStepLimit,
} from '../storage/maid-settings-store.js';
import { escapeHtml } from '../utils/name-badges.js';
import { getAgentReasoningControl } from '../agent/agent-generation-settings.js';
import { rankModelCandidates } from '../utils/model-candidates.js';
import { ONBOARDING_TASKS } from './maid-onboarding-flows.js';
import { appendMaidSkillRunDetails } from './maid-skill-ui.js';
const STYLE_ID = 'maid-settings-panel-style';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.maid-settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 26120;
  display: none;
  align-items: center;
  justify-content: center;
  padding: calc(12px + env(safe-area-inset-top, 0px)) 12px calc(12px + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.34);
}
.maid-settings-overlay.is-open {
  display: flex;
}
.maid-settings-panel {
  width: min(780px, 100%);
  height: min(680px, calc(var(--app-visual-height, 100dvh) - 24px));
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.28));
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
  color: var(--app-text-primary, #111827);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
}
.maid-settings-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.22));
  background: color-mix(in srgb, var(--app-surface-card, #fff) 90%, var(--app-surface-subtle, #f8fafc));
}
.maid-settings-mark {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid rgba(37, 99, 235, 0.18);
  border-radius: 12px;
  background: rgba(37, 99, 235, 0.09);
  color: #2563eb;
}
.maid-settings-title {
  font-weight: 800;
  font-size: 15px;
  line-height: 1.2;
}
.maid-settings-icon {
  width: 18px;
  height: 18px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.maid-settings-close,
.maid-settings-action {
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.35));
  border-radius: 8px;
  background: var(--app-surface-card, #fff);
  color: inherit;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 90ms ease;
}
.maid-settings-close {
  width: 32px;
  height: 32px;
  box-sizing: border-box;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.maid-settings-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  overflow-x: auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.22));
  background: var(--app-surface-card, #fff);
}
.maid-settings-tab {
  min-height: 34px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text-secondary, #475569);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
  touch-action: manipulation;
}
.maid-settings-tab.is-active {
  color: var(--app-text-primary, #111827);
  border-color: rgba(37, 99, 235, 0.22);
  background: rgba(37, 99, 235, 0.08);
}
.maid-settings-tab .maid-settings-icon {
  width: 15px;
  height: 15px;
}
.maid-settings-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.maid-settings-section {
  height: 100%;
  display: none;
  padding: 14px;
  box-sizing: border-box;
}
.maid-settings-section.is-active {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}
.maid-settings-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.maid-settings-list-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  background: var(--app-surface-subtle, #f8fafc);
  font-size: 13px;
  line-height: 1.45;
}
.maid-settings-item-main {
  flex: 1;
  min-width: 0;
}
.maid-settings-item-title {
  font-weight: 700;
  word-break: break-word;
}
.maid-settings-item-meta {
  color: var(--app-text-secondary, #6b7280);
  font-size: 12px;
  word-break: break-word;
}
.maid-settings-status-chip {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: rgba(148, 163, 184, 0.16);
}
.maid-settings-status-chip.is-succeeded {
  color: #047857;
  background: rgba(16, 185, 129, 0.14);
}
.maid-settings-status-chip.is-failed {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.12);
}
.maid-settings-status-chip.is-interrupted {
  color: #b45309;
  background: rgba(245, 158, 11, 0.14);
}
.maid-settings-prompt-tabs {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  padding: 4px;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.26));
  border-radius: 10px;
  background: var(--app-surface-subtle, #f8fafc);
  align-self: flex-start;
}
.maid-settings-prompt-tab {
  min-height: 28px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-secondary, #475569);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
  transition: background 120ms ease, border-color 120ms ease, transform 90ms ease;
  touch-action: manipulation;
}
.maid-settings-prompt-tab.is-active {
  color: var(--app-text-primary, #111827);
  border-color: rgba(37, 99, 235, 0.20);
  background: var(--app-surface-card, #fff);
}
.maid-settings-prompt-pane {
  min-height: 0;
  display: none;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 10px;
}
.maid-settings-prompt-pane.is-active {
  display: flex;
}
.maid-settings-label {
  font-size: 12px;
  font-weight: 800;
  color: var(--app-text-secondary, #475569);
}
.maid-settings-field {
  min-height: 0;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 7px;
}
.maid-settings-split {
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1.2fr) minmax(0, 0.8fr);
  gap: 10px;
  flex: 1 1 auto;
}
.maid-settings-textarea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  resize: none;
  box-sizing: border-box;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.35));
  border-radius: 9px;
  padding: 10px 11px;
  background: var(--app-surface-card, #fff);
  color: var(--app-text-primary, #111827);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  outline: none;
}
.maid-settings-textarea[readonly] {
  background: color-mix(in srgb, var(--app-surface-card, #fff) 88%, var(--app-surface-subtle, #f8fafc));
  color: var(--app-text-secondary, #475569);
}
.maid-settings-textarea:focus {
  border-color: rgba(37, 99, 235, 0.42);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12);
}
.maid-settings-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}
.maid-settings-action {
  min-height: 32px;
  box-sizing: border-box;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 800;
  touch-action: manipulation;
}
.maid-settings-tab > *,
.maid-settings-prompt-tab > *,
.maid-settings-action > *,
.maid-settings-close > *,
.maid-settings-icon {
  pointer-events: none;
}
.maid-settings-action.is-primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}
.maid-settings-close:hover,
.maid-settings-action:hover,
.maid-settings-tab:hover,
.maid-settings-prompt-tab:hover {
  border-color: rgba(37, 99, 235, 0.28);
  background: var(--app-surface-subtle, #f8fafc);
}
.maid-settings-action.is-primary:hover {
  background: #1d4ed8;
}
.maid-settings-close:active,
.maid-settings-action:active,
.maid-settings-tab:active,
.maid-settings-prompt-tab:active {
  transform: translateY(1px);
}
.maid-settings-status {
  margin-left: auto;
  color: var(--app-text-secondary, #475569);
  font-size: 12px;
}
.maid-settings-empty {
  color: var(--app-text-muted, #64748b);
  font-size: 13px;
  line-height: 1.5;
}
.maid-settings-api-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  padding: 10px 12px;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.26));
  border-radius: 9px;
  background: var(--app-surface-subtle, #f8fafc);
}
@media (max-width: 640px) {
  .maid-settings-panel {
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 12px;
  }
  .maid-settings-tabs {
    grid-template-columns: repeat(2, max-content);
  }
  .maid-settings-tab {
    padding: 0 9px;
  }
  .maid-settings-prompt-tabs {
    width: 100%;
    overflow-x: auto;
  }
  .maid-settings-prompt-tab {
    flex: 1 0 auto;
  }
  .maid-settings-split {
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .maid-settings-close,
  .maid-settings-action,
  .maid-settings-tab,
  .maid-settings-prompt-tab {
    transition: none;
  }
}

/* 2026-07 女仆设定视觉重构：参考 ARIA Assistant，保留原运行时与表单契约。 */
.maid-settings-overlay {
  display: flex;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  padding: clamp(16px, 3vw, 32px);
  background: rgba(15, 23, 42, 0.25);
  -webkit-backdrop-filter: blur(7px);
  backdrop-filter: blur(7px);
  transition: opacity 240ms ease, visibility 0s linear 320ms;
}
.maid-settings-overlay.is-open {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
  transition-delay: 0s;
}
.maid-settings-panel {
  position: relative;
  width: min(920px, 94vw);
  height: min(780px, 88vh);
  max-height: calc(var(--app-visual-height, 100dvh) - 32px);
  isolation: isolate;
  border: 1px solid color-mix(in srgb, var(--app-border-default) 72%, transparent);
  border-radius: 28px;
  background: var(--app-surface-card, #fff);
  box-shadow: 0 40px 120px -24px rgba(15, 23, 42, 0.45), 0 2px 8px rgba(15, 23, 42, 0.06);
  opacity: 0;
  transform: translate3d(0, 24px, 0) scale(0.94);
  transition: transform 380ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
}
.maid-settings-overlay.is-open .maid-settings-panel {
  opacity: 1;
  transform: translate3d(0, 0, 0) scale(1);
}
.maid-settings-panel::before {
  content: '';
  position: absolute;
  z-index: 3;
  top: 0;
  left: 32px;
  right: 32px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--app-text-inverse, #fff) 76%, transparent), transparent);
}
.maid-settings-header {
  min-height: 86px;
  gap: 14px;
  padding: 18px 28px 16px;
  border-bottom: 0;
  background: var(--app-surface-card, #fff);
}
.maid-settings-mark {
  width: 44px;
  height: 44px;
  border: 1px solid rgba(var(--app-accent-rgb, 37, 99, 235), 0.38);
  border-radius: 16px;
  background: linear-gradient(135deg, var(--app-accent-primary, #3b82f6), var(--app-accent-strong, #4f46e5));
  color: var(--app-text-inverse, #fff);
  box-shadow: 0 12px 26px -10px rgba(var(--app-accent-rgb, 37, 99, 235), 0.7);
}
.maid-settings-mark .maid-settings-icon {
  width: 22px;
  height: 22px;
  stroke-width: 2.05;
}
.maid-settings-header-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.maid-settings-title {
  color: var(--app-text-primary, #111827);
  font-size: 17px;
  font-weight: 850;
  line-height: 1.2;
  letter-spacing: 0.025em;
}
.maid-settings-header-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--app-text-muted, #94a3b8);
  font-size: 11px;
  line-height: 1.3;
}
.maid-settings-assistant-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
  letter-spacing: 0.08em;
}
.maid-settings-header-separator {
  color: color-mix(in srgb, var(--app-text-muted) 36%, transparent);
}
.maid-settings-runtime-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--app-success-text, #059669);
  white-space: nowrap;
}
.maid-settings-runtime-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent);
}
.maid-settings-close {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--app-text-muted, #94a3b8);
  transition: color 180ms ease, background 180ms ease, border-color 180ms ease, transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.maid-settings-close .maid-settings-icon {
  width: 18px;
  height: 18px;
}
.maid-settings-tabs {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  margin: 0 28px 16px;
  padding: 4px;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--app-border-subtle) 54%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-surface-subtle) 82%, var(--app-surface-card));
}
.maid-settings-tab {
  position: relative;
  min-height: 44px;
  gap: 8px;
  padding: 0 12px;
  border-radius: 12px;
  color: var(--app-text-muted, #94a3b8);
  font-size: 13.5px;
  font-weight: 700;
  transition: color 180ms ease, background 220ms ease, border-color 220ms ease, box-shadow 220ms ease, transform 120ms ease;
}
.maid-settings-tab.is-active {
  color: var(--app-text-primary, #111827);
  border-color: color-mix(in srgb, var(--app-border-default) 42%, transparent);
  background: var(--app-surface-card, #fff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.07), 0 6px 16px -6px rgba(15, 23, 42, 0.12);
}
.maid-settings-tab .maid-settings-icon {
  width: 16px;
  height: 16px;
  color: var(--app-text-muted, #94a3b8);
  transition: color 180ms ease, transform 220ms ease;
}
.maid-settings-tab.is-active .maid-settings-icon {
  color: var(--app-accent-primary, #2563eb);
}
.maid-settings-body {
  border-top: 1px solid var(--app-border-subtle, rgba(148, 163, 184, 0.18));
  background: var(--app-surface-card, #fff);
}
.maid-settings-section {
  padding: 24px 28px 28px;
}
.maid-settings-section.is-active {
  gap: 18px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--app-text-muted) 38%, transparent) transparent;
  animation: maid-settings-section-in 200ms ease-out both;
  overscroll-behavior: contain;
}
.maid-settings-section.is-active::-webkit-scrollbar,
.maid-settings-list::-webkit-scrollbar,
.maid-settings-prompt-tabs::-webkit-scrollbar,
.maid-subagent-model-menu::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.maid-settings-section.is-active::-webkit-scrollbar-thumb,
.maid-settings-list::-webkit-scrollbar-thumb,
.maid-settings-prompt-tabs::-webkit-scrollbar-thumb,
.maid-subagent-model-menu::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted) 38%, transparent);
}
.maid-settings-section-caption {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin: 0 0 2px;
  color: var(--app-text-muted, #94a3b8);
  font-size: 12px;
  font-weight: 750;
}
.maid-settings-section-caption small {
  color: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.24em;
  text-transform: uppercase;
}
.maid-settings-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.maid-settings-section-title-row {
  display: flex;
  align-items: center;
  gap: 9px;
}
.maid-settings-section-title {
  color: var(--app-text-primary, #111827);
  font-size: 15px;
  font-weight: 800;
}
.maid-settings-count-badge {
  min-width: 22px;
  padding: 2px 7px;
  box-sizing: border-box;
  border: 1px solid rgba(var(--app-accent-rgb, 37, 99, 235), 0.14);
  border-radius: 999px;
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.08);
  color: var(--app-accent-primary, #2563eb);
  font-size: 11px;
  font-weight: 750;
  text-align: center;
}
.maid-settings-list {
  gap: 12px;
  padding: 1px;
}
.maid-settings-task-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px 16px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 14%, var(--app-border-default));
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 4%, var(--app-surface-card));
}
.maid-settings-task-summary-copy {
  color: var(--app-text-primary, #111827);
  font-size: 13px;
  font-weight: 800;
}
.maid-settings-task-progress-text {
  color: var(--app-accent-primary, #2563eb);
  font: 800 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.maid-settings-task-progress-track {
  grid-column: 1 / -1;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 11%, var(--app-surface-subtle));
}
.maid-settings-task-progress-bar {
  width: var(--maid-task-progress, 0%);
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--app-accent-primary, #2563eb), var(--app-accent-secondary, #7c3aed));
  box-shadow: 0 0 12px -4px color-mix(in srgb, var(--app-accent-primary, #2563eb) 68%, transparent);
  transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
.maid-settings-task-completion {
  display: none;
  align-items: center;
  gap: 6px;
  margin-top: -2px;
  color: var(--app-warning-text, #b45309);
  font-size: 11.5px;
  font-weight: 750;
}
.maid-settings-task-completion[aria-hidden='false'] {
  display: flex;
  animation: maid-settings-task-complete-in 320ms cubic-bezier(.22,1,.36,1) backwards;
}
.maid-settings-task-completion .maid-settings-icon {
  width: 15px;
  height: 15px;
}
.maid-settings-task-list {
  display: grid;
  gap: 8px;
}
.maid-settings-task-item {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 68px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--app-border-default) 72%, transparent);
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
  box-shadow: 0 2px 8px -7px rgba(15, 23, 42, 0.28);
  transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms cubic-bezier(.22,1,.36,1), background 180ms ease;
}
.maid-settings-task-item.is-entering {
  animation: maid-settings-task-item-in 320ms cubic-bezier(.22,1,.36,1) backwards;
  animation-delay: calc(var(--maid-task-index, 0) * 42ms);
}
.maid-settings-task-item.is-done {
  border-color: color-mix(in srgb, var(--app-success-text, #059669) 22%, var(--app-border-default));
  background: color-mix(in srgb, var(--app-success-text, #059669) 5%, var(--app-surface-card));
}
.maid-settings-task-item.is-locked {
  opacity: 0.68;
}
.maid-settings-task-icon {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 9%, var(--app-surface-card));
  color: var(--app-accent-primary, #2563eb);
  transition: color 180ms ease, background 180ms ease, transform 180ms cubic-bezier(.22,1,.36,1);
}
.maid-settings-task-item.is-done .maid-settings-task-icon {
  background: color-mix(in srgb, var(--app-success-text, #059669) 12%, var(--app-surface-card));
  color: var(--app-success-text, #059669);
}
.maid-settings-task-icon .maid-settings-icon {
  width: 19px;
  height: 19px;
}
.maid-settings-task-main {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.maid-settings-task-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
}
.maid-settings-task-title {
  color: var(--app-text-primary, #111827);
  font-size: 13.5px;
  font-weight: 800;
}
.maid-settings-task-reward {
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted, #64748b) 8%, var(--app-surface-card));
  color: var(--app-text-muted, #64748b);
  font-size: 10.5px;
  font-weight: 700;
}
.maid-settings-task-item.is-done .maid-settings-task-reward {
  background: color-mix(in srgb, var(--app-warning-text, #b45309) 10%, var(--app-surface-card));
  color: var(--app-warning-text, #b45309);
}
.maid-settings-task-description {
  color: var(--app-text-secondary, #64748b);
  font-size: 12px;
  line-height: 1.45;
}
.maid-settings-task-action {
  min-width: 76px;
  min-height: 40px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--app-accent-primary, #2563eb), var(--app-accent-secondary, #7c3aed));
  color: var(--app-text-inverse, #fff);
  box-shadow: 0 10px 18px -13px color-mix(in srgb, var(--app-accent-primary, #2563eb) 72%, transparent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  touch-action: manipulation;
  transition: transform 180ms cubic-bezier(.22,1,.36,1), box-shadow 180ms ease, opacity 180ms ease;
}
.maid-settings-task-action .maid-settings-icon {
  width: 15px;
  height: 15px;
}
.maid-settings-task-item.is-done .maid-settings-task-action {
  border: 1px solid color-mix(in srgb, var(--app-success-text, #059669) 20%, var(--app-border-default));
  background: color-mix(in srgb, var(--app-success-text, #059669) 7%, var(--app-surface-card));
  color: var(--app-success-text, #059669);
  box-shadow: none;
}
.maid-settings-list-item {
  position: relative;
  gap: 14px;
  padding: 15px 16px;
  border-color: color-mix(in srgb, var(--app-border-default) 72%, transparent);
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.025);
  font-size: 13px;
  line-height: 1.55;
  transition: transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease;
}
.maid-settings-list-item.is-run {
  align-items: flex-start;
}
.maid-settings-list-item.is-rule {
  align-items: center;
}
.maid-settings-item-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.maid-settings-item-heading {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.maid-settings-item-title {
  min-width: 0;
  flex: 1;
  color: var(--app-text-primary, #111827);
  font-size: 14px;
  font-weight: 800;
  line-height: 1.45;
}
.maid-settings-item-meta {
  color: var(--app-text-secondary, #64748b);
  font-size: 12.5px;
  line-height: 1.65;
}
.maid-settings-item-time {
  flex: 0 0 auto;
  color: var(--app-text-muted, #94a3b8);
  font: 10.5px/1.8 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
}
.maid-settings-item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.maid-settings-item-tag {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--app-surface-subtle, #f8fafc);
  color: var(--app-text-secondary, #64748b);
  font-size: 11px;
  font-weight: 650;
}
.maid-settings-run-icon,
.maid-settings-rule-icon {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 36px;
  border: 1px solid currentColor;
  border-radius: 50%;
}
.maid-settings-run-icon .maid-settings-icon,
.maid-settings-rule-icon .maid-settings-icon {
  width: 18px;
  height: 18px;
}
.maid-settings-run-icon.is-succeeded {
  color: var(--app-success-text, #059669);
  background: color-mix(in srgb, var(--app-success-text, #059669) 9%, var(--app-surface-card));
  border-color: color-mix(in srgb, var(--app-success-text, #059669) 18%, transparent);
}
.maid-settings-run-icon.is-failed {
  color: var(--app-danger-text, #dc2626);
  background: color-mix(in srgb, var(--app-danger-text, #dc2626) 9%, var(--app-surface-card));
  border-color: color-mix(in srgb, var(--app-danger-text, #dc2626) 18%, transparent);
}
.maid-settings-run-icon.is-interrupted {
  color: var(--app-warning-text, #b45309);
  background: color-mix(in srgb, var(--app-warning-text, #b45309) 9%, var(--app-surface-card));
  border-color: color-mix(in srgb, var(--app-warning-text, #b45309) 18%, transparent);
}
.maid-settings-rule-icon {
  border-radius: 12px;
  color: var(--app-accent-primary, #2563eb);
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.08);
  border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.14);
}
.maid-settings-status-chip {
  min-height: 20px;
  box-sizing: border-box;
  padding: 1px 7px;
  border: 1px solid currentColor;
  font-size: 11px;
  font-weight: 750;
}
.maid-settings-status-chip.is-succeeded {
  color: var(--app-success-text, #047857);
  background: color-mix(in srgb, var(--app-success-text, #047857) 8%, transparent);
  border-color: color-mix(in srgb, var(--app-success-text, #047857) 16%, transparent);
}
.maid-settings-status-chip.is-failed {
  color: var(--app-danger-text, #b91c1c);
  background: color-mix(in srgb, var(--app-danger-text, #b91c1c) 8%, transparent);
  border-color: color-mix(in srgb, var(--app-danger-text, #b91c1c) 16%, transparent);
}
.maid-settings-status-chip.is-interrupted {
  color: var(--app-warning-text, #b45309);
  background: color-mix(in srgb, var(--app-warning-text, #b45309) 8%, transparent);
  border-color: color-mix(in srgb, var(--app-warning-text, #b45309) 16%, transparent);
}
.maid-settings-prompt-tabs {
  max-width: 100%;
  gap: 4px;
  overflow-x: auto;
  padding: 4px;
  border-color: color-mix(in srgb, var(--app-border-subtle) 54%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-surface-subtle) 82%, var(--app-surface-card));
  scrollbar-width: none;
}
.maid-settings-prompt-tabs::-webkit-scrollbar {
  display: none;
}
.maid-settings-prompt-tab {
  min-height: 32px;
  padding: 0 14px;
  border-radius: 11px;
  color: var(--app-text-muted, #94a3b8);
  font-size: 13px;
  font-weight: 650;
  transition: color 180ms ease, background 220ms ease, border-color 220ms ease, box-shadow 220ms ease, transform 120ms ease;
}
.maid-settings-prompt-tab.is-active {
  border-color: color-mix(in srgb, var(--app-border-default) 42%, transparent);
  background: var(--app-surface-card, #fff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.07), 0 4px 12px -4px rgba(15, 23, 42, 0.1);
}
.maid-settings-prompt-pane {
  gap: 14px;
}
.maid-settings-prompt-pane.is-active {
  animation: maid-settings-pane-in 180ms ease-out both;
}
.maid-settings-field {
  gap: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border-default) 76%, transparent);
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
}
.maid-settings-field-header {
  min-height: 45px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 18px;
  border-bottom: 1px solid var(--app-border-subtle, rgba(148, 163, 184, 0.18));
}
.maid-settings-label {
  color: var(--app-text-secondary, #64748b);
  font-size: 13px;
  font-weight: 750;
}
.maid-settings-field > .maid-settings-label {
  min-height: 44px;
  display: flex;
  align-items: center;
  padding: 0 18px;
  border-bottom: 1px solid var(--app-border-subtle, rgba(148, 163, 184, 0.18));
}
.maid-settings-char-count {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--app-surface-subtle, #f8fafc);
  color: var(--app-text-muted, #94a3b8);
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.maid-settings-split {
  gap: 14px;
}
.maid-settings-textarea {
  border: 0;
  border-radius: 0;
  padding: 18px 20px;
  background: color-mix(in srgb, var(--app-surface-subtle) 42%, var(--app-surface-card));
  color: var(--app-text-secondary, #475569);
  font: 13.5px/1.8 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  caret-color: var(--app-accent-primary, #2563eb);
}
.maid-settings-textarea[readonly] {
  background: color-mix(in srgb, var(--app-surface-subtle) 48%, var(--app-surface-card));
}
.maid-settings-textarea:focus {
  border-color: transparent;
  box-shadow: inset 0 0 0 2px rgba(var(--app-accent-rgb, 37, 99, 235), 0.16);
}
.maid-settings-footer {
  min-height: 38px;
  gap: 10px;
}
.maid-settings-action {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 15px;
  border-radius: 11px;
  color: var(--app-text-secondary, #475569);
  font-size: 13px;
  font-weight: 700;
  transition: color 180ms ease, background 180ms ease, border-color 180ms ease, transform 120ms ease, box-shadow 180ms ease;
}
.maid-settings-action .maid-settings-icon {
  width: 15px;
  height: 15px;
}
.maid-settings-action.is-primary {
  border-color: var(--app-accent-primary, #2563eb);
  background: var(--app-accent-primary, #2563eb);
  color: var(--app-text-inverse, #fff);
  box-shadow: 0 10px 24px -10px rgba(var(--app-accent-rgb, 37, 99, 235), 0.7);
}
.maid-settings-status {
  min-width: 0;
  margin: 0 auto 0 0;
  color: var(--app-success-text, #059669);
  font-size: 12px;
}
.maid-settings-empty {
  padding: 16px;
  border: 1px dashed var(--app-border-default, rgba(148, 163, 184, 0.34));
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-surface-subtle) 54%, transparent);
  text-align: center;
}
.maid-settings-empty-state {
  min-height: 250px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 24px;
  box-sizing: border-box;
  border: 2px dashed color-mix(in srgb, var(--app-border-default) 76%, transparent);
  border-radius: 24px;
  background: color-mix(in srgb, var(--app-surface-subtle) 44%, transparent);
  text-align: center;
}
.maid-settings-empty-state-icon {
  width: 56px;
  height: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.28));
  border-radius: 18px;
  background: var(--app-surface-card, #fff);
  color: var(--app-text-muted, #94a3b8);
  box-shadow: 0 8px 20px -8px rgba(15, 23, 42, 0.15);
}
.maid-settings-empty-state-icon .maid-settings-icon {
  width: 28px;
  height: 28px;
  stroke-width: 1.6;
}
.maid-settings-empty-state strong {
  margin-top: 16px;
  color: var(--app-text-secondary, #475569);
  font-size: 14px;
}
.maid-settings-empty-state p {
  max-width: 390px;
  margin: 7px 0 0;
  color: var(--app-text-muted, #94a3b8);
  font-size: 13px;
  line-height: 1.65;
}
.maid-memory-overview {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border-default) 76%, transparent);
  border-radius: 18px;
  background: var(--app-surface-card, #fff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.035), 0 14px 30px -24px rgba(15, 23, 42, 0.24);
}
.maid-memory-overview-head {
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--app-border-subtle, rgba(148, 163, 184, 0.18));
}
.maid-memory-overview-mark {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(var(--app-accent-rgb, 37, 99, 235), 0.2);
  border-radius: 13px;
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.09);
  color: var(--app-accent-primary, #2563eb);
}
.maid-memory-overview-mark .maid-settings-icon {
  width: 18px;
  height: 18px;
}
.maid-memory-overview-copy {
  min-width: 0;
  flex: 1;
}
.maid-memory-overview-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.maid-memory-overview-title {
  color: var(--app-text-primary, #0f172a);
  font-size: 14px;
  font-weight: 800;
  letter-spacing: -0.01em;
}
.maid-memory-count {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border: 1px solid rgba(var(--app-accent-rgb, 37, 99, 235), 0.14);
  border-radius: 7px;
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.07);
  color: var(--app-accent-strong, #1d4ed8);
  font: 650 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.maid-memory-overview-desc {
  margin-top: 3px;
  color: var(--app-text-muted, #94a3b8);
  font-size: 11.5px;
  line-height: 1.55;
}
.maid-memory-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  max-height: min(430px, 52vh);
  overflow-y: auto;
  padding: 12px;
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 116, 139, 0.28) transparent;
}
.maid-memory-list::-webkit-scrollbar {
  width: 8px;
}
.maid-memory-list::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: rgba(100, 116, 139, 0.28);
  background-clip: content-box;
}
.maid-memory-card {
  position: relative;
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 14px;
  overflow: hidden;
  padding: 13px 13px 12px 16px;
  border: 1px solid color-mix(in srgb, var(--app-border-default) 72%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-surface-subtle) 36%, var(--app-surface-card));
  transition: border-color 180ms ease, background 180ms ease, box-shadow 180ms ease, transform 180ms ease;
  animation: maid-memory-card-in 260ms cubic-bezier(.22,1,.36,1) both;
  animation-delay: calc(var(--maid-memory-index, 0) * 34ms);
}
.maid-memory-card::before {
  content: '';
  position: absolute;
  inset: 11px auto 11px 0;
  width: 3px;
  border-radius: 0 999px 999px 0;
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.78);
}
.maid-memory-card[data-kind='decision']::before {
  background: rgba(var(--app-warning-rgb, 245, 158, 11), 0.85);
}
.maid-memory-card[data-kind='resource_state']::before {
  background: rgba(var(--app-success-rgb, 16, 185, 129), 0.82);
}
.maid-memory-card[data-kind='task_state']::before {
  background: rgba(var(--app-task-rgb, 139, 92, 246), 0.82);
}
.maid-memory-card[data-status='stale'],
.maid-memory-card[data-status='archived'] {
  opacity: 0.72;
}
.maid-memory-card-main {
  min-width: 0;
}
.maid-memory-card-heading,
.maid-memory-card-meta,
.maid-memory-source-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.maid-memory-kind,
.maid-memory-confidence,
.maid-memory-status,
.maid-memory-tag,
.maid-memory-source {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  box-sizing: border-box;
  padding: 2px 7px;
  border-radius: 7px;
  font-size: 10.5px;
  font-weight: 650;
  line-height: 1.35;
}
.maid-memory-kind {
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.08);
  color: var(--app-accent-strong, #1d4ed8);
}
.maid-memory-confidence {
  background: color-mix(in srgb, var(--app-surface-subtle) 84%, transparent);
  color: var(--app-text-secondary, #64748b);
}
.maid-memory-status {
  background: rgba(var(--app-success-rgb, 16, 185, 129), 0.08);
  color: var(--app-success-text, #047857);
}
.maid-memory-key {
  min-width: 0;
  overflow: hidden;
  padding: 2px 6px;
  border: 1px solid color-mix(in srgb, var(--app-border-subtle) 80%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-surface-subtle) 72%, transparent);
  color: var(--app-text-muted, #94a3b8);
  font: 10.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.maid-memory-content {
  margin-top: 8px;
  color: var(--app-text-secondary, #334155);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.maid-memory-card-meta {
  margin-top: 8px;
}
.maid-memory-tag {
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.055);
  color: var(--app-text-secondary, #64748b);
}
.maid-memory-time {
  color: var(--app-text-muted, #94a3b8);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.maid-memory-source-list {
  grid-column: 1 / -1;
  padding-top: 9px;
  border-top: 1px solid color-mix(in srgb, var(--app-border-subtle) 76%, transparent);
}
.maid-memory-source-label {
  color: var(--app-text-muted, #94a3b8);
  font-size: 10.5px;
  font-weight: 700;
}
.maid-memory-source {
  max-width: 190px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-surface-subtle) 78%, transparent);
  color: var(--app-text-muted, #64748b);
  font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.maid-memory-actions {
  align-self: start;
  display: flex;
  gap: 7px;
}
.maid-memory-status-action,
.maid-memory-delete {
  align-self: start;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 9px;
  background: var(--app-surface-card, #fff);
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, transform 120ms ease;
}
.maid-memory-status-action {
  border: 1px solid rgba(var(--app-accent-rgb, 37, 99, 235), 0.2);
  color: var(--app-accent-strong, #1d4ed8);
}
.maid-memory-delete {
  border: 1px solid rgba(var(--app-danger-rgb, 239, 68, 68), 0.18);
  color: var(--app-danger-text, #dc2626);
}
.maid-memory-status-action:active,
.maid-memory-delete:active {
  transform: scale(.96);
}
.maid-memory-clear-all {
  flex: 0 0 auto;
  margin-left: auto;
  align-self: center;
}
.maid-memory-edit-input {
  width: 100%;
  min-height: 88px;
  margin-top: 8px;
  box-sizing: border-box;
  resize: vertical;
}

/* API 首页卡片与二级编辑页。运行时样式晚于 qq-legacy，统一覆盖旧紧凑表单。 */
.maid-api-nav {
  gap: 14px;
}
.maid-api-nav-item {
  min-height: 78px;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  grid-template-areas: 'icon copy chevron';
  gap: 14px;
  padding: 15px 16px;
  border-color: color-mix(in srgb, var(--app-border-default) 72%, transparent);
  border-radius: 17px;
  background: var(--app-surface-card, #fff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.025);
  transition: transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease;
}
.maid-api-nav-icon {
  grid-area: icon;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  color: var(--app-accent-primary, #2563eb);
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.08);
}
.maid-api-nav-icon.is-subagent {
  color: var(--app-accent-strong, #7c3aed);
  background: color-mix(in srgb, var(--app-accent-soft) 68%, transparent);
}
.maid-api-nav-icon .maid-settings-icon {
  width: 20px;
  height: 20px;
}
.maid-api-nav-copy {
  grid-area: copy;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.maid-api-nav-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.maid-api-nav-title {
  color: var(--app-text-primary, #111827);
  font-size: 14px;
  font-weight: 800;
}
.maid-api-nav-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 20px;
  padding: 1px 8px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--app-success-text, #059669) 14%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-success-text, #059669) 8%, transparent);
  color: var(--app-success-text, #059669);
  font-size: 11px;
  font-weight: 700;
}
.maid-api-nav-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.maid-api-nav-badge.is-muted {
  border-color: var(--app-border-subtle, rgba(148, 163, 184, 0.2));
  background: var(--app-surface-subtle, #f8fafc);
  color: var(--app-text-muted, #94a3b8);
}
.maid-api-nav-summary {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--app-text-muted, #94a3b8);
  font-size: 12px;
}
.maid-api-nav-summary > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.maid-api-nav-summary code {
  max-width: min(360px, 60vw);
  overflow: hidden;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--app-surface-subtle, #f8fafc);
  color: var(--app-text-secondary, #64748b);
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.maid-api-nav-chevron {
  grid-area: chevron;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-muted, #94a3b8);
  transition: color 180ms ease, transform 220ms ease;
}
.maid-api-nav-chevron .maid-settings-icon {
  width: 16px;
  height: 16px;
}
.maid-api-back {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 10px;
  transition: color 180ms ease, background 180ms ease, transform 120ms ease;
}
.maid-api-back .maid-settings-icon {
  width: 14px;
  height: 14px;
  transform: rotate(180deg);
}
.maid-api-group {
  gap: 12px;
  padding: 18px;
  border-color: color-mix(in srgb, var(--app-border-default) 74%, transparent);
  border-radius: 18px;
  background: var(--app-surface-card, #fff);
}
.maid-api-group-title {
  font-size: 15px;
  font-weight: 800;
}
.maid-api-group-desc {
  margin-top: -5px;
  font-size: 12px;
  line-height: 1.65;
}
.maid-api-field {
  gap: 6px;
}
.maid-api-field[hidden] {
  display: none;
}
.maid-api-field-label {
  font-size: 11.5px;
  font-weight: 700;
}
.maid-api-form-title {
  padding-top: 14px;
  font-size: 13px;
  border-top-color: var(--app-border-subtle, rgba(148, 163, 184, 0.2));
}
.maid-subagent-select,
.maid-subagent-input {
  min-height: 38px;
  padding: 8px 11px;
  border-color: var(--app-border-default, rgba(148, 163, 184, 0.28));
  border-radius: 10px;
  font-size: 13px;
  outline: none;
  transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
}
.maid-subagent-select:focus,
.maid-subagent-input:focus {
  border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.46);
  box-shadow: 0 0 0 3px rgba(var(--app-accent-rgb, 37, 99, 235), 0.1);
}
.maid-subagent-list {
  gap: 8px;
}
.maid-subagent-item {
  gap: 9px;
  padding: 10px 11px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-surface-subtle) 48%, var(--app-surface-card));
}
.maid-subagent-form {
  gap: 9px;
}
.maid-subagent-model-menu {
  border-radius: 10px;
  padding: 5px;
  box-shadow: 0 14px 34px -18px rgba(15, 23, 42, 0.3);
}
.maid-subagent-model-option {
  min-height: 32px;
  border-radius: 8px;
  font-size: 12px;
}
.maid-subagent-skill {
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--app-border-subtle, rgba(148, 163, 184, 0.2));
  border-radius: 9px;
  background: var(--app-surface-subtle, #f8fafc);
}

@media (hover: hover) and (pointer: fine) {
  .maid-settings-close:hover {
    border-color: var(--app-border-default, rgba(148, 163, 184, 0.34));
    background: var(--app-surface-subtle, #f8fafc);
    color: var(--app-text-primary, #111827);
    transform: rotate(90deg);
  }
  .maid-settings-tab:not(.is-active):hover,
  .maid-settings-prompt-tab:not(.is-active):hover {
    color: var(--app-text-secondary, #475569);
    background: transparent;
  }
  .maid-settings-tab:hover .maid-settings-icon {
    transform: translateY(-1px);
  }
  .maid-settings-list-item:hover,
  .maid-api-nav-item:hover {
    border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.24);
    background: var(--app-surface-card, #fff);
    box-shadow: 0 16px 38px -24px rgba(var(--app-accent-rgb, 37, 99, 235), 0.34);
    transform: translateY(-2px);
  }
  .maid-settings-task-item:not(.is-locked):hover {
    border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 26%, var(--app-border-default));
    box-shadow: 0 14px 30px -24px color-mix(in srgb, var(--app-accent-primary, #2563eb) 58%, transparent);
    transform: translateY(-1px);
  }
  .maid-settings-task-item:not(.is-locked):hover .maid-settings-task-icon {
    transform: translateY(-1px) scale(1.03);
  }
  .maid-settings-task-action:hover {
    box-shadow: 0 13px 24px -13px color-mix(in srgb, var(--app-accent-primary, #2563eb) 82%, transparent);
    transform: scale(1.035);
  }
  .maid-api-nav-item:hover .maid-api-nav-chevron {
    color: var(--app-accent-primary, #2563eb);
    transform: translateX(3px);
  }
  .maid-settings-action:hover {
    border-color: color-mix(in srgb, var(--app-border-default) 86%, var(--app-accent-primary));
    background: var(--app-surface-subtle, #f8fafc);
  }
  .maid-settings-action.is-primary:hover {
    border-color: var(--app-accent-strong, #1d4ed8);
    background: var(--app-accent-strong, #1d4ed8);
  }
  .maid-api-back:hover {
    background: var(--app-surface-subtle, #f8fafc);
  }
}

@keyframes maid-settings-section-in {
  from { opacity: 0; transform: translate3d(0, 10px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes maid-settings-pane-in {
  from { opacity: 0; transform: translate3d(0, 8px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes maid-settings-task-item-in {
  from { opacity: 0; transform: translate3d(0, 7px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes maid-settings-task-complete-in {
  from { opacity: 0; transform: translate3d(0, 5px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes maid-memory-card-in {
  from { opacity: 0; transform: translate3d(0, 7px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}

.maid-settings-task-action:active { transform: scale(.96); }

@media (hover: hover) {
  .maid-memory-card:hover {
    border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.22);
    background: color-mix(in srgb, var(--app-surface-subtle) 18%, var(--app-surface-card));
    box-shadow: 0 10px 24px -20px rgba(15, 23, 42, 0.42);
    transform: translateY(-1px);
  }
  .maid-memory-delete:hover {
    border-color: rgba(var(--app-danger-rgb, 239, 68, 68), 0.3);
    background: rgba(var(--app-danger-rgb, 239, 68, 68), 0.06);
  }
  .maid-memory-status-action:hover {
    border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.32);
    background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.06);
  }
}

@media (max-width: 640px) {
  .maid-settings-overlay {
    padding: 0;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .maid-settings-panel {
    width: 100%;
    height: var(--app-visual-height, 100dvh);
    max-height: var(--app-visual-height, 100dvh);
    border: 0;
    border-radius: 0;
    box-shadow: none;
    transform: translate3d(0, 18px, 0) scale(0.99);
  }
  .maid-settings-header {
    min-height: 72px;
    padding: calc(10px + env(safe-area-inset-top, 0px)) 16px 10px;
  }
  .maid-settings-mark {
    width: 40px;
    height: 40px;
    border-radius: 14px;
  }
  .maid-settings-title {
    font-size: 16px;
  }
  .maid-settings-header-meta {
    font-size: 10.5px;
  }
  .maid-settings-close {
    width: 38px;
    height: 38px;
  }
  .maid-settings-tabs {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 3px;
    margin: 0 12px 12px;
    padding: 3px;
    overflow: visible;
    border-radius: 14px;
  }
  .maid-settings-tab {
    min-width: 0;
    min-height: 40px;
    gap: 5px;
    padding: 0 5px;
    border-radius: 11px;
    font-size: 11.5px;
  }
  .maid-settings-task-item {
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    padding: 11px 12px;
  }
  .maid-settings-task-icon {
    width: 34px;
    height: 34px;
  }
  .maid-settings-task-action {
    grid-column: 1 / -1;
    width: 100%;
  }
  .maid-settings-tab .maid-settings-icon {
    width: 14px;
    height: 14px;
  }
  .maid-settings-section {
    padding: 18px 14px calc(22px + env(safe-area-inset-bottom, 0px));
  }
  .maid-settings-section.is-active {
    gap: 14px;
  }
  .maid-settings-prompt-tabs {
    width: 100%;
    align-self: stretch;
    box-sizing: border-box;
  }
  .maid-settings-prompt-tab {
    flex: 0 0 auto;
    min-height: 31px;
    padding: 0 12px;
    font-size: 12px;
  }
  .maid-settings-split {
    grid-template-rows: minmax(180px, 1fr) minmax(150px, 0.8fr);
  }
  .maid-settings-textarea {
    min-height: 180px;
    padding: 15px 16px;
    font-size: 13px;
    line-height: 1.75;
  }
  .maid-settings-footer {
    flex-wrap: wrap;
  }
  .maid-settings-status {
    flex: 1 0 100%;
    order: -1;
  }
  .maid-settings-action {
    min-height: 38px;
  }
  .maid-api-nav-item {
    grid-template-columns: 40px minmax(0, 1fr) auto;
    gap: 11px;
    padding: 13px;
  }
  .maid-api-nav-icon {
    width: 40px;
    height: 40px;
  }
  .maid-api-nav-summary code {
    max-width: 42vw;
  }
  .maid-api-group {
    padding: 15px;
  }
  .maid-subagent-item {
    flex-wrap: wrap;
  }
  .maid-subagent-item-main {
    flex-basis: calc(100% - 8px);
  }
  .maid-settings-list-item {
    gap: 11px;
    padding: 13px;
  }
  .maid-settings-item-heading {
    flex-wrap: wrap;
  }
  .maid-settings-item-time {
    flex-basis: 100%;
    order: 3;
  }
  .maid-settings-run-icon,
  .maid-settings-rule-icon {
    width: 34px;
    height: 34px;
    flex-basis: 34px;
  }
  .maid-settings-empty-state {
    min-height: 300px;
    padding: 32px 18px;
  }
  .maid-memory-overview-head {
    padding: 12px 13px;
  }
  .maid-memory-list {
    max-height: none;
    padding: 9px;
  }
  .maid-memory-card {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px 11px 11px 14px;
  }
  .maid-memory-actions,
  .maid-memory-status-action,
  .maid-memory-delete {
    width: 100%;
  }
  .maid-memory-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .maid-memory-clear-all {
    width: auto;
  }
}

@media (max-width: 380px) {
  .maid-settings-tab {
    flex-direction: column;
    gap: 2px;
    min-height: 44px;
    font-size: 10.5px;
  }
  .maid-settings-header-separator {
    display: none;
  }
  .maid-api-nav-heading {
    gap: 5px;
  }
  .maid-api-nav-badge {
    padding-inline: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .maid-settings-overlay,
  .maid-settings-panel,
  .maid-settings-overlay *,
  .maid-settings-overlay *::before,
  .maid-settings-overlay *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
body[data-reduced-motion='on'] .maid-settings-overlay,
body[data-reduced-motion='on'] .maid-settings-panel,
body[data-reduced-motion='on'] .maid-settings-overlay *,
body[data-reduced-motion='on'] .maid-settings-overlay *::before,
body[data-reduced-motion='on'] .maid-settings-overlay *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}
`;
  documentRef.head.appendChild(style);
};

const createButton = (documentRef, className, text) => {
  const button = documentRef.createElement?.('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  return button;
};

const createTextarea = (documentRef, { readOnly = false } = {}) => {
  const textarea = documentRef.createElement?.('textarea');
  textarea.className = 'maid-settings-textarea';
  textarea.spellcheck = false;
  if (readOnly) textarea.readOnly = true;
  return textarea;
};

const iconSvg = body => `
  <svg class="maid-settings-icon" viewBox="0 0 24 24" aria-hidden="true">
    ${body}
  </svg>
`;

const ICONS = Object.freeze({
  maid: iconSvg('<path d="M12 5v3"/><path d="M8 8h8"/><path d="M7 12a5 5 0 0 1 10 0v3.5A2.5 2.5 0 0 1 14.5 18h-5A2.5 2.5 0 0 1 7 15.5Z"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M10 18v2"/><path d="M14 18v2"/>'),
  close: iconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  api: iconSvg('<path d="M7 7h10v10H7z"/><path d="M3 10h4"/><path d="M3 14h4"/><path d="M17 10h4"/><path d="M17 14h4"/><path d="M10 3v4"/><path d="M14 3v4"/><path d="M10 17v4"/><path d="M14 17v4"/>'),
  prompt: iconSvg('<path d="M5 5h14"/><path d="M5 9h10"/><path d="M5 15h14"/><path d="M5 19h9"/>'),
  knowledge: iconSvg('<path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4Z"/><path d="M9 8h6"/><path d="M9 12h5"/>'),
  history: iconSvg('<path d="M4 12a8 8 0 1 0 3-6.25"/><path d="M4 4v5h5"/><path d="M12 8v5l3 2"/>'),
  table: iconSvg('<path d="M4 5h16v14H4z"/><path d="M4 10h16"/><path d="M4 15h16"/><path d="M10 5v14"/>'),
  request: iconSvg('<path d="M5 5h14v14H5z"/><path d="M8 9h8"/><path d="M8 13h5"/><path d="M8 17h7"/>'),
  response: iconSvg('<path d="M4 6h16v10H7l-3 3Z"/><path d="M8 10h8"/><path d="M8 14h5"/>'),
  activity: iconSvg('<path d="M4 12h4l2-6 4 12 2-6h4"/>'),
  tasks: iconSvg('<path d="M9 5h11"/><path d="M9 12h11"/><path d="M9 19h11"/><path d="m3.5 5 1 1 2-2"/><path d="m3.5 12 1 1 2-2"/><path d="m3.5 19 1 1 2-2"/>'),
  plug: iconSvg('<path d="M8 12V5"/><path d="M16 12V5"/><path d="M6 9h12v3a6 6 0 0 1-12 0Z"/><path d="M12 18v3"/>'),
  userPlus: iconSvg('<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M18 8v6"/><path d="M15 11h6"/>'),
  message: iconSvg('<path d="M4 5h16v11H8l-4 4Z"/><path d="M8 9h8"/><path d="M8 13h5"/>'),
  sparkles: iconSvg('<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z"/><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z"/><path d="m5 13 .8 2.2L8 16l-2.2.8L5 19l-.8-2.2L2 16l2.2-.8Z"/>'),
  trophy: iconSvg('<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M7 6H4v2a3 3 0 0 0 3 3"/><path d="M17 6h3v2a3 3 0 0 1-3 3"/>'),
  shield: iconSvg('<path d="M12 3 5 6v5c0 4.4 3 8.1 7 9 4-.9 7-4.6 7-9V6Z"/><path d="m9.5 12 2 2 3.5-3.5"/>'),
  bolt: iconSvg('<path d="m13 2-8 12h7l-1 8 8-12h-7Z"/>'),
  chevron: iconSvg('<path d="m9 18 6-6-6-6"/>'),
  checkCircle: iconSvg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/>'),
  alertCircle: iconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>'),
  clock: iconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  copy: iconSvg('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  save: iconSvg('<path d="M5 4h12l2 2v14H5Z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/>'),
});

const clearChildren = (el) => {
  if (!el) return;
  if (typeof el.replaceChildren === 'function') {
    el.replaceChildren();
    return;
  }
  if (Array.isArray(el.children)) {
    el.children.length = 0;
    return;
  }
  while (el.firstChild) el.removeChild(el.firstChild);
};

const formatRunTime = (timestamp = 0) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
};

const describeMaidRunStatus = (run = {}) => {
  if (run?.status === 'succeeded') return { key: 'succeeded', label: '成功' };
  if (run?.metadata?.maidStatus === 'interrupted') return { key: 'interrupted', label: '中断' };
  return { key: 'failed', label: '失败' };
};

const MAID_MEMORY_KIND_LABELS = Object.freeze({
  preference: '偏好',
  decision: '决定',
  resource_state: '资源状态',
  relationship: '关系',
  task_state: '任务状态',
  important_event: '重要事件',
});

const MAID_MEMORY_CONFIDENCE_LABELS = Object.freeze({
  explicit: '用户明确',
  verified: '已验证',
  inferred: '推断',
});

const MAID_MEMORY_STATUS_LABELS = Object.freeze({
  active: '生效中',
  resolved: '已完成',
  stale: '已失效',
  archived: '已归档',
});

const setIconButtonContent = (button, icon = '', label = '') => {
  if (!button) return;
  button.innerHTML = `${icon}${label ? `<span>${label}</span>` : ''}`;
};

export const createMaidSettingsPanel = ({
  documentRef = globalThis?.document || null,
  settingsStore = null,
  skillPanel = null,
  listModelProfiles = null,
  listProfileModels = null,
  onOpenApiConfig = null,
  onOpenVoiceConfig = null,
  onVoiceModeChanged = null,
  getAppKnowledgeText = () => '',
  getHistoryContextText = () => '',
  getMemoryTableText = () => '',
  semanticMemoryStore = null,
  confirmDeleteSemanticMemory = null,
  // 记忆管理：清除最近对话 / 轮次归档；清除类操作都先经过确认弹窗
  clearHistoryContext = null,
  clearMemoryTable = null,
  confirmMemoryAction = null,
  listRuns = null,
  allowRulesStore = null,
  onResumeRun = null,
  guideStore = null,
  onboardingTasks = ONBOARDING_TASKS,
  onStartOnboardingFlow = null,
  isApiConfigured = () => false,
  copyText = text => globalThis?.navigator?.clipboard?.writeText?.(text),
  logger = console,
} = {}) => {
  let overlay = null;
  let panel = null;
  let activeTab = 'api';
  let activePromptTab = 'persona';
  const tabButtons = new Map();
  const sections = new Map();
  const promptTabButtons = new Map();
  const promptPanes = new Map();
  let promptTextarea = null;
  let appKnowledgeTextarea = null;
  let historyContextTextarea = null;
  let memoryTableTextarea = null;
  let semanticMemoryListEl = null;
  let semanticMemoryCountEl = null;
  let editingMemoryId = '';
  let lastAppContextTextarea = null;
  let lastPromptTextarea = null;
  let lastResponseTextarea = null;
  let statusEl = null;
  let runListEl = null;
  let runCountEl = null;
  let ruleListEl = null;
  let taskListEl = null;
  let taskProgressEl = null;
  let taskProgressBarEl = null;
  let taskCompletionEl = null;
  let taskListHasEntered = false;
  let promptCountEl = null;
  let isOpen = false;

  const setStatus = (message = '') => {
    if (!statusEl) return;
    statusEl.textContent = trim(message);
  };

  const getLastPromptText = () => trim(settingsStore?.getLastRequestPrompt?.(), '尚未记录任何女仆本次提示词。');
  const getLastAppContextText = () => trim(settingsStore?.getLastAppContext?.(), '尚未记录任何本次检索。');
  const getLastResponseText = () => trim(settingsStore?.getLastFullResponse?.(), '尚未记录任何女仆完整回复。');
  const getAppKnowledge = () => trim(getAppKnowledgeText?.(), '暂无 APP 知识。');
  const getHistoryContext = () => trim(getHistoryContextText?.(), '尚未记录女仆历史上下文。');
  const getMemoryTable = () => trim(getMemoryTableText?.(), '尚未生成女仆记忆表格。');

  const confirmMemory = async ({ title, message }) => (typeof confirmMemoryAction === 'function'
    ? await confirmMemoryAction({ title, message })
    : globalThis?.confirm?.(message) === true);

  // 清除一类记忆：确认后执行并刷新面板
  const runMemoryClear = async ({ title, message, action, done }) => {
    if (typeof action !== 'function') return;
    if (!await confirmMemory({ title, message })) return;
    try {
      await action();
      editingMemoryId = '';
      setStatus(done);
      refresh();
    } catch (error) {
      logger?.warn?.('maid settings clear memory failed', error);
      setStatus('清除失败');
    }
  };

  const appendEmptyItem = (container, message = '') => {
    const empty = documentRef.createElement?.('div');
    empty.className = 'maid-settings-empty';
    empty.textContent = message;
    container.appendChild(empty);
  };

  const renderRuns = () => {
    if (!runListEl) return;
    clearChildren(runListEl);
    let runs = [];
    try {
      runs = typeof listRuns === 'function' ? (listRuns({ limit: 20 }) || []) : [];
    } catch (error) {
      logger?.warn?.('maid settings list runs failed', error);
    }
    if (runCountEl) runCountEl.textContent = String(runs.length);
    if (!runs.length) {
      appendEmptyItem(runListEl, '还没有女仆任务记录。');
      return;
    }
    runs.forEach((run) => {
      const item = documentRef.createElement?.('div');
      item.className = 'maid-settings-list-item is-run';
      const status = describeMaidRunStatus(run);
      const runIcon = documentRef.createElement?.('span');
      runIcon.className = `maid-settings-run-icon is-${status.key}`;
      runIcon.innerHTML = status.key === 'succeeded'
        ? ICONS.checkCircle
        : status.key === 'interrupted'
          ? ICONS.clock
          : ICONS.alertCircle;
      const chip = documentRef.createElement?.('span');
      chip.className = `maid-settings-status-chip is-${status.key}`;
      chip.textContent = status.label;
      const main = documentRef.createElement?.('div');
      main.className = 'maid-settings-item-main';
      const heading = documentRef.createElement?.('div');
      heading.className = 'maid-settings-item-heading';
      const title = documentRef.createElement?.('div');
      title.className = 'maid-settings-item-title';
      title.dataset.i18nSkip = '';
      title.textContent = trim(run?.metadata?.goal || run?.title, '（无目标记录）');
      const time = documentRef.createElement?.('time');
      time.className = 'maid-settings-item-time';
      time.textContent = formatRunTime(run?.updatedAt);
      heading.append(title, chip, time);
      const meta = documentRef.createElement?.('div');
      meta.className = 'maid-settings-item-meta';
      meta.dataset.i18nSkip = '';
      meta.textContent = trim(run?.summary, '暂无执行摘要。');
      const tags = documentRef.createElement?.('div');
      tags.className = 'maid-settings-item-tags';
      [
        run?.metadata?.failureCode ? `分类: ${run.metadata.failureCode}` : '',
        run?.metadata?.stepCount ? `${run.metadata.stepCount} 步` : '',
        run?.metadata?.continuable ? '可继续' : '',
      ].filter(Boolean).forEach((label) => {
        const tag = documentRef.createElement?.('span');
        tag.className = 'maid-settings-item-tag';
        tag.textContent = label;
        tags.appendChild(tag);
      });
      main.append(heading, meta);
      if (tags.children?.length) main.appendChild(tags);
      appendMaidSkillRunDetails(documentRef, main, run);
      item.append(runIcon, main);
      if (run?.metadata?.continuable && typeof onResumeRun === 'function') {
        const resumeBtn = createButton(documentRef, 'maid-settings-action is-primary', '继续');
        resumeBtn.addEventListener?.('click', () => {
          hide();
          void onResumeRun({ ...run });
        });
        item.appendChild(resumeBtn);
      }
      runListEl.appendChild(item);
    });
  };

  const renderRules = () => {
    if (!ruleListEl) return;
    clearChildren(ruleListEl);
    let rules = [];
    try {
      rules = allowRulesStore?.list?.() || [];
    } catch (error) {
      logger?.warn?.('maid settings list allow rules failed', error);
    }
    if (!rules.length) {
      const empty = documentRef.createElement?.('div');
      empty.className = 'maid-settings-empty-state';
      const icon = documentRef.createElement?.('span');
      icon.className = 'maid-settings-empty-state-icon';
      icon.innerHTML = ICONS.shield;
      const title = documentRef.createElement?.('strong');
      title.textContent = '尚无始终允许规则';
      const copy = documentRef.createElement?.('p');
      copy.textContent = '没有已保存的“始终允许”规则。危险操作每次都会重新确认。';
      empty.append(icon, title, copy);
      ruleListEl.appendChild(empty);
      return;
    }
    rules.forEach((rule) => {
      const item = documentRef.createElement?.('div');
      item.className = 'maid-settings-list-item is-rule';
      const icon = documentRef.createElement?.('span');
      icon.className = 'maid-settings-rule-icon';
      icon.innerHTML = ICONS.shield;
      const main = documentRef.createElement?.('div');
      main.className = 'maid-settings-item-main';
      const title = documentRef.createElement?.('div');
      title.className = 'maid-settings-item-title';
      title.textContent = trim(rule?.title || rule?.toolName, rule?.key || '');
      const meta = documentRef.createElement?.('div');
      meta.className = 'maid-settings-item-meta';
      meta.textContent = [
        trim(rule?.toolName),
        trim(rule?.operationType),
        trim(rule?.riskLevel),
        formatRunTime(rule?.updatedAt),
      ].filter(Boolean).join(' · ');
      main.append(title, meta);
      const revokeBtn = createButton(documentRef, 'maid-settings-action', '撤销');
      revokeBtn.addEventListener?.('click', () => {
        const removed = allowRulesStore?.revoke?.(rule?.key);
        setStatus(removed ? '已撤销该规则' : '撤销失败');
        renderRules();
      });
      item.append(icon, main, revokeBtn);
      ruleListEl.appendChild(item);
    });
  };

  const renderTasks = () => {
    if (!taskListEl) return;
    clearChildren(taskListEl);
    const tasks = Array.isArray(onboardingTasks) ? onboardingTasks : [];
    const doneFlowIds = new Set(
      tasks
        .filter(task => guideStore?.isTaskDone?.(task?.id))
        .map(task => trim(task?.flowId))
        .filter(Boolean),
    );
    const completed = tasks.filter(task => guideStore?.isTaskDone?.(task?.id)).length;
    if (taskProgressEl) taskProgressEl.textContent = `${completed}/${tasks.length}`;
    taskProgressBarEl?.style?.setProperty?.('--maid-task-progress', tasks.length ? `${(completed / tasks.length) * 100}%` : '0%');
    const allDone = tasks.length > 0 && completed === tasks.length;
    taskCompletionEl?.setAttribute?.('aria-hidden', allDone ? 'false' : 'true');
    const animateRows = activeTab === 'tasks' && !taskListHasEntered;

    tasks.forEach((task, taskIndex) => {
      const isDone = Boolean(guideStore?.isTaskDone?.(task?.id));
      const requiredFlow = trim(task?.requires);
      const requirementMet = requiredFlow === 'setup-api'
        ? isApiConfigured?.() === true
        : doneFlowIds.has(requiredFlow);
      const isLocked = Boolean(requiredFlow && !requirementMet);
      const item = documentRef.createElement?.('div');
      item.className = `maid-settings-task-item${isDone ? ' is-done' : ''}${isLocked ? ' is-locked' : ''}${animateRows ? ' is-entering' : ''}`;
      item.style?.setProperty?.('--maid-task-index', String(Math.min(taskIndex, 6)));

      const icon = documentRef.createElement?.('span');
      icon.className = 'maid-settings-task-icon';
      const taskIcon = task?.icon === 'user-plus' ? ICONS.userPlus : ICONS[task?.icon] || ICONS.tasks;
      icon.innerHTML = taskIcon;
      icon.setAttribute?.('aria-hidden', 'true');

      const main = documentRef.createElement?.('div');
      main.className = 'maid-settings-task-main';
      const heading = documentRef.createElement?.('div');
      heading.className = 'maid-settings-task-heading';
      const title = documentRef.createElement?.('span');
      title.className = 'maid-settings-task-title';
      title.textContent = trim(task?.label, task?.flowId);
      const reward = documentRef.createElement?.('span');
      reward.className = 'maid-settings-task-reward';
      reward.textContent = `${isDone ? '成就·' : '奖励·'}${trim(task?.reward, '待解锁')}`;
      heading.append(title, reward);
      const description = documentRef.createElement?.('div');
      description.className = 'maid-settings-task-description';
      description.textContent = trim(task?.description);
      main.append(heading, description);

      const action = createButton(
        documentRef,
        'maid-settings-task-action',
        isLocked ? '先接 API' : (isDone ? '重温' : '开始'),
      );
      setIconButtonContent(action, isLocked ? ICONS.plug : (isDone ? ICONS.checkCircle : ICONS.sparkles), isLocked ? '先接 API' : (isDone ? '重温' : '开始'));
      action.addEventListener?.('click', () => {
        hide();
        onStartOnboardingFlow?.(isLocked ? requiredFlow : trim(task?.flowId));
      });
      item.append(icon, main, action);
      taskListEl.appendChild(item);
    });
    if (animateRows) taskListHasEntered = true;
  };

  const renderSemanticMemories = () => {
    if (!semanticMemoryListEl) return;
    clearChildren(semanticMemoryListEl);
    let memories = [];
    try {
      memories = semanticMemoryStore?.listMemories?.() || [];
    } catch (error) {
      logger?.warn?.('maid settings list semantic memories failed', error);
    }
    if (!Array.isArray(memories)) memories = [];
    if (semanticMemoryCountEl) semanticMemoryCountEl.textContent = `${memories.length} 条`;
    if (!memories.length) {
      appendEmptyItem(semanticMemoryListEl, '还没有长期记忆。');
      return;
    }
    memories.forEach((memory, memoryIndex) => {
      const item = documentRef.createElement?.('article');
      item.className = 'maid-memory-card';
      item.dataset.kind = trim(memory?.kind, 'important_event');
      item.dataset.status = trim(memory?.status, 'active');
      item.style?.setProperty?.('--maid-memory-index', String(Math.min(memoryIndex, 8)));

      const main = documentRef.createElement?.('div');
      main.className = 'maid-memory-card-main';
      const heading = documentRef.createElement?.('div');
      heading.className = 'maid-memory-card-heading';
      const kind = documentRef.createElement?.('span');
      kind.className = 'maid-memory-kind';
      kind.textContent = MAID_MEMORY_KIND_LABELS[memory?.kind] || trim(memory?.kind, '记忆');
      const confidence = documentRef.createElement?.('span');
      confidence.className = 'maid-memory-confidence';
      confidence.textContent = MAID_MEMORY_CONFIDENCE_LABELS[memory?.confidence] || trim(memory?.confidence, '未标记');
      const status = documentRef.createElement?.('span');
      status.className = 'maid-memory-status';
      status.textContent = MAID_MEMORY_STATUS_LABELS[memory?.status] || trim(memory?.status, '未知状态');
      const key = documentRef.createElement?.('code');
      key.className = 'maid-memory-key';
      key.dataset.i18nSkip = '';
      key.textContent = trim(memory?.key, 'unknown.key');
      heading.append(kind, confidence, status, key);

      const isEditing = editingMemoryId && editingMemoryId === trim(memory?.id);
      let content = null;
      if (isEditing) {
        content = createTextarea(documentRef);
        content.classList?.add?.('maid-memory-edit-input');
        content.dataset.i18nSkip = '';
        content.setAttribute?.('aria-label', '编辑记忆内容');
        content.value = trim(memory?.content);
      } else {
        content = documentRef.createElement?.('div');
        content.className = 'maid-memory-content';
        content.dataset.i18nSkip = '';
        content.textContent = trim(memory?.content, '（空）');
      }
      main.append(heading, content);

      const tags = Array.isArray(memory?.tags) ? memory.tags.map(tag => trim(tag)).filter(Boolean).slice(0, 5) : [];
      const updatedText = formatRunTime(memory?.updatedAt);
      if (tags.length || updatedText) {
        const meta = documentRef.createElement?.('div');
        meta.className = 'maid-memory-card-meta';
        tags.forEach((tagText) => {
          const tag = documentRef.createElement?.('span');
          tag.className = 'maid-memory-tag';
          tag.dataset.i18nSkip = '';
          tag.textContent = tagText;
          meta.appendChild(tag);
        });
        if (updatedText) {
          const time = documentRef.createElement?.('span');
          time.className = 'maid-memory-time';
          time.textContent = updatedText;
          meta.appendChild(time);
        }
        main.appendChild(meta);
      }

      const actions = documentRef.createElement?.('div');
      actions.className = 'maid-memory-actions';
      const memoryStatus = trim(memory?.status, 'active');
      if (isEditing) {
        const saveBtn = createButton(documentRef, 'maid-memory-status-action', '保存');
        saveBtn.addEventListener?.('click', async () => {
          const next = trim(content.value);
          if (!next) {
            setStatus('记忆内容不能为空');
            return;
          }
          try {
            const updated = await semanticMemoryStore?.updateMemoryContent?.(memory?.id, next);
            editingMemoryId = '';
            setStatus(updated ? '长期记忆已更新' : '保存失败');
            renderSemanticMemories();
          } catch (error) {
            logger?.warn?.('maid settings edit semantic memory failed', error);
            setStatus('保存失败');
          }
        });
        const cancelBtn = createButton(documentRef, 'maid-memory-status-action', '取消');
        cancelBtn.addEventListener?.('click', () => {
          editingMemoryId = '';
          renderSemanticMemories();
        });
        actions.append(saveBtn, cancelBtn);
      } else if (typeof semanticMemoryStore?.updateMemoryContent === 'function') {
        const editBtn = createButton(documentRef, 'maid-memory-status-action', '编辑');
        editBtn.addEventListener?.('click', () => {
          editingMemoryId = trim(memory?.id);
          renderSemanticMemories();
          semanticMemoryListEl?.querySelector?.('.maid-memory-edit-input')?.focus?.();
        });
        actions.appendChild(editBtn);
      }
      if (!isEditing && (memoryStatus === 'active' || memoryStatus === 'archived')) {
        const nextStatus = memoryStatus === 'archived' ? 'active' : 'archived';
        const actionLabel = memoryStatus === 'archived' ? '恢复' : '归档';
        const statusBtn = createButton(documentRef, 'maid-memory-status-action', actionLabel);
        statusBtn.addEventListener?.('click', async () => {
          try {
            const updated = await semanticMemoryStore?.setMemoryStatus?.(memory?.id, nextStatus);
            setStatus(updated ? `长期记忆已${actionLabel}` : `${actionLabel}失败`);
            renderSemanticMemories();
          } catch (error) {
            logger?.warn?.('maid settings update semantic memory status failed', error);
            setStatus(`${actionLabel}失败`);
          }
        });
        actions.appendChild(statusBtn);
      }
      const deleteBtn = createButton(documentRef, 'maid-memory-delete', '永久删除');
      deleteBtn.addEventListener?.('click', async () => {
        const confirmed = typeof confirmDeleteSemanticMemory === 'function'
          ? await confirmDeleteSemanticMemory(memory)
          : globalThis?.confirm?.('确定删除这条长期记忆吗？') === true;
        if (!confirmed) return;
        try {
          const removed = await semanticMemoryStore?.deleteMemory?.(memory?.id);
          setStatus(removed ? '长期记忆已删除' : '删除失败');
          renderSemanticMemories();
        } catch (error) {
          logger?.warn?.('maid settings delete semantic memory failed', error);
          setStatus('删除失败');
        }
      });
      if (!isEditing) actions.appendChild(deleteBtn);
      item.append(main, actions);

      const sourceIds = Array.isArray(memory?.sourceTurnIds)
        ? memory.sourceTurnIds.map(sourceId => trim(sourceId)).filter(Boolean)
        : [];
      const sources = documentRef.createElement?.('div');
      sources.className = 'maid-memory-source-list';
      const sourceLabel = documentRef.createElement?.('span');
      sourceLabel.className = 'maid-memory-source-label';
      sourceLabel.textContent = '来源';
      sources.appendChild(sourceLabel);
      if (!sourceIds.length) {
        const source = documentRef.createElement?.('span');
        source.className = 'maid-memory-source';
        source.textContent = '暂无可追溯轮次';
        sources.appendChild(source);
      } else {
        sourceIds.slice(0, 4).forEach((sourceId) => {
          const source = documentRef.createElement?.('span');
          source.className = 'maid-memory-source';
          source.dataset.i18nSkip = '';
          source.textContent = sourceId;
          source.title = sourceId;
          sources.appendChild(source);
        });
        if (sourceIds.length > 4) {
          const source = documentRef.createElement?.('span');
          source.className = 'maid-memory-source';
          source.textContent = `另 ${sourceIds.length - 4} 个`;
          sources.appendChild(source);
        }
      }
      item.appendChild(sources);
      semanticMemoryListEl.appendChild(item);
    });
  };

  const refresh = () => {
    if (promptTextarea) promptTextarea.value = settingsStore?.getMaidPrompt?.() || settingsStore?.getPersonaPrompt?.() || '';
    if (promptCountEl) promptCountEl.textContent = `${promptTextarea?.value?.length || 0} 字`;
    if (appKnowledgeTextarea) appKnowledgeTextarea.value = getAppKnowledge();
    if (historyContextTextarea) historyContextTextarea.value = getHistoryContext();
    if (memoryTableTextarea) memoryTableTextarea.value = getMemoryTable();
    if (lastAppContextTextarea) lastAppContextTextarea.value = getLastAppContextText();
    if (lastPromptTextarea) lastPromptTextarea.value = getLastPromptText();
    if (lastResponseTextarea) lastResponseTextarea.value = getLastResponseText();
    renderSemanticMemories();
    renderRuns();
    renderRules();
    renderTasks();
  };

  const switchPromptTab = (tab = 'persona') => {
    const next = ['persona', 'appKnowledge', 'historyContext', 'semanticMemory', 'memoryTable', 'lastPrompt', 'lastResponse'].includes(tab) ? tab : 'persona';
    activePromptTab = next;
    promptTabButtons.forEach((button, key) => {
      button.classList.toggle('is-active', key === activePromptTab);
      button.setAttribute?.('aria-selected', key === activePromptTab ? 'true' : 'false');
    });
    promptPanes.forEach((pane, key) => {
      pane.classList.toggle('is-active', key === activePromptTab);
      pane.setAttribute?.('aria-hidden', key === activePromptTab ? 'false' : 'true');
    });
    const revealActivePromptTab = () => promptTabButtons.get(activePromptTab)?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    });
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(revealActivePromptTab);
    } else {
      revealActivePromptTab();
    }
    refresh();
    setStatus('');
  };

  let refreshApiSubSection = null;
  const switchTab = (tab = 'api', approved = false) => {
    if (!approved && activeTab === 'skills' && tab !== 'skills' && skillPanel?.isDirty()) {
      return skillPanel.beforeLeave().then(ok => ok && switchTab(tab, true));
    }
    const promptSubtab = tab === 'appKnowledge' || tab === 'historyContext' || tab === 'semanticMemory' || tab === 'memoryTable' || tab === 'lastPrompt' || tab === 'lastResponse' || tab === 'persona'
      ? tab
      : '';
    const next = promptSubtab ? 'prompt' : (['api', 'prompt', 'skills', 'tasks', 'activity', 'safety'].includes(tab) ? tab : 'api');
    if (next === 'api') {
      try { refreshApiSubSection?.(); } catch {}
    }
    activeTab = next;
    tabButtons.forEach((button, key) => {
      button.classList.toggle('is-active', key === activeTab);
      button.setAttribute?.('aria-selected', key === activeTab ? 'true' : 'false');
    });
    sections.forEach((section, key) => {
      section.classList.toggle('is-active', key === activeTab);
      section.setAttribute?.('aria-hidden', key === activeTab ? 'false' : 'true');
    });
    if (activeTab === 'prompt') switchPromptTab(promptSubtab || activePromptTab || 'persona');
    if (activeTab === 'skills') skillPanel?.refresh();
    refresh();
    setStatus('');
  };

  const copyCurrentText = async (kind = '') => {
    const text = kind === 'lastResponse'
      ? lastResponseTextarea?.value
      : kind === 'lastPrompt'
        ? lastPromptTextarea?.value
        : kind === 'historyContext'
          ? historyContextTextarea?.value
          : kind === 'memoryTable'
            ? memoryTableTextarea?.value
        : promptTextarea?.value;
    if (!trim(text)) return false;
    try {
      await copyText?.(text);
      setStatus('已复制');
      return true;
    } catch (error) {
      logger?.warn?.('maid settings copy failed', error);
      setStatus('复制失败');
      return false;
    }
  };

  const savePrompt = async () => {
    try {
      if (typeof settingsStore?.setMaidPrompt === 'function') {
        await settingsStore.setMaidPrompt(promptTextarea?.value || '');
      } else {
        await settingsStore?.setPersonaPrompt?.(promptTextarea?.value || '');
      }
      setStatus('提示词已保存');
      refresh();
      return true;
    } catch (error) {
      logger?.warn?.('maid prompt save failed', error);
      setStatus('保存失败');
      return false;
    }
  };

  const ensure = () => {
    if (overlay || !documentRef?.body) return overlay;
    injectStyle(documentRef);

    overlay = documentRef.createElement?.('div');
    overlay.className = 'maid-settings-overlay';
    overlay.setAttribute?.('aria-hidden', 'true');
    overlay.addEventListener?.('click', () => hide());

    panel = documentRef.createElement?.('div');
    panel.className = 'maid-settings-panel';
    panel.setAttribute?.('role', 'dialog');
    panel.setAttribute?.('aria-modal', 'true');
    panel.setAttribute?.('aria-label', '女仆设定');
    panel.addEventListener?.('click', event => event.stopPropagation?.());

    const header = documentRef.createElement?.('div');
    header.className = 'maid-settings-header';
    const mark = documentRef.createElement?.('div');
    mark.className = 'maid-settings-mark';
    mark.innerHTML = ICONS.maid;
    mark.setAttribute?.('aria-hidden', 'true');
    const headerCopy = documentRef.createElement?.('div');
    headerCopy.className = 'maid-settings-header-copy';
    const title = documentRef.createElement?.('div');
    title.className = 'maid-settings-title';
    title.textContent = '女仆设定';
    const headerMeta = documentRef.createElement?.('div');
    headerMeta.className = 'maid-settings-header-meta';
    const assistantName = documentRef.createElement?.('span');
    assistantName.className = 'maid-settings-assistant-name';
    assistantName.textContent = 'ARIA Assistant';
    const headerSeparator = documentRef.createElement?.('span');
    headerSeparator.className = 'maid-settings-header-separator';
    headerSeparator.textContent = '·';
    const runtimeStatus = documentRef.createElement?.('span');
    runtimeStatus.className = 'maid-settings-runtime-status';
    const runtimeDot = documentRef.createElement?.('span');
    runtimeDot.className = 'maid-settings-runtime-dot';
    runtimeDot.setAttribute?.('aria-hidden', 'true');
    const runtimeLabel = documentRef.createElement?.('span');
    runtimeLabel.textContent = '运行中';
    runtimeStatus.append(runtimeDot, runtimeLabel);
    headerMeta.append(assistantName, headerSeparator, runtimeStatus);
    headerCopy.append(title, headerMeta);
    const closeBtn = createButton(documentRef, 'maid-settings-close', '×');
    closeBtn.innerHTML = ICONS.close;
    closeBtn.setAttribute?.('aria-label', '关闭女仆设定');
    closeBtn.addEventListener?.('click', () => hide());
    header.append(mark, headerCopy, closeBtn);

    const tabs = documentRef.createElement?.('div');
    tabs.className = 'maid-settings-tabs';
    tabs.setAttribute?.('role', 'tablist');
    tabs.setAttribute?.('aria-label', '女仆设定分页');
    [
      ['api', 'API', ICONS.api],
      ['prompt', '提示词', ICONS.prompt],
      ...(skillPanel ? [['skills', '技能', ICONS.tasks]] : []),
      ['tasks', '任务', ICONS.tasks],
      ['activity', '活动', ICONS.activity],
      ['safety', '权限', ICONS.shield],
    ].forEach(([key, label, icon]) => {
      const button = createButton(documentRef, 'maid-settings-tab', label);
      setIconButtonContent(button, icon, label);
      button.setAttribute?.('role', 'tab');
      button.setAttribute?.('id', `maid-settings-tab-${key}`);
      button.setAttribute?.('aria-controls', `maid-settings-section-${key}`);
      button.setAttribute?.('aria-selected', 'false');
      button.addEventListener?.('click', () => switchTab(key));
      tabButtons.set(key, button);
      tabs.appendChild(button);
    });

    const body = documentRef.createElement?.('div');
    body.className = 'maid-settings-body';

    const apiSection = documentRef.createElement?.('section');
    apiSection.className = 'maid-settings-section';
    // API 分页二级导航：一级为干净的入口列表，二级为各自配置表单（2026-07-08）
    let apiPage = '';
    let editingSubAgentId = '';
    const renderApiSection = () => {
      if (!apiSection || typeof apiSection.querySelector !== 'function') return;
      const profiles = (typeof listModelProfiles === 'function' ? listModelProfiles() : []) || [];
      const profileById = id => profiles.find(item => item.id === id) || null;
      const profileOptions = selected => profiles.map(p => `<option data-i18n-skip value="${escapeHtml(p.id)}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.label || p.name || p.id)}</option>`).join('');
      const boundId = settingsStore?.getBoundProfileId?.() || '';
      const boundOverride = settingsStore?.getBoundModelOverride?.() || '';
      const boundProfile = profileById(boundId);
      const fallbackId = settingsStore?.getFallbackProfileId?.() || '';
      const subAgents = settingsStore?.listSubAgents?.() || [];
      const memoryExtraction = settingsStore?.getMemoryExtractionSettings?.() || {
        mode: 'follow_main',
        profileId: '',
        modelOverride: '',
        fallbackToMain: false,
      };
      const memoryExtractionMode = memoryExtraction.mode === 'custom' ? 'custom' : 'follow_main';
      const memoryExtractionProfile = profileById(memoryExtraction.profileId);

      if (apiPage === 'voice') {
        const mode = settingsStore?.getVoiceInputMode?.() || 'realtime';
        apiSection.innerHTML = `
          <button type="button" class="maid-api-back" data-api-back>${ICONS.chevron}<span>返回</span></button>
          <div class="maid-api-group">
            <div class="maid-api-group-title">女仆语音</div>
            <label class="maid-api-field"><span class="maid-api-field-label">空输入时的默认按钮</span>
              <select class="maid-subagent-select" data-maid-voice-mode><option value="realtime" ${mode === 'realtime' ? 'selected' : ''}>实时通话</option><option value="stt" ${mode === 'stt' ? 'selected' : ''}>语音输入</option></select>
            </label>
            <p class="maid-api-group-desc">长按或右键点击语音按钮，也可切换默认模式。语音输入会先转成文字，由你确认后发送。</p>
            <button type="button" class="maid-settings-action" data-maid-voice-config="realtime">实时语音配置</button>
            <button type="button" class="maid-settings-action" data-maid-voice-config="stt">语音输入配置</button>
          </div>`;
      } else if (apiPage === 'main') {
        const shownModel = boundOverride || boundProfile?.model || '';
        apiSection.innerHTML = `
          <button type="button" class="maid-api-back" data-api-back>${ICONS.chevron}<span>返回</span></button>
          <div class="maid-api-group">
            <div class="maid-api-group-title">女仆主配置</div>
            <div class="maid-api-group-desc">女仆规划与执行使用的主模型。</div>
            <div class="maid-api-group-note">
              <strong>选渠道前请留意：</strong>该渠道需<strong>支持工具调用（function / tool calling）</strong>，否则女仆只能对话、无法真正执行操作；且女仆完成一次任务会连续发多次请求（规划 → 调用 → 读结果 → 再决策），比普通聊天更容易撞到渠道的 <strong>RPM（每分钟请求数）</strong>上限。
            </div>
            <label class="maid-api-field">
              <span class="maid-api-field-label">连线配置</span>
              <select class="maid-subagent-select" data-main-profile>
                <option value="">未绑定</option>
                ${profileOptions(boundId)}
              </select>
            </label>
            <label class="maid-api-field">
              <span class="maid-api-field-label">模型</span>
              <span class="maid-subagent-model-row">
                <input type="text" class="maid-subagent-input" data-main-model placeholder="${boundId ? '默认该配置保存的模型，可改' : '先选连线配置'}" maxlength="120" value="${escapeHtml(shownModel)}" ${boundId ? '' : 'disabled'} />
                <button type="button" class="maid-settings-action" data-main-model-pick ${boundId ? '' : 'disabled'}>▾</button>
              </span>
            </label>
            <div class="maid-subagent-model-menu" data-main-model-menu hidden></div>
            <label class="maid-api-field">
              <span class="maid-api-field-label">故障降级（主模型请求失败时自动用备用配置重试一次）</span>
              <select class="maid-subagent-select" data-main-fallback>
                <option value="">不降级</option>
                ${profileOptions(fallbackId)}
              </select>
            </label>
            ${(() => {
              const generation = settingsStore?.getGenerationSettings?.() || { reasoningMode: 'off', reasoningEffort: 'low' };
              const control = getAgentReasoningControl({ provider: boundProfile?.provider || '', model: shownModel });
              const efforts = control.effortOptions.some(item => item.value === generation.reasoningEffort)
                ? control.effortOptions : [...control.effortOptions, { value: generation.reasoningEffort, label: generation.reasoningEffort }];
              const hint = !shownModel ? '选择模型后可设置思考。'
                : !control.supported ? '暂未识别此模型的思考参数，将使用模型默认行为。'
                  : control.canDisable ? '关闭时会明确要求模型不思考；开启后按所选强度发送。'
                    : '此模型无法完全关闭思考，「不额外请求」时沿用模型自身行为；想更快可选开启 + 低强度。';
              return `
            <label class="maid-api-field">
              <span class="maid-api-field-label">思考模式（仅用于女仆，与预设参数独立）</span>
              <select class="maid-subagent-select" data-main-reasoning-mode>
                <option value="off"${generation.reasoningMode === 'off' ? ' selected' : ''}>${control.canDisable ? '关闭（默认）' : '不额外请求（默认）'}</option>
                <option value="on"${generation.reasoningMode === 'on' ? ' selected' : ''}>开启</option>
                <option value="default"${generation.reasoningMode === 'default' ? ' selected' : ''}>模型默认</option>
              </select>
            </label>
            <label class="maid-api-field" data-main-reasoning-effort-field${generation.reasoningMode === 'on' ? '' : ' hidden'}>
              <span class="maid-api-field-label">思考强度</span>
              <select class="maid-subagent-select" data-main-reasoning-effort>
                ${efforts.map(item => `<option value="${escapeHtml(item.value)}"${item.value === generation.reasoningEffort ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
              </select>
            </label>
            <div class="maid-api-group-desc"><span>${hint}</span><span>女仆每步只输出很短的指令，一般不需要思考；开启会变慢、消耗更多。</span></div>`;
            })()}
            <label class="maid-api-field">
              <span class="maid-api-field-label">单次任务步数上限（${MAID_REACT_STEP_LIMIT_MIN}-${MAID_REACT_STEP_LIMIT_MAX}，默认 ${MAID_REACT_STEP_LIMIT_DEFAULT}）</span>
              <input type="number" class="maid-subagent-input" data-main-max-steps inputmode="numeric" min="${MAID_REACT_STEP_LIMIT_MIN}" max="${MAID_REACT_STEP_LIMIT_MAX}" step="1" value="${escapeHtml(String(settingsStore?.getMaxReactSteps?.() ?? MAID_REACT_STEP_LIMIT_DEFAULT))}" />
            </label>
            <div class="maid-api-group-desc">复杂任务达到上限会先停下，你说「继续」即可接着执行。调高会让长任务少打断，但单次任务的请求次数与消耗也会随之增加。</div>
            <button type="button" class="maid-api-manage-link" data-api-open-config>管理连线配置（新增/编辑渠道）…</button>
          </div>
        `;
      } else if (apiPage === 'memory') {
        const shownMemoryModel = memoryExtraction.modelOverride || memoryExtractionProfile?.model || '';
        apiSection.innerHTML = `
          <button type="button" class="maid-api-back" data-api-back>${ICONS.chevron}<span>返回</span></button>
          <div class="maid-api-group">
            <div class="maid-api-group-title">记忆提取模型</div>
            <div class="maid-api-group-desc">旧轮次达到压缩阈值后，后台从中提炼长期偏好与决定；不会改变女仆平时聊天或执行任务的模型。</div>
            <label class="maid-api-field">
              <span class="maid-api-field-label">提取模型</span>
              <select class="maid-subagent-select" data-memory-extraction-mode>
                <option value="follow_main"${memoryExtractionMode === 'follow_main' ? ' selected' : ''}>跟随女仆主模型</option>
                <option value="custom"${memoryExtractionMode === 'custom' ? ' selected' : ''}>使用自定义模型</option>
              </select>
            </label>
            ${memoryExtractionMode === 'custom' ? `
              <label class="maid-api-field">
                <span class="maid-api-field-label">连线配置</span>
                <select class="maid-subagent-select" data-memory-extraction-profile>
                  <option value="">选择连线配置…</option>
                  ${profileOptions(memoryExtraction.profileId)}
                </select>
              </label>
              <label class="maid-api-field">
                <span class="maid-api-field-label">模型</span>
                <span class="maid-subagent-model-row">
                  <input type="text" class="maid-subagent-input" data-memory-extraction-model placeholder="${memoryExtraction.profileId ? '默认该配置保存的模型，可改' : '先选连线配置'}" maxlength="120" value="${escapeHtml(shownMemoryModel)}" ${memoryExtraction.profileId ? '' : 'disabled'} />
                  <button type="button" class="maid-settings-action" data-memory-extraction-model-pick ${memoryExtraction.profileId ? '' : 'disabled'}>▾</button>
                </span>
              </label>
              <div class="maid-subagent-model-menu" data-memory-extraction-model-menu hidden></div>
              <label class="maid-subagent-skill">
                <input type="checkbox" data-memory-extraction-fallback${memoryExtraction.fallbackToMain === true ? ' checked' : ''} />
                自定义模型失败时，使用女仆主模型重试一次
              </label>
              <div class="maid-api-group-desc">网络错误、空响应或无法解析的 JSON 都视为失败。主模型兜底与后续自动重试共用现有的有界重试预算。</div>
            ` : `
              <div class="maid-api-group-desc">当前与女仆主配置使用相同模型；现有行为与模型消耗保持不变。</div>
            `}
            <button type="button" class="maid-api-manage-link" data-api-open-config>管理连线配置（新增/编辑渠道）…</button>
          </div>
        `;
      } else if (apiPage === 'subagent') {
        const editing = editingSubAgentId ? subAgents.find(item => item.id === editingSubAgentId) : null;
        const editingProfile = editing ? profileById(editing.modelProfileId) : null;
        const formModelValue = editing ? (editing.modelOverride || editingProfile?.model || '') : '';
        const skillChecks = MAID_SUB_AGENT_SKILLS.map(skill => `
          <label class="maid-subagent-skill"><input type="checkbox" data-sub-skill="${escapeHtml(skill.id)}"${editing?.skills?.includes(skill.id) ? ' checked' : ''} />${escapeHtml(skill.label)}</label>
        `).join('');
        apiSection.innerHTML = `
          <button type="button" class="maid-api-back" data-api-back>${ICONS.chevron}<span>返回</span></button>
          <div class="maid-api-group">
            <div class="maid-api-group-title">Sub-agent 模型</div>
            <div class="maid-api-group-desc">女仆按能力标签把重内容生成等任务委派给这些模型，调用前会请求确认。</div>
            <div class="maid-subagent-list">
              ${subAgents.length ? subAgents.map(item => `
                <div class="maid-subagent-item${item.id === editingSubAgentId ? ' is-editing' : ''}">
                  <div class="maid-subagent-item-main">
                    <span class="maid-subagent-item-name" data-i18n-skip>${escapeHtml(item.name)}</span>
                    <span class="maid-subagent-item-meta">${item.skills.length ? item.skills.map(id => `<span>${escapeHtml(MAID_SUB_AGENT_SKILLS.find(s => s.id === id)?.label || id)}</span>`).join(' · ') : '<span>未设标签</span>'}${item.modelOverride ? ` · <code data-i18n-skip>${escapeHtml(item.modelOverride)}</code>` : ''}</span>
                  </div>
                  <button type="button" class="maid-settings-action" data-sub-edit="${escapeHtml(item.id)}">编辑</button>
                  <button type="button" class="maid-settings-action" data-sub-remove="${escapeHtml(item.id)}">删除</button>
                </div>
              `).join('') : '<div class="maid-settings-empty">还没有配置 sub-agent 模型。</div>'}
            </div>
            <div class="maid-subagent-form">
              <div class="maid-api-form-title">${editing ? `编辑「${escapeHtml(editing.name)}」` : '添加 Sub-agent'}</div>
              <label class="maid-api-field">
                <span class="maid-api-field-label">名称</span>
                <input type="text" class="maid-subagent-input" data-sub-name placeholder="如：快手 flash" maxlength="40" value="${escapeHtml(editing?.name || '')}" />
              </label>
              <label class="maid-api-field">
                <span class="maid-api-field-label">连线配置</span>
                <select class="maid-subagent-select" data-sub-profile>
                  <option value="">选择连线配置…</option>
                  ${profileOptions(editing?.modelProfileId || '')}
                </select>
              </label>
              <label class="maid-api-field">
                <span class="maid-api-field-label">模型</span>
                <span class="maid-subagent-model-row">
                  <input type="text" class="maid-subagent-input" data-sub-model placeholder="${editing ? '默认该配置保存的模型，可改' : '先选连线配置'}" maxlength="120" value="${escapeHtml(formModelValue)}" ${editing ? '' : 'disabled'} />
                  <button type="button" class="maid-settings-action" data-sub-model-pick ${editing ? '' : 'disabled'}>▾</button>
                </span>
              </label>
              <div class="maid-subagent-model-menu" data-sub-model-menu hidden></div>
              <div class="maid-api-field">
                <span class="maid-api-field-label">能力标签</span>
                <div class="maid-subagent-skills">${skillChecks}</div>
              </div>
              <label class="maid-api-field">
                <span class="maid-api-field-label">备注</span>
                <input type="text" class="maid-subagent-input" data-sub-note placeholder="可选，会展示给女仆" maxlength="200" value="${escapeHtml(editing?.note || '')}" />
              </label>
              <div class="maid-api-form-actions">
                <button type="button" class="maid-settings-action is-primary" data-sub-add>${editing ? '保存修改' : '添加 Sub-agent'}</button>
                ${editing ? '<button type="button" class="maid-settings-action" data-sub-cancel-edit>取消编辑</button>' : ''}
              </div>
            </div>
          </div>
        `;
      } else {
        // 一级：干净的入口列表 + 状态摘要
        const mainName = boundProfile?.name || boundProfile?.label || '尚未绑定连线配置';
        const mainModel = boundOverride || boundProfile?.model || '';
        const subSummary = subAgents.length
          ? subAgents.map(item => `<span data-i18n-skip>${escapeHtml(item.name)}</span>`).slice(0, 3).join('、') + (subAgents.length > 3 ? ` <span>等 ${subAgents.length} 个</span>` : '')
          : '按能力标签委派模型任务';
        const memorySummary = memoryExtractionMode === 'custom'
          ? (memoryExtractionProfile?.name || memoryExtractionProfile?.label || '尚未选择连线配置')
          : '跟随女仆主模型';
        const memoryModel = memoryExtractionMode === 'custom'
          ? (memoryExtraction.modelOverride || memoryExtractionProfile?.model || '')
          : mainModel;
        apiSection.innerHTML = `
          <div class="maid-settings-section-caption"><span>模型配置</span><small>MODEL ROUTING</small></div>
          <div class="maid-api-nav">
            <button type="button" class="maid-api-nav-item" data-api-nav="main">
              <span class="maid-api-nav-icon">${ICONS.maid}</span>
              <span class="maid-api-nav-copy">
                <span class="maid-api-nav-heading">
                  <span class="maid-api-nav-title">女仆主配置</span>
                  <span class="maid-api-nav-badge${boundProfile ? '' : ' is-muted'}">${boundProfile ? '已连接' : '未配置'}</span>
                </span>
                <span class="maid-api-nav-summary">
                  <span><span data-i18n-skip>${escapeHtml(mainName)}</span>${fallbackId ? ' · <span>已配置故障降级</span>' : ''}</span>
                  ${mainModel ? `<code>${escapeHtml(mainModel)}</code>` : ''}
                </span>
              </span>
              <span class="maid-api-nav-chevron">${ICONS.chevron}</span>
            </button>
            <button type="button" class="maid-api-nav-item" data-api-nav="voice">
              <span class="maid-api-nav-icon">${ICONS.maid}</span>
              <span class="maid-api-nav-copy"><span class="maid-api-nav-heading"><span class="maid-api-nav-title">女仆语音</span></span><span class="maid-api-nav-summary">${settingsStore?.getVoiceInputMode?.() === 'stt' ? '语音输入' : '实时通话'}</span></span>
              <span class="maid-api-nav-chevron">${ICONS.chevron}</span>
            </button>
            <button type="button" class="maid-api-nav-item" data-api-nav="subagent">
              <span class="maid-api-nav-icon is-subagent">${ICONS.bolt}</span>
              <span class="maid-api-nav-copy">
                <span class="maid-api-nav-heading">
                  <span class="maid-api-nav-title">Sub-agent 模型</span>
                  <span class="maid-api-nav-badge${subAgents.length ? '' : ' is-muted'}">${subAgents.length ? `${subAgents.length} 个模型` : '未配置'}</span>
                </span>
                <span class="maid-api-nav-summary">${subSummary}</span>
              </span>
              <span class="maid-api-nav-chevron">${ICONS.chevron}</span>
            </button>
            <button type="button" class="maid-api-nav-item" data-api-nav="memory">
              <span class="maid-api-nav-icon">${ICONS.table}</span>
              <span class="maid-api-nav-copy">
                <span class="maid-api-nav-heading">
                  <span class="maid-api-nav-title">记忆提取模型</span>
                  <span class="maid-api-nav-badge${memoryExtractionMode === 'custom' && !memoryExtractionProfile ? ' is-muted' : ''}">${memoryExtractionMode === 'custom' ? '自定义' : '跟随主模型'}</span>
                </span>
                <span class="maid-api-nav-summary">
                  <span>${memoryExtractionMode === 'custom' ? `<span data-i18n-skip>${escapeHtml(memorySummary)}</span>` : `<span>${escapeHtml(memorySummary)}</span>`}${memoryExtractionMode === 'custom' && memoryExtraction.fallbackToMain === true ? ' · <span>失败时回退主模型</span>' : ''}</span>
                  ${memoryModel ? `<code>${escapeHtml(memoryModel)}</code>` : ''}
                </span>
              </span>
              <span class="maid-api-nav-chevron">${ICONS.chevron}</span>
            </button>
          </div>
        `;
      }
      bindApiSectionEvents();
    };

    const bindModelPicker = ({ inputSel, pickSel, menuSel, getProfileId }) => {
      const input = apiSection.querySelector(inputSel);
      const pickBtn = apiSection.querySelector(pickSel);
      const menu = apiSection.querySelector(menuSel);
      if (!input || !pickBtn || !menu) return { input };
      const closeMenu = () => { menu.hidden = true; menu.innerHTML = ''; };
      let candidates = [];
      const renderOptions = () => {
        if (menu.hidden) return;
        const ranked = rankModelCandidates(candidates, input.value || '');
        menu.innerHTML = ranked.length
          ? ranked.map(m => `<button type="button" class="maid-subagent-model-option" data-model-opt="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('')
          : '<div class="maid-subagent-model-option is-loading">该渠道未返回模型列表，可手动输入</div>';
        menu.querySelectorAll('[data-model-opt]').forEach((btn) => {
          btn.addEventListener('click', () => {
            input.value = btn.dataset.modelOpt || '';
            closeMenu();
            input.dispatchEvent(new Event('change', { bubbles: false }));
          });
        });
      };
      input.addEventListener('input', renderOptions);
      pickBtn.addEventListener('click', async () => {
        const profileId = getProfileId();
        if (!profileId) return;
        if (!menu.hidden) { closeMenu(); return; }
        menu.hidden = false;
        menu.innerHTML = '<div class="maid-subagent-model-option is-loading">加载模型列表…</div>';
        try {
          candidates = (await listProfileModels?.(profileId)) || [];
        } catch {
          candidates = [];
        }
        renderOptions();
      });
      return { input, closeMenu };
    };

    const bindApiSectionEvents = () => {
      apiSection.querySelector('[data-maid-voice-mode]')?.addEventListener('change', async event => {
        await settingsStore?.setVoiceInputMode?.(event.target.value);
        onVoiceModeChanged?.();
      });
      apiSection.querySelectorAll('[data-maid-voice-config]').forEach(button => button.addEventListener('click', () => {
        hide(); void onOpenVoiceConfig?.(button.dataset.maidVoiceConfig);
      }));
      const profiles = (typeof listModelProfiles === 'function' ? listModelProfiles() : []) || [];
      apiSection.querySelectorAll('[data-api-nav]').forEach((btn) => {
        btn.addEventListener('click', () => {
          apiPage = btn.dataset.apiNav || '';
          renderApiSection();
        });
      });
      apiSection.querySelector('[data-api-back]')?.addEventListener('click', () => {
        apiPage = '';
        editingSubAgentId = '';
        renderApiSection();
      });
      apiSection.querySelector('[data-api-open-config]')?.addEventListener('click', () => {
        hide();
        void onOpenApiConfig?.({ source: 'maid_settings' });
      });
      // 主配置页
      const mainProfileSelect = apiSection.querySelector('[data-main-profile]');
      if (mainProfileSelect) {
        const { input: mainModelInput } = bindModelPicker({
          inputSel: '[data-main-model]',
          pickSel: '[data-main-model-pick]',
          menuSel: '[data-main-model-menu]',
          getProfileId: () => mainProfileSelect.value,
        });
        mainProfileSelect.addEventListener('change', async () => {
          const profileId = mainProfileSelect.value;
          await settingsStore?.setBoundProfileId?.(profileId);
          await settingsStore?.setBoundModelOverride?.('');
          renderApiSection();
        });
        mainModelInput?.addEventListener('change', async () => {
          const chosen = mainModelInput.value.trim();
          const profileModel = (profiles.find(item => item.id === mainProfileSelect.value)?.model || '').trim();
          await settingsStore?.setBoundModelOverride?.(chosen && chosen !== profileModel ? chosen : '');
        });
        apiSection.querySelector('[data-main-fallback]')?.addEventListener('change', (event) => {
          void settingsStore?.setFallbackProfileId?.(event.target.value);
        });
        apiSection.querySelector('[data-main-reasoning-mode]')?.addEventListener('change', async (event) => {
          await settingsStore?.setGenerationSettings?.({ reasoningMode: event.target.value });
          const effortField = apiSection.querySelector('[data-main-reasoning-effort-field]');
          if (effortField) effortField.hidden = event.target.value !== 'on';
        });
        apiSection.querySelector('[data-main-reasoning-effort]')?.addEventListener('change', (event) => {
          void settingsStore?.setGenerationSettings?.({ reasoningEffort: event.target.value });
        });
        const maxStepsInput = apiSection.querySelector('[data-main-max-steps]');
        maxStepsInput?.addEventListener('change', async () => {
          const normalized = normalizeMaidReactStepLimit(maxStepsInput.value);
          maxStepsInput.value = String(normalized);
          await settingsStore?.setMaxReactSteps?.(normalized);
        });
      }
      // 长期记忆提取模型页
      const memoryModeSelect = apiSection.querySelector('[data-memory-extraction-mode]');
      if (memoryModeSelect) {
        memoryModeSelect.addEventListener('change', async () => {
          await settingsStore?.setMemoryExtractionSettings?.({
            mode: memoryModeSelect.value === 'custom' ? 'custom' : 'follow_main',
          });
          renderApiSection();
        });
      }
      const memoryProfileSelect = apiSection.querySelector('[data-memory-extraction-profile]');
      if (memoryProfileSelect) {
        const { input: memoryModelInput } = bindModelPicker({
          inputSel: '[data-memory-extraction-model]',
          pickSel: '[data-memory-extraction-model-pick]',
          menuSel: '[data-memory-extraction-model-menu]',
          getProfileId: () => memoryProfileSelect.value,
        });
        memoryProfileSelect.addEventListener('change', async () => {
          await settingsStore?.setMemoryExtractionSettings?.({
            profileId: memoryProfileSelect.value,
            modelOverride: '',
          });
          renderApiSection();
        });
        memoryModelInput?.addEventListener('change', async () => {
          const chosen = memoryModelInput.value.trim();
          const profileModel = (profiles.find(item => item.id === memoryProfileSelect.value)?.model || '').trim();
          await settingsStore?.setMemoryExtractionSettings?.({
            modelOverride: chosen && chosen !== profileModel ? chosen : '',
          });
        });
        apiSection.querySelector('[data-memory-extraction-fallback]')?.addEventListener('change', (event) => {
          void settingsStore?.setMemoryExtractionSettings?.({
            fallbackToMain: event.target.checked === true,
          });
        });
      }
      // sub-agent 页
      apiSection.querySelectorAll('[data-sub-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          editingSubAgentId = btn.dataset.subEdit || '';
          renderApiSection();
        });
      });
      apiSection.querySelector('[data-sub-cancel-edit]')?.addEventListener('click', () => {
        editingSubAgentId = '';
        renderApiSection();
      });
      apiSection.querySelectorAll('[data-sub-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.subRemove === editingSubAgentId) editingSubAgentId = '';
          await settingsStore?.removeSubAgent?.(btn.dataset.subRemove);
          renderApiSection();
        });
      });
      const subProfileSelect = apiSection.querySelector('[data-sub-profile]');
      if (subProfileSelect) {
        const { input: subModelInput } = bindModelPicker({
          inputSel: '[data-sub-model]',
          pickSel: '[data-sub-model-pick]',
          menuSel: '[data-sub-model-menu]',
          getProfileId: () => subProfileSelect.value,
        });
        subProfileSelect.addEventListener('change', () => {
          const profileId = subProfileSelect.value;
          const profile = profiles.find(item => item.id === profileId);
          if (subModelInput) {
            subModelInput.disabled = !profileId;
            subModelInput.value = profile?.model || '';
            subModelInput.placeholder = '模型（默认该配置保存的模型，可改）';
          }
          const pick = apiSection.querySelector('[data-sub-model-pick]');
          if (pick) pick.disabled = !profileId;
        });
        apiSection.querySelector('[data-sub-add]')?.addEventListener('click', async () => {
          const name = apiSection.querySelector('[data-sub-name]')?.value?.trim();
          const modelProfileId = subProfileSelect.value || '';
          if (!modelProfileId) {
            globalThis.toastr?.warning?.('请先选择连线配置');
            return;
          }
          const skills = Array.from(apiSection.querySelectorAll('[data-sub-skill]:checked')).map(el => el.dataset.subSkill);
          const existingCount = (settingsStore?.listSubAgents?.() || []).length;
          const chosenModel = subModelInput?.value?.trim() || '';
          const profileModel = (profiles.find(item => item.id === modelProfileId)?.model || '').trim();
          await settingsStore?.upsertSubAgent?.({
            ...(editingSubAgentId ? { id: editingSubAgentId } : {}),
            name,
            modelProfileId,
            modelOverride: chosenModel && chosenModel !== profileModel ? chosenModel : '',
            skills,
            note: apiSection.querySelector('[data-sub-note]')?.value?.trim() || '',
          });
          if (!editingSubAgentId && existingCount >= 1) {
            globalThis.toastr?.info?.('提示：配置多个模型时，女仆委派会带来相应的多份模型消耗。');
          }
          editingSubAgentId = '';
          renderApiSection();
        });
      }
    };

    renderApiSection();
    refreshApiSubSection = () => { apiPage = ''; editingSubAgentId = ''; renderApiSection(); };

    const promptSection = documentRef.createElement?.('section');
    promptSection.className = 'maid-settings-section';
    const promptSubtabs = documentRef.createElement?.('div');
    promptSubtabs.className = 'maid-settings-prompt-tabs';
    promptSubtabs.setAttribute?.('role', 'tablist');
    promptSubtabs.setAttribute?.('aria-label', '提示词资料分页');
    [
      ['persona', '人格'],
      ['appKnowledge', 'APP知识'],
      ['historyContext', '历史上下文'],
      ['semanticMemory', '长期记忆'],
      ['memoryTable', '轮次归档'],
      ['lastPrompt', '本次提示词'],
      ['lastResponse', '本次完整回复'],
    ].forEach(([key, label]) => {
      const button = createButton(documentRef, 'maid-settings-prompt-tab', label);
      button.setAttribute?.('role', 'tab');
      button.setAttribute?.('id', `maid-settings-prompt-tab-${key}`);
      button.setAttribute?.('aria-controls', `maid-settings-prompt-pane-${key}`);
      button.setAttribute?.('aria-selected', 'false');
      button.addEventListener?.('click', () => switchPromptTab(key));
      promptTabButtons.set(key, button);
      promptSubtabs.appendChild(button);
    });
    const personaPane = documentRef.createElement?.('div');
    personaPane.className = 'maid-settings-prompt-pane';
    const promptField = documentRef.createElement?.('div');
    promptField.className = 'maid-settings-field';
    const promptLabel = documentRef.createElement?.('div');
    promptLabel.className = 'maid-settings-label';
    promptLabel.textContent = '提示词';
    const promptFieldHeader = documentRef.createElement?.('div');
    promptFieldHeader.className = 'maid-settings-field-header';
    promptCountEl = documentRef.createElement?.('span');
    promptCountEl.className = 'maid-settings-char-count';
    promptCountEl.textContent = '0 字';
    promptFieldHeader.append(promptLabel, promptCountEl);
    promptTextarea = createTextarea(documentRef);
    if (promptTextarea?.dataset) {
      promptTextarea.dataset.viewportKeyboardDiagnostic = 'maid-persona-prompt';
    }
    promptTextarea.placeholder = '女仆基础提示词';
    promptTextarea.addEventListener?.('input', () => {
      if (promptCountEl) promptCountEl.textContent = `${promptTextarea?.value?.length || 0} 字`;
    });
    const promptFooter = documentRef.createElement?.('div');
    promptFooter.className = 'maid-settings-footer';
    const saveBtn = createButton(documentRef, 'maid-settings-action is-primary', '保存');
    setIconButtonContent(saveBtn, ICONS.save, '保存');
    saveBtn.addEventListener?.('click', () => void savePrompt());
    const copyPromptBtn = createButton(documentRef, 'maid-settings-action', '复制');
    setIconButtonContent(copyPromptBtn, ICONS.copy, '复制');
    copyPromptBtn.addEventListener?.('click', () => void copyCurrentText('prompt'));
    statusEl = documentRef.createElement?.('div');
    statusEl.className = 'maid-settings-status';
    promptFooter.append(statusEl, copyPromptBtn, saveBtn);
    promptField.append(promptFieldHeader, promptTextarea);
    personaPane.append(promptField, promptFooter);

    const appKnowledgePane = documentRef.createElement?.('div');
    appKnowledgePane.className = 'maid-settings-prompt-pane';
    const appKnowledgeSplit = documentRef.createElement?.('div');
    appKnowledgeSplit.className = 'maid-settings-split';
    const appKnowledgeField = documentRef.createElement?.('div');
    appKnowledgeField.className = 'maid-settings-field';
    const appKnowledgeLabel = documentRef.createElement?.('div');
    appKnowledgeLabel.className = 'maid-settings-label';
    appKnowledgeLabel.textContent = 'APP知识';
    appKnowledgeTextarea = createTextarea(documentRef, { readOnly: true });
    appKnowledgeField.append(appKnowledgeLabel, appKnowledgeTextarea);
    const lastContextField = documentRef.createElement?.('div');
    lastContextField.className = 'maid-settings-field';
    const lastContextLabel = documentRef.createElement?.('div');
    lastContextLabel.className = 'maid-settings-label';
    lastContextLabel.textContent = '本次检索';
    lastAppContextTextarea = createTextarea(documentRef, { readOnly: true });
    lastContextField.append(lastContextLabel, lastAppContextTextarea);
    appKnowledgeSplit.append(appKnowledgeField, lastContextField);
    appKnowledgePane.append(appKnowledgeSplit);

    const historyContextPane = documentRef.createElement?.('div');
    historyContextPane.className = 'maid-settings-prompt-pane';
    const historyContextField = documentRef.createElement?.('div');
    historyContextField.className = 'maid-settings-field';
    const historyContextLabel = documentRef.createElement?.('div');
    historyContextLabel.className = 'maid-settings-label';
    historyContextLabel.textContent = '历史上下文';
    historyContextTextarea = createTextarea(documentRef, { readOnly: true });
    const historyContextFooter = documentRef.createElement?.('div');
    historyContextFooter.className = 'maid-settings-footer';
    const copyHistoryContextBtn = createButton(documentRef, 'maid-settings-action', '复制');
    setIconButtonContent(copyHistoryContextBtn, ICONS.copy, '复制');
    copyHistoryContextBtn.addEventListener?.('click', () => void copyCurrentText('historyContext'));
    historyContextFooter.appendChild(copyHistoryContextBtn);
    if (typeof clearHistoryContext === 'function') {
      const clearHistoryBtn = createButton(documentRef, 'maid-memory-delete', '清除历史');
      clearHistoryBtn.addEventListener?.('click', () => void runMemoryClear({
        title: '清除女仆历史上下文',
        message: '将删除全部最近对话记录，女仆之后不会再参考这些对话；其中尚未整理进长期记忆的内容也会一起丢弃。长期记忆与轮次归档不受影响。此操作无法恢复。',
        action: clearHistoryContext,
        done: '历史上下文已清除',
      }));
      historyContextFooter.appendChild(clearHistoryBtn);
    }
    historyContextField.append(historyContextLabel, historyContextTextarea);
    historyContextPane.append(historyContextField, historyContextFooter);

    const semanticMemoryPane = documentRef.createElement?.('div');
    semanticMemoryPane.className = 'maid-settings-prompt-pane';
    const semanticMemoryOverview = documentRef.createElement?.('section');
    semanticMemoryOverview.className = 'maid-memory-overview';
    const semanticMemoryHead = documentRef.createElement?.('div');
    semanticMemoryHead.className = 'maid-memory-overview-head';
    const semanticMemoryMark = documentRef.createElement?.('span');
    semanticMemoryMark.className = 'maid-memory-overview-mark';
    semanticMemoryMark.innerHTML = ICONS.table;
    semanticMemoryMark.setAttribute?.('aria-hidden', 'true');
    const semanticMemoryCopy = documentRef.createElement?.('div');
    semanticMemoryCopy.className = 'maid-memory-overview-copy';
    const semanticMemoryTitleRow = documentRef.createElement?.('div');
    semanticMemoryTitleRow.className = 'maid-memory-overview-title-row';
    const semanticMemoryTitle = documentRef.createElement?.('span');
    semanticMemoryTitle.className = 'maid-memory-overview-title';
    semanticMemoryTitle.textContent = '长期记忆';
    semanticMemoryCountEl = documentRef.createElement?.('span');
    semanticMemoryCountEl.className = 'maid-memory-count';
    semanticMemoryCountEl.textContent = '0 条';
    semanticMemoryTitleRow.append(semanticMemoryTitle, semanticMemoryCountEl);
    const semanticMemoryDesc = documentRef.createElement?.('div');
    semanticMemoryDesc.className = 'maid-memory-overview-desc';
    semanticMemoryDesc.textContent = '仅保存跨任务仍有价值的偏好、决定与已验证状态；可追溯到来源轮次。';
    semanticMemoryCopy.append(semanticMemoryTitleRow, semanticMemoryDesc);
    semanticMemoryHead.append(semanticMemoryMark, semanticMemoryCopy);
    if (typeof semanticMemoryStore?.clearMemories === 'function') {
      const clearSemanticBtn = createButton(documentRef, 'maid-memory-delete maid-memory-clear-all', '清空全部');
      clearSemanticBtn.addEventListener?.('click', () => {
        const count = (semanticMemoryStore?.listMemories?.() || []).length;
        if (!count) {
          setStatus('还没有长期记忆。');
          return;
        }
        void runMemoryClear({
          title: '清空长期记忆',
          message: `将永久删除全部 ${count} 条长期记忆（包括已归档的）。此操作无法恢复。`,
          action: () => semanticMemoryStore.clearMemories(),
          done: '长期记忆已清空',
        });
      });
      semanticMemoryHead.appendChild(clearSemanticBtn);
    }
    semanticMemoryListEl = documentRef.createElement?.('div');
    semanticMemoryListEl.className = 'maid-memory-list';
    semanticMemoryOverview.append(semanticMemoryHead, semanticMemoryListEl);
    semanticMemoryPane.appendChild(semanticMemoryOverview);

    const memoryTablePane = documentRef.createElement?.('div');
    memoryTablePane.className = 'maid-settings-prompt-pane';
    const memoryTableField = documentRef.createElement?.('div');
    memoryTableField.className = 'maid-settings-field';
    const memoryTableLabel = documentRef.createElement?.('div');
    memoryTableLabel.className = 'maid-settings-label';
    memoryTableLabel.textContent = '轮次归档';
    memoryTableTextarea = createTextarea(documentRef, { readOnly: true });
    const memoryTableFooter = documentRef.createElement?.('div');
    memoryTableFooter.className = 'maid-settings-footer';
    const copyMemoryTableBtn = createButton(documentRef, 'maid-settings-action', '复制');
    setIconButtonContent(copyMemoryTableBtn, ICONS.copy, '复制');
    copyMemoryTableBtn.addEventListener?.('click', () => void copyCurrentText('memoryTable'));
    memoryTableFooter.appendChild(copyMemoryTableBtn);
    if (typeof clearMemoryTable === 'function') {
      const clearTableBtn = createButton(documentRef, 'maid-memory-delete', '清除归档');
      clearTableBtn.addEventListener?.('click', () => void runMemoryClear({
        title: '清除轮次归档',
        message: '将删除全部轮次归档（较早对话的压缩摘要）。此操作无法恢复。',
        action: clearMemoryTable,
        done: '轮次归档已清除',
      }));
      memoryTableFooter.appendChild(clearTableBtn);
    }
    memoryTableField.append(memoryTableLabel, memoryTableTextarea);
    memoryTablePane.append(memoryTableField, memoryTableFooter);

    const lastPromptPane = documentRef.createElement?.('div');
    lastPromptPane.className = 'maid-settings-prompt-pane';
    const lastPromptField = documentRef.createElement?.('div');
    lastPromptField.className = 'maid-settings-field';
    const lastPromptLabel = documentRef.createElement?.('div');
    lastPromptLabel.className = 'maid-settings-label';
    lastPromptLabel.textContent = '本次提示词';
    lastPromptTextarea = createTextarea(documentRef, { readOnly: true });
    const lastPromptFooter = documentRef.createElement?.('div');
    lastPromptFooter.className = 'maid-settings-footer';
    const copyLastPromptBtn = createButton(documentRef, 'maid-settings-action', '复制');
    setIconButtonContent(copyLastPromptBtn, ICONS.copy, '复制');
    copyLastPromptBtn.addEventListener?.('click', () => void copyCurrentText('lastPrompt'));
    lastPromptFooter.appendChild(copyLastPromptBtn);
    lastPromptField.append(lastPromptLabel, lastPromptTextarea);
    lastPromptPane.append(lastPromptField, lastPromptFooter);

    const lastResponsePane = documentRef.createElement?.('div');
    lastResponsePane.className = 'maid-settings-prompt-pane';
    const lastResponseField = documentRef.createElement?.('div');
    lastResponseField.className = 'maid-settings-field';
    const lastResponseLabel = documentRef.createElement?.('div');
    lastResponseLabel.className = 'maid-settings-label';
    lastResponseLabel.textContent = '本次完整回复';
    lastResponseTextarea = createTextarea(documentRef, { readOnly: true });
    const lastResponseFooter = documentRef.createElement?.('div');
    lastResponseFooter.className = 'maid-settings-footer';
    const copyLastResponseBtn = createButton(documentRef, 'maid-settings-action', '复制');
    setIconButtonContent(copyLastResponseBtn, ICONS.copy, '复制');
    copyLastResponseBtn.addEventListener?.('click', () => void copyCurrentText('lastResponse'));
    lastResponseFooter.appendChild(copyLastResponseBtn);
    lastResponseField.append(lastResponseLabel, lastResponseTextarea);
    lastResponsePane.append(lastResponseField, lastResponseFooter);
    promptPanes.set('persona', personaPane);
    promptPanes.set('appKnowledge', appKnowledgePane);
    promptPanes.set('historyContext', historyContextPane);
    promptPanes.set('semanticMemory', semanticMemoryPane);
    promptPanes.set('memoryTable', memoryTablePane);
    promptPanes.set('lastPrompt', lastPromptPane);
    promptPanes.set('lastResponse', lastResponsePane);
    promptPanes.forEach((pane, key) => {
      pane.setAttribute?.('id', `maid-settings-prompt-pane-${key}`);
      pane.setAttribute?.('role', 'tabpanel');
      pane.setAttribute?.('aria-labelledby', `maid-settings-prompt-tab-${key}`);
      pane.setAttribute?.('aria-hidden', 'true');
    });
    promptSection.append(
      promptSubtabs,
      personaPane,
      appKnowledgePane,
      historyContextPane,
      semanticMemoryPane,
      memoryTablePane,
      lastPromptPane,
      lastResponsePane,
    );

    const activitySection = documentRef.createElement?.('section');
    activitySection.className = 'maid-settings-section';
    const activityHead = documentRef.createElement?.('div');
    activityHead.className = 'maid-settings-section-head';
    const activityTitleRow = documentRef.createElement?.('div');
    activityTitleRow.className = 'maid-settings-section-title-row';
    const activityLabel = documentRef.createElement?.('div');
    activityLabel.className = 'maid-settings-section-title';
    activityLabel.textContent = '最近活动';
    runCountEl = documentRef.createElement?.('span');
    runCountEl.className = 'maid-settings-count-badge';
    runCountEl.textContent = '0';
    const activityCaption = documentRef.createElement?.('div');
    activityCaption.className = 'maid-settings-section-caption';
    const activityCaptionLabel = documentRef.createElement?.('small');
    activityCaptionLabel.textContent = 'RECENT RUNS';
    activityCaption.appendChild(activityCaptionLabel);
    activityTitleRow.append(activityLabel, runCountEl);
    activityHead.append(activityTitleRow, activityCaption);
    runListEl = documentRef.createElement?.('div');
    runListEl.className = 'maid-settings-list';
    activitySection.append(activityHead, runListEl);

    const tasksSection = documentRef.createElement?.('section');
    tasksSection.className = 'maid-settings-section';
    const tasksCaption = documentRef.createElement?.('div');
    tasksCaption.className = 'maid-settings-section-caption';
    const tasksCaptionLabel = documentRef.createElement?.('span');
    tasksCaptionLabel.textContent = '新手上路';
    const tasksCaptionCode = documentRef.createElement?.('small');
    tasksCaptionCode.textContent = 'ONBOARDING';
    tasksCaption.append(tasksCaptionLabel, tasksCaptionCode);
    const taskSummary = documentRef.createElement?.('div');
    taskSummary.className = 'maid-settings-task-summary';
    const taskSummaryCopy = documentRef.createElement?.('div');
    taskSummaryCopy.className = 'maid-settings-task-summary-copy';
    taskSummaryCopy.textContent = '新手上路 · 上手指引';
    taskProgressEl = documentRef.createElement?.('span');
    taskProgressEl.className = 'maid-settings-task-progress-text';
    taskProgressEl.textContent = `0/${Array.isArray(onboardingTasks) ? onboardingTasks.length : 0}`;
    const taskProgressTrack = documentRef.createElement?.('div');
    taskProgressTrack.className = 'maid-settings-task-progress-track';
    taskProgressBarEl = documentRef.createElement?.('div');
    taskProgressBarEl.className = 'maid-settings-task-progress-bar';
    taskProgressTrack.appendChild(taskProgressBarEl);
    taskSummary.append(taskSummaryCopy, taskProgressEl, taskProgressTrack);
    taskCompletionEl = documentRef.createElement?.('div');
    taskCompletionEl.className = 'maid-settings-task-completion';
    taskCompletionEl.setAttribute?.('aria-hidden', 'true');
    const taskCompletionIcon = documentRef.createElement?.('span');
    taskCompletionIcon.innerHTML = ICONS.trophy;
    taskCompletionIcon.setAttribute?.('aria-hidden', 'true');
    const taskCompletionText = documentRef.createElement?.('span');
    taskCompletionText.textContent = '全部课程毕业！主人已经是熟练工了';
    taskCompletionEl.append(taskCompletionIcon, taskCompletionText);
    taskListEl = documentRef.createElement?.('div');
    taskListEl.className = 'maid-settings-task-list';
    tasksSection.append(tasksCaption, taskSummary, taskCompletionEl, taskListEl);

    const safetySection = documentRef.createElement?.('section');
    safetySection.className = 'maid-settings-section';
    const safetyCaption = documentRef.createElement?.('div');
    safetyCaption.className = 'maid-settings-section-caption';
    const safetyLabel = documentRef.createElement?.('span');
    safetyLabel.textContent = '始终允许规则';
    const safetyCode = documentRef.createElement?.('small');
    safetyCode.textContent = 'ALLOWLIST';
    safetyCaption.append(safetyLabel, safetyCode);
    ruleListEl = documentRef.createElement?.('div');
    ruleListEl.className = 'maid-settings-list';
    safetySection.append(safetyCaption, ruleListEl);

    const skillSection = documentRef.createElement?.('section');
    skillSection.className = 'maid-settings-section';
    skillPanel?.mount(skillSection);
    [
      ['api', apiSection],
      ['prompt', promptSection],
      ...(skillPanel ? [['skills', skillSection]] : []),
      ['tasks', tasksSection],
      ['activity', activitySection],
      ['safety', safetySection],
    ].forEach(([key, section]) => {
      section.setAttribute?.('id', `maid-settings-section-${key}`);
      section.setAttribute?.('role', 'tabpanel');
      section.setAttribute?.('aria-labelledby', `maid-settings-tab-${key}`);
      section.setAttribute?.('aria-hidden', 'true');
      sections.set(key, section);
      body.appendChild(section);
    });

    panel.append(header, tabs, body);
    overlay.appendChild(panel);
    documentRef.body.appendChild(overlay);
    return overlay;
  };

  const show = ({ tab = 'api' } = {}) => {
    const el = ensure();
    if (!el) return false;
    isOpen = true;
    refresh();
    switchTab(tab);
    el.classList.add('is-open');
    el.setAttribute?.('aria-hidden', 'false');
    return true;
  };

  const hide = (approved = false) => {
    if (!approved && skillPanel?.isDirty()) return skillPanel.beforeLeave().then(ok => ok && hide(true));
    isOpen = false;
    overlay?.classList.remove('is-open');
    overlay?.setAttribute?.('aria-hidden', 'true');
    setStatus('');
    return true;
  };

  return {
    show,
    hide,
    refresh,
    switchTab,
    isOpen: () => isOpen,
    getElements: () => ({
      overlay,
      panel,
      promptTextarea,
      appKnowledgeTextarea,
      historyContextTextarea,
      semanticMemoryListEl,
      semanticMemoryCountEl,
      memoryTableTextarea,
      lastAppContextTextarea,
      lastPromptTextarea,
      lastResponseTextarea,
      statusEl,
      runListEl,
      runCountEl,
      ruleListEl,
      taskListEl,
      taskProgressEl,
      taskProgressBarEl,
      taskCompletionEl,
      promptCountEl,
      tabButtons,
      sections,
      promptTabButtons,
      promptPanes,
    }),
  };
};
