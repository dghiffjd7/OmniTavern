// 女仆附件的本地识别：只读文件内容和结构判断格式并给出摘要，不写入任何数据。
// 模型只拿到这里的摘要和附件 ID，文件原文不进入提示词。
import {
  extractCharacterCardFromPng,
  extractCharacterCardRegexScripts,
  normalizeCharacterCard,
} from '../utils/character-card.js';
import { flattenRegexImportRules, parseRegexImportData } from '../utils/regex-transfer.js';
import { extractMvuTavernHelperScripts } from './mvu-card-conversion-utils.js';
import { countScripts, extractScriptTree } from './script-tree-utils.js';
import { detectPresetJsonType } from '../utils/preset-type-detect.js';
import { CARD_ASSET_SKIP_LABELS, planCardAssetImport } from '../utils/character-card-assets.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export const ATTACHMENT_FILE_LABELS = Object.freeze({
  character_card: '角色卡',
  worldbook: '世界书',
  regex: '正则',
  script: '脚本',
  preset: '预设',
  unknown_json: '未识别的 JSON',
  invalid_json: '无法解析的 JSON',
});

// 每种格式可导入到哪里（供女仆追问目标时参考）
const IMPORT_TARGETS = Object.freeze({
  character_card: ['new_role_card'],
  worldbook: ['global', 'role_card', 'chat_room'],
  regex: ['global', 'chat_room', 'role_card_worldbook', 'worldbook'],
  script: ['global', 'role_card', 'preset'],
  preset: ['preset_library'],
});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = value => (typeof value === 'string' ? value.trim() : '');
const fileBaseName = (name = '') => String(name || '').replace(/\.[^.]+$/, '').trim();

const isPngBytes = bytes => bytes.length >= PNG_SIGNATURE.length
  && PNG_SIGNATURE.every((value, index) => bytes[index] === value);

const toExactArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

const decodeText = bytes => new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');

const isCharacterCardJson = (json) => {
  if (!isPlainObject(json)) return false;
  const spec = text(json.spec).toLowerCase();
  if (spec.startsWith('chara_card')) return true;
  const data = isPlainObject(json.data) ? json.data : null;
  const cardFields = ['first_mes', 'description', 'personality', 'scenario', 'mes_example'];
  if (data && text(data.name) && cardFields.some(key => hasOwn(data, key))) return true;
  // V1：顶层就是卡字段；排除带条目或提示词的世界书／预设
  return Boolean(text(json.name)) && cardFields.some(key => hasOwn(json, key))
    && !hasOwn(json, 'entries') && !Array.isArray(json.prompts);
};


const getWorldbookEntries = (json) => {
  if (!isPlainObject(json)) return null;
  const raw = json.entries;
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const looksLikeEntries = list.every(entry => isPlainObject(entry)
    && (hasOwn(entry, 'content') || hasOwn(entry, 'key') || hasOwn(entry, 'keys')));
  return looksLikeEntries ? list : null;
};

// 正则只认顶层结构：规则数组、单条规则或规则集合；嵌在卡／世界书里的不算独立正则文件
const looksLikeRegexRule = item => isPlainObject(item)
  && (hasOwn(item, 'findRegex') || hasOwn(item, 'find_regex')
    || (hasOwn(item, 'pattern') && (hasOwn(item, 'replaceString') || hasOwn(item, 'replace_string') || hasOwn(item, 'replacement'))));

const looksLikeRegexFile = (json) => {
  if (Array.isArray(json)) {
    return json.length > 0 && json.every(item => looksLikeRegexRule(item)
      || (isPlainObject(item) && (Array.isArray(item.rules) || Array.isArray(item.regexes) || Array.isArray(item.regex_scripts))));
  }
  if (!isPlainObject(json)) return false;
  if (looksLikeRegexRule(json)) return true;
  return ['rules', 'sets', 'regexSets', 'regex_sets', 'regex_scripts', 'regexScripts']
    .some(key => Array.isArray(json[key]) && json[key].length > 0)
    || Array.isArray(json.global?.rules);
};

const summarizeCharacterCard = (raw, { source, keyword = '' }) => {
  const card = normalizeCharacterCard(raw);
  const bookEntries = card.character_book?.entries;
  const worldbookEntries = Array.isArray(bookEntries) ? bookEntries.length
    : isPlainObject(bookEntries) ? Object.keys(bookEntries).length : 0;
  const diagnostics = [];
  const assetPlan = card.format === 'ccv3' ? planCardAssetImport(card, { container: source === 'charx' ? 'charx' : source }) : null;
  if (card.format === 'ccv3') {
    if (card.group_only_greetings?.length) diagnostics.push(`CCv3 群聊专用开场白 ${card.group_only_greetings.length} 个暂不导入`);
    if (assetPlan.skipped.length) {
      const reasons = [...new Set(assetPlan.skipped.map(item => CARD_ASSET_SKIP_LABELS[item.reason] || item.reason))];
      diagnostics.push(`CCv3 资源 ${assetPlan.skipped.length} 个暂不导入（${reasons.join('、')}）`);
    }
  }
  return {
    format: 'character_card',
    title: card.name,
    counts: {
      greetings: (card.first_mes ? 1 : 0) + card.alternate_greetings.length,
      worldbookEntries,
      regexRules: extractCharacterCardRegexScripts(card).length,
      scripts: countScripts(extractMvuTavernHelperScripts(card)),
      ...(assetPlan ? { expressions: assetPlan.sprites.length, backgrounds: assetPlan.backgrounds.length } : {}),
    },
    details: { cardVersion: card.format === 'ccv3' ? 'v3' : card.format === 'tavern_v2' ? 'v2' : 'v1', source, ...(keyword ? { pngKeyword: keyword } : {}) },
    diagnostics,
  };
};

const classifyJson = (json, { name }) => {
  if (isCharacterCardJson(json)) return [summarizeCharacterCard(json, { source: 'json' })];
  const presetType = detectPresetJsonType(json);
  if (presetType) {
    const result = { format: 'preset', title: text(json.name) || fileBaseName(name), details: { presetType },
      counts: Array.isArray(json.prompts) ? { prompts: json.prompts.length } : {}, diagnostics: [] };
    // 整套预设设定档要选覆盖或合并，只能在预设面板导入
    if (presetType === 'store') return [{ ...result, title: fileBaseName(name), targets: [], diagnostics: ['整套预设设定档需在预设面板导入（选择覆盖或合并）'] }];
    return [result];
  }
  const entries = getWorldbookEntries(json);
  if (entries) {
    const boundRegexSets = json.boundRegexSets || json.bound_regex_sets || json.bound_regex_sets_v1;
    return [{
      format: 'worldbook',
      title: text(json.name) || text(json.title) || fileBaseName(name),
      counts: { entries: entries.length, boundRegexSets: Array.isArray(boundRegexSets) ? boundRegexSets.length : 0 },
      diagnostics: entries.length ? [] : ['世界书没有条目'],
    }];
  }
  const matches = [];
  const scripts = extractScriptTree(json);
  if (scripts.length) {
    matches.push({ format: 'script', title: isPlainObject(json) ? text(json.name) || fileBaseName(name) : fileBaseName(name),
      counts: { scripts: countScripts(scripts) }, diagnostics: [] });
  }
  if (looksLikeRegexFile(json)) {
    const parsed = parseRegexImportData(json);
    const rules = flattenRegexImportRules(parsed).length;
    if (rules) {
      matches.push({ format: 'regex', title: text(parsed.name) || fileBaseName(name),
        counts: { rules, sets: parsed.sets.length }, diagnostics: [] });
    }
  }
  return matches;
};

const withTargets = result => ({ ...result, targets: result.targets || IMPORT_TARGETS[result.format] || [] });

// 输入：文件名、MIME、原始字节。输出：{ format, label, title, counts, details, diagnostics, targets, candidates }
// format 为 image 时表示普通图片（没有角色卡数据），继续走看图流程。
export const inspectAttachmentFile = ({ name = '', mime = '', bytes = null } = {}) => {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const base = { label: '', title: '', counts: {}, details: {}, diagnostics: [], targets: [], candidates: [] };
  const finish = result => ({ ...base, ...withTargets(result), label: ATTACHMENT_FILE_LABELS[result.format] || '' });
  if (isPngBytes(data)) {
    const found = extractCharacterCardFromPng(toExactArrayBuffer(data));
    return found?.json && isCharacterCardJson(found.json)
      ? finish(summarizeCharacterCard(found.json, { source: 'png', keyword: found.keyword }))
      : { ...base, format: 'image' };
  }
  if (String(mime || '').toLowerCase().startsWith('image/')) return { ...base, format: 'image' };
  // 单个 .js 文件：按一个脚本导入（脚本内容不做执行，只在导入时走兼容性预检）
  if (/\.js$/i.test(String(name || '')) || String(mime || '').toLowerCase().includes('javascript')) {
    const source = decodeText(data);
    return finish({
      format: 'script', title: fileBaseName(name), counts: { scripts: 1 }, details: { source: 'js', bytes: data.byteLength },
      diagnostics: source.trim() ? [] : ['脚本文件为空'],
    });
  }
  let json;
  try {
    json = JSON.parse(decodeText(data));
  } catch (error) {
    return finish({ format: 'invalid_json', title: fileBaseName(name),
      diagnostics: [`JSON 解析失败：${String(error?.message || error).slice(0, 160)}`] });
  }
  const matches = classifyJson(json, { name });
  if (!matches.length) return finish({ format: 'unknown_json', title: fileBaseName(name) });
  return {
    ...finish(matches[0]),
    // 同一份 JSON 同时像脚本和正则时，列出候选，由用户确认
    candidates: matches.length > 1 ? matches.map(item => item.format) : [],
  };
};
