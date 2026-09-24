import { appSettings } from '../storage/app-settings.js';
import { themeStore, normalizeAppearance, normalizeThemePreset } from '../storage/theme-store.js';
import { resolveRpDialogueTextColor } from './theme-dialogue-color-utils.js';
import { createThemeDarkRulePruner } from './theme-dark-rule-pruner.js';

const themeDarkRulePruner = createThemeDarkRulePruner();

export const THEME_AVATAR_STYLE_OPTIONS = Object.freeze([
  { value: 'system', label: '跟随原样' },
  { value: 'rounded', label: '圆角卡片' },
  { value: 'round', label: '圆形' },
  { value: 'rectangular', label: '大圆角矩形' },
  { value: 'square', label: '方角' },
]);

export const THEME_CHAT_DISPLAY_OPTIONS = Object.freeze([
  { value: 'default', label: '默认' },
  { value: 'bubble', label: '气泡' },
  { value: 'document', label: '文档' },
]);

export const THEME_TOAST_POSITION_OPTIONS = Object.freeze([
  { value: 'toast-top-right', label: '右上' },
  { value: 'toast-top-center', label: '顶部居中' },
  { value: 'toast-bottom-right', label: '右下' },
  { value: 'toast-bottom-center', label: '底部居中' },
]);

const clamp = (value, min, max, fallback) => {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
};

const clone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
};

const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const dispatchSettingsPatch = (patch = {}) => {
  Object.entries(patch).forEach(([key, value]) => {
    window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value } }));
  });
};

const sanitizeExportName = (value, fallback = 'theme') => {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, '_');
  return cleaned || fallback;
};

const prefersDark = (theme = {}) => String(theme?.mode || '').trim().toLowerCase() === 'dark';

const alphaFromRgba = (value, fallback = 1) => {
  const raw = String(value || '').trim();
  const match = raw.match(/rgba?\(([^)]+)\)/i);
  if (!match) return fallback;
  const parts = match[1].split(',').map((item) => item.trim());
  if (parts.length < 4) return parts.length === 3 ? 1 : fallback;
  const next = Number(parts[3]);
  return Number.isFinite(next) ? next : fallback;
};

// 把颜色（#hex / rgb() / rgba()）解析成 "r, g, b" 三元组，供 rgba(var(--x-rgb), α) 使用。
const colorToRgbTriplet = (value, fallback = '148, 163, 184') => {
  const s = String(value || '').trim();
  if (s[0] === '#') {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every(Number.isFinite)) return `${r}, ${g}, ${b}`;
    }
    return fallback;
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return `${Math.round(Number(m[1]))}, ${Math.round(Number(m[2]))}, ${Math.round(Number(m[3]))}`;
  return fallback;
};

const scaleShadow = (width, color, fallback = '0 8px 18px rgba(15, 23, 42, 0.1)') => {
  const safeWidth = clamp(width, 0, 8, 1);
  if (safeWidth <= 0) return 'none';
  const blur = Math.max(8, Math.round(safeWidth * 14));
  const spread = Math.max(1, Math.round(safeWidth * 2));
  return `0 ${spread}px ${blur}px ${String(color || '').trim() || 'rgba(15, 23, 42, 0.18)'}`;
};

const mapStAvatarStyle = (value) => {
  switch (Number(value)) {
    case 1: return 'rectangular';
    case 2: return 'square';
    case 3: return 'rounded';
    default: return 'round';
  }
};

const mapStChatDisplay = (value) => {
  switch (Number(value)) {
    case 1: return 'bubble';
    case 2: return 'document';
    default: return 'default';
  }
};

const toThemeSettingsPatch = (preset = {}) => {
  const appearance = normalizeAppearance(preset.appearance || {});
  return {
    uiThemePresetId: String(preset.id || 'classic-dark'),
    uiThemeAvatarStyle: appearance.avatarStyle,
    uiThemeChatDisplay: appearance.chatDisplay,
    uiThemeToastrPosition: appearance.toastrPosition,
    uiThemeFontScale: appearance.fontScale,
    uiThemeReducedMotion: appearance.reducedMotion,
    uiThemeCompactInput: appearance.compactInputArea,
    uiThemeHideChatAvatars: appearance.hideChatAvatars,
  };
};

const setCssVar = (name, value) => {
  if (!document?.documentElement?.style) return;
  if (value == null || value === '') {
    document.documentElement.style.removeProperty(name);
    return;
  }
  document.documentElement.style.setProperty(name, String(value));
};

export class ThemeManager {
  constructor() {
    this.ready = false;
    this.boundSettingsListener = null;
  }

  async init() {
    if (this.ready) return;
    this.ready = true;
    await themeStore.hydrate().catch(() => {});
    this.applyCurrentTheme();
    this.boundSettingsListener = () => this.applyCurrentTheme();
    window.addEventListener('app-settings-changed', this.boundSettingsListener);
  }

  resolveCurrentTheme() {
    const settings = appSettings.get();
    const preset = themeStore.getTheme(settings.uiThemePresetId || 'classic-dark');
    const appearance = normalizeAppearance({
      avatarStyle: settings.uiThemeAvatarStyle,
      chatDisplay: settings.uiThemeChatDisplay,
      toastrPosition: settings.uiThemeToastrPosition,
      fontScale: settings.uiThemeFontScale,
      reducedMotion: settings.uiThemeReducedMotion,
      compactInputArea: settings.uiThemeCompactInput,
      hideChatAvatars: settings.uiThemeHideChatAvatars,
    }, preset.appearance || {});
    return {
      preset,
      appearance,
      mode: prefersDark(preset) ? 'dark' : 'light',
    };
  }

  applyCurrentTheme() {
    if (!document?.body) return;
    const current = this.resolveCurrentTheme();
    this.applyThemePreset(current);
  }

  applyThemePreset({ preset, appearance, mode } = {}) {
    const theme = normalizeThemePreset(preset || themeStore.getTheme('classic-dark'));
    const resolvedAppearance = normalizeAppearance(appearance || {}, theme.appearance || {});
    const nextMode = mode || (prefersDark(theme) ? 'dark' : 'light');
    const tokens = theme.tokens || {};
    const surface = tokens.surface || {};
    const text = tokens.text || {};
    const accent = tokens.accent || {};
    const border = tokens.border || {};
    const bubble = tokens.bubble || {};
    const shadow = tokens.shadow || {};
    const radius = tokens.radius || {};
    const tint = tokens.tint || {};

    setCssVar('--app-surface-page', surface.page);
    setCssVar('--app-surface-page-alt', surface.pageAlt || surface.page);
    setCssVar('--app-surface-card', surface.card);
    setCssVar('--app-surface-panel', surface.panel || surface.card);
    setCssVar('--app-surface-topbar', surface.topbar || surface.panel || surface.card);
    setCssVar('--app-surface-input', surface.input || surface.card);
    setCssVar('--app-surface-overlay', surface.overlay);
    setCssVar('--app-surface-subtle', surface.subtle || surface.card);
    setCssVar('--app-surface-hover', surface.hover || surface.panel || surface.card);

    setCssVar('--app-text-primary', text.primary);
    setCssVar('--app-text-secondary', text.secondary);
    setCssVar('--app-text-muted', text.muted);
    setCssVar('--app-text-inverse', text.inverse);
    setCssVar('--app-text-quote', text.quote);
    setCssVar('--app-text-link', text.link);
    setCssVar('--app-rp-dialogue-text', resolveRpDialogueTextColor(tokens, { mode: nextMode }).color);

    setCssVar('--app-accent-primary', accent.primary);
    setCssVar('--app-accent-strong', accent.strong || accent.primary);
    setCssVar('--app-accent-soft', accent.soft || accent.primary);

    // 派生 RGB 三元组：深色规则用 rgba(var(--x-rgb), α) 铺各 alpha 微调；作者只需设 hex，tint 自动跟随。
    setCssVar('--app-accent-rgb', colorToRgbTriplet(accent.primary, '121, 192, 255'));
    setCssVar('--app-text-muted-rgb', colorToRgbTriplet(text.muted, '139, 152, 167'));
    setCssVar('--app-tint-neutral-rgb', colorToRgbTriplet(tint.neutral, '205, 217, 229'));
    setCssVar('--app-tint-slate-rgb', colorToRgbTriplet(tint.slate, '148, 163, 184'));
    setCssVar('--app-surface-topbar-rgb', colorToRgbTriplet(surface.topbar || surface.panel, '26, 30, 36'));
    setCssVar('--app-surface-elevated-rgb', colorToRgbTriplet(surface.elevated || surface.card, '34, 39, 46'));

    // 语义状态色（可覆盖，默认标准）：fill 派生 rgb 供微调，text 为深色上可读文字实色。
    const status = tokens.status || {};
    setCssVar('--app-danger-rgb', colorToRgbTriplet(status.danger, '248, 81, 73'));
    setCssVar('--app-danger-text-strong', status.dangerStrong || '#ffb4aa');
    setCssVar('--app-warning-rgb', colorToRgbTriplet(status.warning, '251, 191, 36'));
    setCssVar('--app-warning-text', status.warningText || '#fcd34d');
    setCssVar('--app-success-rgb', colorToRgbTriplet(status.success, '46, 160, 67'));
    setCssVar('--app-success-text', status.successText || '#7ee787');
    setCssVar('--app-info-rgb', colorToRgbTriplet(status.info, '59, 130, 246'));
    setCssVar('--app-info-text', status.infoText || '#8ecbff');
    setCssVar('--app-task-rgb', colorToRgbTriplet(status.task, '139, 92, 246'));

    setCssVar('--app-border-subtle', border.subtle);
    setCssVar('--app-border-default', border.default || border.subtle);
    setCssVar('--app-border-strong', border.strong || border.default || border.subtle);

    setCssVar('--app-bubble-user', bubble.user);
    setCssVar('--app-bubble-assistant', bubble.assistant);
    setCssVar('--app-bubble-assistant-alt', bubble.assistantAlt || bubble.assistant);
    setCssVar('--app-bubble-meta', bubble.meta || surface.card);

    setCssVar('--app-shadow-sm', shadow.sm);
    setCssVar('--app-shadow-md', shadow.md);
    setCssVar('--app-shadow-bubble', shadow.bubble);
    setCssVar('--app-shadow-color', shadow.color);

    setCssVar('--app-radius-sm', radius.sm);
    setCssVar('--app-radius-md', radius.md);
    setCssVar('--app-radius-lg', radius.lg);
    setCssVar('--app-radius-pill', radius.pill);

    setCssVar('--app-font-scale', String(resolvedAppearance.fontScale || 1));

    setCssVar('--qq-color-bg-page', surface.page);
    setCssVar('--qq-color-bg-input', surface.input || surface.card);
    setCssVar('--qq-color-bubble-default', bubble.assistantAlt || bubble.assistant);
    setCssVar('--qq-color-bubble-alt', bubble.user);
    setCssVar('--qq-color-text-primary', text.primary);
    setCssVar('--qq-color-text-secondary', text.secondary);
    setCssVar('--qq-color-border', border.strong || border.default || border.subtle);
    setCssVar('--qq-color-divider', border.subtle);
    setCssVar('--qq-color-primary', accent.primary);
    setCssVar('--qq-color-status-bg', surface.card);
    setCssVar('--qq-shadow-bubble', shadow.bubble);
    setCssVar('--qq-shadow-sm', shadow.sm);
    setCssVar('--qq-shadow-md', shadow.md);
    setCssVar('--qq-font-size-base', `calc(15px * ${resolvedAppearance.fontScale || 1})`);

    setCssVar('--bg-gradient-start', surface.page);
    setCssVar('--bg-gradient-end', surface.pageAlt || surface.page);
    setCssVar('--accent', accent.primary);
    setCssVar('--accent-strong', accent.strong || accent.primary);
    setCssVar('--bubble-user', bubble.user);
    setCssVar('--bubble-assistant', bubble.assistant);
    setCssVar('--bubble-shadow', shadow.color || shadow.bubble);
    setCssVar('--text-primary', text.primary);
    setCssVar('--text-secondary', text.secondary);
    setCssVar('--border-subtle', border.subtle);

    const body = document.body;
    // 暗色专属规则：浅色下移除以省去每次样式重算的匹配成本，切到暗色前先按原位放回
    themeDarkRulePruner.sync(nextMode);
    body.dataset.themeMode = nextMode;
    body.dataset.themePreset = String(theme.id || 'classic-dark');
    if (resolvedAppearance.avatarStyle && resolvedAppearance.avatarStyle !== 'system') {
      body.dataset.avatarStyle = resolvedAppearance.avatarStyle;
    } else {
      delete body.dataset.avatarStyle;
    }
    if (resolvedAppearance.chatDisplay && resolvedAppearance.chatDisplay !== 'default') {
      body.dataset.chatDisplay = resolvedAppearance.chatDisplay;
    } else {
      delete body.dataset.chatDisplay;
    }
    if (resolvedAppearance.compactInputArea) body.dataset.compactInput = 'on';
    else delete body.dataset.compactInput;
    if (resolvedAppearance.reducedMotion) body.dataset.reducedMotion = 'on';
    else delete body.dataset.reducedMotion;
    if (resolvedAppearance.hideChatAvatars) body.dataset.hideChatAvatars = 'on';
    else delete body.dataset.hideChatAvatars;
    if (Math.abs(Number(resolvedAppearance.fontScale || 1) - 1) > 0.001) {
      body.dataset.fontScale = 'custom';
    } else {
      delete body.dataset.fontScale;
    }
    body.style.colorScheme = nextMode;

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', String(surface.topbar || surface.page || '#000000'));
    }

    const toastrOptions = window.toastr?.options || (window.toastr ? (window.toastr.options = {}) : null);
    if (toastrOptions) {
      toastrOptions.positionClass = resolvedAppearance.toastrPosition || 'toast-top-right';
      toastrOptions.preventDuplicates = true;
      toastrOptions.progressBar = true;
      toastrOptions.timeOut = 4000;
      const _trivialToastRe = /^(网[络路]已[连連]接|.*保存成功.*|已保存|已删除.*|已停用.*|已开启.*|已加载.*|已重命名|设置已保存|连接成功|Key 已保存.*)$/;
      toastrOptions.onclick = function (e) {
        const el = e.currentTarget;
        if (!el || el.dataset.toastClicked) return;
        el.dataset.toastClicked = '1';
        el.style.pointerEvents = 'none';
        const msg = el?.querySelector?.('.toast-message')?.textContent?.trim() || '';
        const title = el?.querySelector?.('.toast-title')?.textContent?.trim() || '';
        const text = title ? `${title}\n${msg}` : msg;
        if (text && !_trivialToastRe.test(msg)) {
          navigator.clipboard?.writeText(text).catch(() => {});
        }
      };
    }
    const toastContainer = document.getElementById('toast-container');
    if (toastContainer) {
      toastContainer.className = resolvedAppearance.toastrPosition || 'toast-top-right';
    }
  }

  async activateThemeById(id, { syncAppearance = true } = {}) {
    const preset = themeStore.getTheme(id);
    const patch = syncAppearance
      ? toThemeSettingsPatch(preset)
      : { uiThemePresetId: String(preset.id || 'classic-dark') };
    appSettings.update(patch);
    dispatchSettingsPatch(patch);
    this.applyCurrentTheme();
    return preset;
  }

  buildCurrentExport() {
    const current = this.resolveCurrentTheme();
    return themeStore.buildExportPreset(current.preset, current.appearance);
  }

  async importThemeObject(rawTheme) {
    let preset = null;
    if (this.looksLikeSillyTavernTheme(rawTheme)) {
      preset = this.convertStThemeToAppTheme(rawTheme);
    } else {
      preset = normalizeThemePreset(rawTheme);
    }
    const saved = await themeStore.saveTheme(preset);
    await this.activateThemeById(saved.id, { syncAppearance: true });
    return saved;
  }

  looksLikeSillyTavernTheme(input) {
    if (!isObj(input)) return false;
    return (
      'main_text_color' in input ||
      'blur_tint_color' in input ||
      'chat_tint_color' in input ||
      'avatar_style' in input ||
      'chat_display' in input
    );
  }

  convertStThemeToAppTheme(stTheme = {}) {
    const baseMode = String(stTheme?.main_text_color || '').includes('235')
      || String(stTheme?.blur_tint_color || '').includes('rgba(34')
      || alphaFromRgba(stTheme?.blur_tint_color, 1) > 0.5
      ? 'dark'
      : 'light';
    const shadowColor = String(stTheme.shadow_color || (baseMode === 'dark'
      ? 'rgba(0, 0, 0, 0.34)'
      : 'rgba(15, 23, 42, 0.18)'));
    const shadowWidth = clamp(stTheme.shadow_width, 0, 8, 1);
    return normalizeThemePreset({
      id: '',
      name: String(stTheme.name || 'Imported ST Theme').trim() || 'Imported ST Theme',
      source: 'sillytavern',
      mode: baseMode === 'dark' ? 'dark' : 'light',
      tokens: {
        surface: {
          page: stTheme.blur_tint_color || (baseMode === 'dark' ? '#1b1f24' : '#f4f5f6'),
          pageAlt: stTheme.chat_tint_color || stTheme.blur_tint_color || (baseMode === 'dark' ? '#22272e' : '#e6e9f0'),
          card: stTheme.chat_tint_color || (baseMode === 'dark' ? 'rgba(34, 39, 46, 0.96)' : 'rgba(255, 255, 255, 0.96)'),
          panel: stTheme.chat_tint_color || stTheme.blur_tint_color || (baseMode === 'dark' ? 'rgba(45, 51, 59, 0.94)' : 'rgba(255, 255, 255, 0.92)'),
          topbar: stTheme.blur_tint_color || (baseMode === 'dark' ? 'rgba(27, 31, 36, 0.94)' : 'rgba(255, 255, 255, 0.92)'),
          input: stTheme.blur_tint_color || (baseMode === 'dark' ? 'rgba(34, 39, 46, 0.96)' : 'rgba(255, 255, 255, 0.92)'),
          overlay: baseMode === 'dark' ? 'rgba(7, 10, 15, 0.74)' : 'rgba(15, 23, 42, 0.42)',
        },
        text: {
          primary: stTheme.main_text_color || (baseMode === 'dark' ? '#e6edf3' : '#0f172a'),
          secondary: stTheme.italics_text_color || (baseMode === 'dark' ? '#adbac7' : '#475569'),
          muted: stTheme.underline_text_color || (baseMode === 'dark' ? '#768390' : '#94a3b8'),
          inverse: baseMode === 'dark' ? '#161b22' : '#ffffff',
          quote: stTheme.quote_text_color || stTheme.italics_text_color || (baseMode === 'dark' ? '#9da7b3' : '#475569'),
          link: baseMode === 'dark' ? '#7ab7ff' : '#2563eb',
        },
        accent: {
          primary: baseMode === 'dark' ? '#6cb6ff' : '#199aff',
          strong: baseMode === 'dark' ? '#539bf5' : '#0b66c2',
          soft: baseMode === 'dark' ? 'rgba(83, 155, 245, 0.18)' : 'rgba(25, 154, 255, 0.14)',
        },
        border: {
          subtle: stTheme.border_color || (baseMode === 'dark' ? 'rgba(205, 217, 229, 0.1)' : 'rgba(15, 23, 42, 0.08)'),
          default: stTheme.border_color || (baseMode === 'dark' ? 'rgba(68, 76, 86, 0.9)' : 'rgba(148, 163, 184, 0.32)'),
          strong: stTheme.border_color || (baseMode === 'dark' ? 'rgba(118, 131, 144, 0.92)' : 'rgba(15, 23, 42, 0.16)'),
        },
        bubble: {
          user: stTheme.user_mes_blur_tint_color || (baseMode === 'dark' ? '#316dca' : '#199aff'),
          assistant: stTheme.bot_mes_blur_tint_color || (baseMode === 'dark' ? 'rgba(34, 39, 46, 0.98)' : '#ffffff'),
          assistantAlt: stTheme.bot_mes_blur_tint_color || (baseMode === 'dark' ? 'rgba(45, 51, 59, 0.98)' : '#c9c9c9'),
          meta: stTheme.chat_tint_color || (baseMode === 'dark' ? 'rgba(34, 39, 46, 0.78)' : 'rgba(255, 255, 255, 0.76)'),
        },
        shadow: {
          sm: stTheme.noShadows ? 'none' : scaleShadow(Math.max(1, shadowWidth * 0.75), shadowColor),
          md: stTheme.noShadows ? 'none' : scaleShadow(Math.max(1, shadowWidth * 1.25), shadowColor),
          bubble: stTheme.noShadows ? 'none' : scaleShadow(Math.max(1, shadowWidth), shadowColor),
          color: shadowColor,
        },
        radius: {
          sm: '8px',
          md: '12px',
          lg: '18px',
          pill: '999px',
          avatar: mapStAvatarStyle(stTheme.avatar_style) === 'round' ? '50%' : '18px',
        },
      },
      appearance: {
        avatarStyle: mapStAvatarStyle(stTheme.avatar_style),
        chatDisplay: mapStChatDisplay(stTheme.chat_display),
        toastrPosition: String(stTheme.toastr_position || 'toast-top-right'),
        fontScale: clamp(stTheme.font_scale, 0.85, 1.35, 1),
        reducedMotion: stTheme.reduced_motion === true,
        compactInputArea: stTheme.compact_input_area === true,
        hideChatAvatars: stTheme.hideChatAvatars_enabled === true,
      },
      meta: {
        importedFrom: 'sillytavern',
      },
    });
  }

  getExportFileName() {
    const theme = this.buildCurrentExport();
    return `${sanitizeExportName(theme?.name, 'theme')}.json`;
  }
}

export const themeManager = new ThemeManager();
