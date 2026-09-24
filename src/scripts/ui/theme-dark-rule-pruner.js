/* 浅色模式下不让“只在暗色下才会命中”的样式规则参与匹配。
   这类规则的每个选择器都以 body[data-theme-mode="dark"] 开头，浅色下不可能命中；
   但右侧是 :is(...) 或 [style*=] 的规则无法按类名预筛，每次样式重算仍要逐元素匹配
   （theme.css 约 578 条，dev 实测 90 条消息的聊天页整页样式重算中位数 154ms → 56ms）。

   做法：为含大量此类规则的 <link> 样式表再加载一份副本，紧贴在原表之前，副本加载后
   原地删除这些规则（只删不改写，其余规则保持浏览器原始解析结果）。浅色用副本、暗色用原表，
   切换只改 disabled，同步无闪烁。副本裁剪完成前与原表内容相同且位置相邻，不影响显示。
   不用“删掉再按 cssText 插回”：含 var() 的简写属性经 cssText 往返会丢失声明。 */

const DARK_ONLY_SELECTOR = /^body\[data-theme-mode=(["'])dark\1\](?=$|[\s>+~.:#[])/;

// 按顶层逗号拆分选择器列表（忽略括号、方括号与引号内的逗号）
export const splitSelectorList = (text = '') => {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
};

export const isDarkOnlySelectorText = (selectorText = '') => {
  const parts = splitSelectorList(String(selectorText || ''));
  return parts.length > 0 && parts.every(part => DARK_ONLY_SELECTOR.test(part));
};

const readRules = (container) => {
  try {
    return container?.cssRules || null;
  } catch {
    return null;
  }
};

const isGroupingRule = rule => typeof rule?.selectorText !== 'string'
  && Boolean(readRules(rule))
  && typeof rule.deleteRule === 'function';

export const countDarkOnlyRules = (container) => {
  const rules = readRules(container);
  if (!rules) return 0;
  let count = 0;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (typeof rule?.selectorText === 'string') count += isDarkOnlySelectorText(rule.selectorText) ? 1 : 0;
    else if (isGroupingRule(rule)) count += countDarkOnlyRules(rule);
  }
  return count;
};

// 原地删除暗色专属规则（倒序，避免下标错位）
export const removeDarkOnlyRules = (container) => {
  const rules = readRules(container);
  if (!rules) return 0;
  let removed = 0;
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if (typeof rule?.selectorText === 'string') {
      if (!isDarkOnlySelectorText(rule.selectorText)) continue;
      try {
        container.deleteRule(i);
        removed += 1;
      } catch {}
    } else if (isGroupingRule(rule)) {
      removed += removeDarkOnlyRules(rule);
    }
  }
  return removed;
};

export const createThemeDarkRulePruner = ({
  documentRef = typeof document !== 'undefined' ? document : null,
  minRules = 20,
} = {}) => {
  const pairs = [];
  let preparing = null;
  let mode = '';

  const apply = () => {
    const useLite = mode !== 'dark';
    pairs.forEach(({ original, lite }) => {
      if (!original.sheet || !lite.sheet) return;
      lite.sheet.disabled = !useLite;
      original.sheet.disabled = useLite;
    });
  };

  const prepare = () => {
    if (preparing || !documentRef?.querySelectorAll) return preparing;
    const links = Array.from(documentRef.querySelectorAll('link[rel~="stylesheet"]'))
      .filter(link => !link.dataset?.themeLite && link.sheet && countDarkOnlyRules(link.sheet) >= minRules);
    preparing = Promise.all(links.map(original => new Promise((resolve) => {
      const lite = original.cloneNode(false);
      lite.dataset.themeLite = 'on';
      lite.addEventListener('load', () => {
        removeDarkOnlyRules(lite.sheet);
        pairs.push({ original, lite });
        apply();
        resolve();
      }, { once: true });
      lite.addEventListener('error', () => {
        lite.remove();
        resolve();
      }, { once: true });
      original.before(lite);
    })));
    return preparing;
  };

  return {
    // 按主题模式切换：暗色用原表，其余用裁剪后的副本（首次调用时异步准备副本）
    sync(nextMode = '') {
      mode = String(nextMode || '');
      if (mode !== 'dark') prepare();
      apply();
      return preparing;
    },
    get pairCount() {
      return pairs.length;
    },
  };
};
