/**
 * 宏处理引擎 (Macro Engine)
 * 兼容 SillyTavern 部分常用宏指令，用于在发送 Prompt 前处理变量和逻辑
 */

import { logger } from './logger.js';

const VARIABLE_MACRO_COMMANDS = new Set([
    'setvar', 'addvar', 'incvar', 'decvar', 'getvar', 'var', 'ifvar',
    'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'getglobalvar',
]);
const VARIABLE_MACRO_HEAD_RE = /^\s*(?:setvar|addvar|incvar|decvar|getvar|var|ifvar|setglobalvar|addglobalvar|incglobalvar|decglobalvar|getglobalvar)\s*::/i;

export const stripPausedVariableMacros = (value = '') => {
    const text = String(value || '');
    if (!text.includes('{{')) return text;
    const stack = [];
    const ranges = [];
    for (let index = 0; index < text.length - 1; index += 1) {
        const pair = text.slice(index, index + 2);
        if (pair === '{{') {
            stack.push(index);
            index += 1;
            continue;
        }
        if (pair !== '}}' || !stack.length) continue;
        const start = stack.pop();
        const body = text.slice(start + 2, index).replace(/：：/g, '::');
        if (VARIABLE_MACRO_HEAD_RE.test(body)) ranges.push([start, index + 2]);
        index += 1;
    }
    if (!ranges.length) return text;
    ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const merged = [];
    ranges.forEach(([start, end]) => {
        const previous = merged[merged.length - 1];
        if (previous && start <= previous[1]) {
            previous[1] = Math.max(previous[1], end);
            return;
        }
        merged.push([start, end]);
    });
    let cursor = 0;
    let output = '';
    merged.forEach(([start, end]) => {
        output += text.slice(cursor, start);
        cursor = end;
    });
    return output + text.slice(cursor);
};

// {{// 注释}} 整段去掉。注释里夹的宏（如 {{user}}）按成对的 {{ }} 算在注释里，不会让注释在第一个 }} 就结束、
// 后半段漏进提示词。注释里有落单的 {{ 导致配不成对时，退回旧规则删到第一个 }}；没有闭合就照原样保留。
export const stripCommentMacros = (value = '', replace = () => '') => {
    const text = String(value ?? '');
    if (!text.includes('{{//')) return text;
    let out = '';
    let index = 0;
    while (index < text.length) {
        const start = text.indexOf('{{//', index);
        if (start < 0) {
            out += text.slice(index);
            break;
        }
        out += text.slice(index, start);
        let depth = 1;
        let cursor = start + 4;
        while (cursor < text.length && depth > 0) {
            if (text.startsWith('{{', cursor)) {
                depth += 1;
                cursor += 2;
            } else if (text.startsWith('}}', cursor)) {
                depth -= 1;
                cursor += 2;
            } else {
                cursor += 1;
            }
        }
        if (depth > 0) {
            const close = text.indexOf('}}', start + 4);
            if (close < 0) {
                out += text.slice(start);
                break;
            }
            cursor = close + 2;
        }
        out += replace(text.slice(start, cursor));
        index = cursor;
    }
    return out;
};

export class MacroEngine {
    constructor(chatStore) {
        this.chatStore = chatStore;
    }

    normalizeSeparators(text) {
        // Normalize full-width colons used in some IME inputs: ：：
        return String(text || '').replace(/：：/g, '::');
    }

    normalizeMacroValue(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        // Support { name: '...' } pattern (user/char objects)
        if (typeof value === 'object' && typeof value.name === 'string') return value.name;
        return '';
    }

    postProcessMacroValue(value, context) {
        const normalized = value === null || value === undefined ? '' : String(value);
        const postProcess = context?.macroPostProcess;
        if (typeof postProcess !== 'function') return normalized;
        const result = postProcess(normalized);
        return result === null || result === undefined ? '' : String(result);
    }

    getSessionId(context) {
        return String(context?.sessionId || 'default').trim() || 'default';
    }

    getVariableAccess(context, { useGlobal = false, fallbackToGlobal = false } = {}) {
        const sessionId = this.getSessionId(context);
        const simulated = context?.macroVariableState instanceof Map
            ? context.macroVariableState
            : null;
        const stateKey = key => `${useGlobal ? 'global' : `session:${sessionId}`}\u0000${String(key ?? '')}`;
        const readStore = (key) => {
            if (useGlobal) return this.chatStore?.getGlobalVariable?.(key);
            const value = this.chatStore?.getVariable?.(key, sessionId);
            return value == null && fallbackToGlobal ? this.chatStore?.getGlobalVariable?.(key) : value;
        };
        const writeStore = (key, value) => (
            useGlobal
                ? this.chatStore?.setGlobalVariable?.(key, value)
                : this.chatStore?.setVariable?.(key, value, sessionId)
        );
        return {
            get: (key) => {
                if (!simulated) return readStore(key);
                const scopedKey = stateKey(key);
                if (!simulated.has(scopedKey)) simulated.set(scopedKey, readStore(key));
                return simulated.get(scopedKey);
            },
            set: (key, value) => {
                if (!simulated) return writeStore(key, value);
                context?.onMacroVariableWrite?.(useGlobal ? 'global' : 'local', key);
                simulated.set(stateKey(key), value);
                return value;
            },
        };
    }

    getLastByRole(role, sessionId) {
        try {
            const msgs = this.chatStore?.getMessages?.(sessionId) || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (!m) continue;
                if (String(m.role || '') !== role) continue;
                return this.getMessageText(m);
            }
        } catch {}
        return '';
    }

    getLastIdByRole(role, sessionId) {
        try {
            const msgs = this.chatStore?.getMessages?.(sessionId) || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (!m) continue;
                if (role && String(m.role || '') !== role) continue;
                return String(i);
            }
        } catch {}
        return '';
    }

    getMessageText(message) {
        if (!message || typeof message !== 'object') return '';
        if (Array.isArray(message.content)) {
            return message.content
                .map(part => (part?.type === 'text' ? String(part.text || '') : ''))
                .filter(Boolean)
                .join('\n');
        }
        return String(message.rawOriginal || message.rawSource || message.raw || message.content || message.mes || message.message || '');
    }

    getLastMessage(sessionId) {
        try {
            const msgs = this.chatStore?.getMessages?.(sessionId) || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (!m) continue;
                const raw = this.getMessageText(m);
                if (raw) return raw;
            }
        } catch {}
        return '';
    }

    formatIsoDate(d = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    formatIsoTime(d = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    applyVariableMacros(text, context) {
        if (context?.variableRuntimeEnabled === false) {
            return stripPausedVariableMacros(text);
        }
        // 共享变量会话由调用方传 useGlobalVariables（与世界书条件、EJS、脚本一致），其余读写这个聊天的变量。
        // 旧版写作模式一律用全局，之前存进全局的值：聊天里没有这个变量时退回读全局。
        const useGlobal = context?.useGlobalVariables === true;
        const fallbackToGlobal = !useGlobal && String(context?.uiMode || '').trim().toLowerCase() === 'rp';
        const variableAccess = this.getVariableAccess(context, { useGlobal, fallbackToGlobal });
        const getVar = key => variableAccess.get(key);
        const setVar = (key, value) => variableAccess.set(key, value);
        const finish = value => this.postProcessMacroValue(value, context);
        let out = String(text || '');
        const overrideLastUserMessage = (() => {
            const v = context?.lastUserMessage;
            const s = (typeof v === 'string') ? v : '';
            return s.trim() ? s : '';
        })();

        // 酒馆新宏引擎可嵌套、内层先算：变量宏只匹配不含 {{ 的最内层，
        // 外层（如 {{setvar::名称::…{{random::…}}…}}）等内层在本轮算完，下一轮再整段匹配
        // Replace {{setvar::name::value}} with empty string and set local variable
        out = out.replace(/{{\s*setvar\s*::((?:(?!\{\{)[^:}])+)::((?:(?!\{\{)[^}])*)}}/gi, (_m, name, value) => {
            const key = String(name || '').trim();
            if (key) setVar(key, String(value ?? ''));
            return finish('');
        });
        // {{addvar::name::value}} - numeric add when possible
        out = out.replace(/{{\s*addvar\s*::((?:(?!\{\{)[^:}])+)::((?:(?!\{\{)[^}])*)}}/gi, (_m, name, value) => {
            const key = String(name || '').trim();
            if (!key) return '';
            const curRaw = getVar(key);
            const curNum = Number(curRaw);
            const addNum = Number(value);
            const next = (Number.isFinite(curNum) && Number.isFinite(addNum)) ? String(curNum + addNum) : `${String(curRaw ?? '')}${String(value ?? '')}`;
            setVar(key, next);
            return finish('');
        });
        // {{incvar::name}} / {{decvar::name}} return updated value
        out = out.replace(/{{\s*incvar\s*::((?:(?!\{\{)[^}])+)}}/gi, (_m, name) => {
            const key = String(name || '').trim();
            const cur = Number(getVar(key));
            const next = (Number.isFinite(cur) ? cur : 0) + 1;
            setVar(key, String(next));
            return finish(next);
        });
        out = out.replace(/{{\s*decvar\s*::((?:(?!\{\{)[^}])+)}}/gi, (_m, name) => {
            const key = String(name || '').trim();
            const cur = Number(getVar(key));
            const next = (Number.isFinite(cur) ? cur : 0) - 1;
            setVar(key, String(next));
            return finish(next);
        });
        out = out.replace(/{{\s*(?:getvar|var)\s*::((?:(?!\{\{)[^:}])+)(?:::((?:(?!\{\{)[^}])*))?}}/gi, (_m, name, fallback = '') => {
            const key = String(name || '').trim();
            const val = getVar(key);
            return finish(val === undefined || val === null ? fallback : val);
        });

        // 显式全局变量宏（ST 兼容）：无论 uiMode/useGlobalVariables 如何，始终走全局作用域
        const globalAccess = this.getVariableAccess(context, { useGlobal: true });
        const getGlobal = key => globalAccess.get(key);
        const setGlobal = (key, value) => globalAccess.set(key, value);
        out = out.replace(/{{\s*setglobalvar\s*::((?:(?!\{\{)[^:}])+)::((?:(?!\{\{)[^}])*)}}/gi, (_m, name, value) => {
            const key = String(name || '').trim();
            if (key) setGlobal(key, String(value ?? ''));
            return finish('');
        });
        out = out.replace(/{{\s*addglobalvar\s*::((?:(?!\{\{)[^:}])+)::((?:(?!\{\{)[^}])*)}}/gi, (_m, name, value) => {
            const key = String(name || '').trim();
            if (!key) return '';
            const curRaw = getGlobal(key);
            const curNum = Number(curRaw);
            const addNum = Number(value);
            const next = (Number.isFinite(curNum) && Number.isFinite(addNum)) ? String(curNum + addNum) : `${String(curRaw ?? '')}${String(value ?? '')}`;
            setGlobal(key, next);
            return finish('');
        });
        out = out.replace(/{{\s*incglobalvar\s*::((?:(?!\{\{)[^}])+)}}/gi, (_m, name) => {
            const key = String(name || '').trim();
            const cur = Number(getGlobal(key));
            const next = (Number.isFinite(cur) ? cur : 0) + 1;
            setGlobal(key, String(next));
            return finish(next);
        });
        out = out.replace(/{{\s*decglobalvar\s*::((?:(?!\{\{)[^}])+)}}/gi, (_m, name) => {
            const key = String(name || '').trim();
            const cur = Number(getGlobal(key));
            const next = (Number.isFinite(cur) ? cur : 0) - 1;
            setGlobal(key, String(next));
            return finish(next);
        });
        out = out.replace(/{{\s*getglobalvar\s*::((?:(?!\{\{)[^:}])+)(?:::((?:(?!\{\{)[^}])*))?}}/gi, (_m, name, fallback = '') => {
            const key = String(name || '').trim();
            const val = getGlobal(key);
            return finish(val === undefined || val === null ? fallback : val);
        });

        return out;
    }

    rollDice(count, sides) {
        let total = 0;
        for (let i = 0; i < count; i++) {
            total += Math.floor(Math.random() * sides) + 1;
        }
        return total;
    }

    // ST 的 {{roll}} 公式：XdY、dY、XdY±Z；只写数字视为 1dN；无效时与 ST 一样返回空
    rollDiceFormula(rawFormula) {
        let formula = String(rawFormula ?? '').trim();
        if (/^\d+$/.test(formula)) formula = `1d${formula}`;
        const match = formula.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
        if (!match) return '';
        const count = match[1] ? parseInt(match[1], 10) : 1;
        const sides = parseInt(match[2], 10);
        if (count < 1 || sides < 1) return '';
        return String(this.rollDice(count, sides) + (match[3] ? parseInt(match[3], 10) : 0));
    }

    applyBuiltInMacros(text, context, baseVars) {
        const sessionId = this.getSessionId(context);
        let out = String(text || '');
        const finish = value => this.postProcessMacroValue(value, context);
        const user = String(baseVars?.user || 'User');
        const char = String(baseVars?.char || 'Assistant');
        const overrideLastUserMessage = (() => {
            const v = context?.lastUserMessage;
            const s = (typeof v === 'string') ? v : '';
            return s.trim() ? s : '';
        })();

        // Legacy non-curly macros (ST-style)
        out = out.replace(/<USER>/gi, () => finish(user));
        out = out.replace(/<CHARIFNOTGROUP>/gi, () => finish(baseVars?.group ? String(baseVars.group) : char));
        out = out.replace(/<GROUP>/gi, () => finish(baseVars?.group ? String(baseVars.group) : ''));
        out = out.replace(/<BOT>/gi, () => finish(char));
        out = out.replace(/<CHAR>/gi, () => finish(char));

        // Also accept lower-case variants (some IME / templates use these)
        out = out.replace(/<user>/gi, () => finish(user));
        out = out.replace(/<char>/gi, () => finish(char));
        out = out.replace(/<bot>/gi, () => finish(char));

        // Common utility macros
        out = out.replace(/{{newline}}/gi, () => finish('\n'));
        out = out.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, () => finish(''));
        out = out.replace(/{{noop}}/gi, () => finish(''));
        // {{// comment}} => removed（含嵌套宏的注释也整段去掉）
        out = stripCommentMacros(out, () => finish(''));

        // Message macros (subset)
        out = out.replace(/{{lastMessage}}/gi, () => finish(this.getLastMessage(sessionId)));
        out = out.replace(/{{lastMessageId}}/gi, () => finish(this.getLastIdByRole('', sessionId)));
        // Accept a few common aliases used in templates.
        const lastUser = () => overrideLastUserMessage || this.getLastByRole('user', sessionId);
        out = out.replace(/{{lastUserMessage}}/gi, () => finish(lastUser()));
        out = out.replace(/{{userLastMessage}}/gi, () => finish(lastUser()));
        out = out.replace(/{{user_last_message}}/gi, () => finish(lastUser()));
        out = out.replace(/{{lastCharMessage}}/gi, () => finish(this.getLastByRole('assistant', sessionId)));
        out = out.replace(/{{lastUserMessageId}}/gi, () => finish(this.getLastIdByRole('user', sessionId)));
        out = out.replace(/{{lastCharMessageId}}/gi, () => finish(this.getLastIdByRole('assistant', sessionId)));

        // Time macros (subset, no moment.js dependency)
        out = out.replace(/{{time}}/gi, () => finish(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
        out = out.replace(/{{date}}/gi, () => finish(new Date().toLocaleDateString()));
        out = out.replace(/{{weekday}}/gi, () => finish(new Date().toLocaleDateString(undefined, { weekday: 'long' })));
        out = out.replace(/{{isotime}}/gi, () => finish(this.formatIsoTime(new Date())));
        out = out.replace(/{{isodate}}/gi, () => finish(this.formatIsoDate(new Date())));

        // Reverse macro: {{reverse:...}}
        out = out.replace(/{{reverse:(.+?)}}/gi, (_m, str) => finish(Array.from(String(str ?? '')).reverse().join('')));

        // Dice macro (ST): {{roll:1d6}} / {{roll 1d6}}
        out = out.replace(/{{roll[ :]([^}]+)}}/gi, (_m, formula) => finish(this.rollDiceFormula(formula)));
        // Random macro, ST 旧写法: {{random:A,B,C}}（\, 为字面逗号）；{{random::A::B}} 走下面的指令解析
        out = out.replace(/{{random\s?:(?!:)\s?([^}]+)}}/gi, (_m, listText) => {
            const list = String(listText).split(/(?<!\\),/).map(item => item.trim().replace(/\\,/g, ','));
            return finish(list[Math.floor(Math.random() * list.length)]);
        });

        return out;
    }

    /**
     * 处理文本中的宏
     * @param {string} text - 原始文本
     * @param {object} context - 上下文 { sessionId, user, char, ... }
     * @returns {string} 处理后的文本
     */
    process(text, context = {}) {
        if (!text || typeof text !== 'string') return '';
        if (!text.includes('{{') && !text.includes('<')) return text; // 快速返回

        let output = text;
        const maxPasses = 5; // 防止死循环
        let pass = 0;

        output = this.normalizeSeparators(output);

        const baseVars = {};
        // 基础变量（兼容 ST 常用 {{user}} / {{char}}）
        baseVars.user = this.normalizeMacroValue(context.user) || 'User';
        baseVars.char = this.normalizeMacroValue(context.char) || 'Assistant';

        // 允许直接传入其它简单变量：processTextMacros(text, { scenario: '...', personality: '...' })
        // （避免必须塞到 extraMacros 才能替换）
        try {
            for (const [k, v] of Object.entries(context || {})) {
                if (!k || k === 'sessionId' || k === 'user' || k === 'char' || k === 'extraMacros' || k === 'macroVariableState' || k === 'variableRuntimeEnabled' || k === 'macroPostProcess' || k === 'onMacroVariableWrite') continue;
                const normalized = this.normalizeMacroValue(v);
                baseVars[k] = normalized;
            }
        } catch {}

        // 兼容旧调用：context.extraMacros
        if (context?.extraMacros && typeof context.extraMacros === 'object') {
            for (const [k, v] of Object.entries(context.extraMacros)) {
                if (!k) continue;
                const normalized = this.normalizeMacroValue(v);
                baseVars[k] = normalized;
            }
        }

        // Case-insensitive base variable lookup (SillyTavern presets often use {{USER}}/{{CHAR}})
        const baseVarsLower = Object.create(null);
        try {
            for (const [k, v] of Object.entries(baseVars)) {
                if (!k) continue;
                baseVarsLower[String(k).toLowerCase()] = v;
            }
        } catch {}

        // 匹配 {{...}}：只取不含 {{ 的最内层，嵌套的外层留到下一轮
        const macroRegex = /\{\{((?:(?!\{\{).)*?)\}\}/g;

        while (pass < maxPasses) {
            let replacedInThisPass = false;

            // Apply built-ins + variables macros on every pass (ST ordering: pre-env macros first)
            const before = output;
            output = this.applyBuiltInMacros(output, context, baseVars);
            output = this.applyVariableMacros(output, context);
            if (output !== before) replacedInThisPass = true;

            output = output.replace(macroRegex, (match, content) => {
                const trimmed = this.normalizeSeparators(content).trim();
                const trimmedLower = trimmed.toLowerCase();

                // 1. 优先匹配基础变量 (e.g. {{user}})
                if (Object.prototype.hasOwnProperty.call(baseVars, trimmed)) {
                    replacedInThisPass = true;
                    return this.postProcessMacroValue(baseVars[trimmed], context);
                }
                if (Object.prototype.hasOwnProperty.call(baseVarsLower, trimmedLower)) {
                    replacedInThisPass = true;
                    return this.postProcessMacroValue(baseVarsLower[trimmedLower], context);
                }

                // 2. 解析指令 {{cmd::arg1::arg2}}
                const parts = trimmed.split(/::/);
                const cmd = parts[0].trim().toLowerCase();
                const rawArgs = parts.slice(1);
                const args = VARIABLE_MACRO_COMMANDS.has(cmd)
                    ? rawArgs.map(arg => String(arg || '').trim())
                    : rawArgs;

                // 如果没有参数且不是基础变量，可能是尚未定义的变量或者无效格式
                if (parts.length === 1 && !Object.prototype.hasOwnProperty.call(baseVars, trimmed) && !Object.prototype.hasOwnProperty.call(baseVarsLower, trimmedLower)) {
                    // 尝试作为 getvar 简写？ST 不支持 {{myVar}} 直接获取，必须 {{getvar::myVar}}
                    // 但为了方便，如果不是命令，我们可以保留原样
                    return match;
                }

                try {
                    const result = this.executeCommand(cmd, args, context);
                    if (result !== null) {
                        replacedInThisPass = true;
                        return this.postProcessMacroValue(result, context);
                    }
                } catch (err) {
                    logger.warn(`Macro exec failed: ${cmd}`, err);
                }
                
                // 无法处理或指令返回 null (表示不处理)，保持原样
                return match;
            });

            // 只看这一轮有没有替换：内层可能全由变量宏算完（通用正则匹配不到跨行的外层），外层要留到下一轮
            if (!replacedInThisPass) break;
            pass++;
        }

        return output;
    }

    executeCommand(cmd, args, context) {
        // executeCommand 的既有语义是本地变量；常规 set/get 宏会先由
        // applyVariableMacros 依 uiMode/useGlobalVariables 处理。
        const variableAccess = this.getVariableAccess(context, { useGlobal: false });
        const globalVariableAccess = this.getVariableAccess(context, { useGlobal: true });

        switch (cmd) {
            // --- 变量操作 ---
            case 'setvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{setvar::key::value}}
                if (args.length < 2) return '';
                const key = args[0];
                // 重新组合剩余部分，防止 value 内部还有 ::
                const val = args.slice(1).join('::'); 
                variableAccess.set(key, val);
                return ''; // setvar 消耗掉标签，输出为空
            }
            case 'var':
            case 'getvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{getvar::key::default}}
                const key = args[0];
                const def = args[1] || '';
                const val = variableAccess.get(key);
                return (val !== undefined && val !== null) ? val : def;
            }
            case 'addvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{addvar::key::value}}
                if (args.length < 2) return '';
                const key = args[0];
                const addRaw = args.slice(1).join('::');
                const curRaw = variableAccess.get(key);
                const curNum = Number(curRaw);
                const addNum = Number(addRaw);
                const next = (Number.isFinite(curNum) && Number.isFinite(addNum)) ? String(curNum + addNum) : `${String(curRaw ?? '')}${String(addRaw ?? '')}`;
                variableAccess.set(key, next);
                return '';
            }
            case 'incvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{incvar::key::amount}}
                const key = args[0];
                const amt = Number(args[1]) || 1;
                let val = Number(variableAccess.get(key)) || 0;
                val += amt;
                variableAccess.set(key, val);
                return '';
            }
            case 'decvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{decvar::key::amount}}
                const key = args[0];
                const amt = Number(args[1]) || 1;
                let val = Number(variableAccess.get(key)) || 0;
                val -= amt;
                variableAccess.set(key, val);
                return '';
            }
            case 'setglobalvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{setglobalvar::key::value}}
                if (args.length < 2) return '';
                const key = args[0];
                const val = args.slice(1).join('::');
                globalVariableAccess.set(key, val);
                return '';
            }
            case 'getglobalvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{getglobalvar::key::default}}
                const key = args[0];
                const def = args[1] || '';
                const val = globalVariableAccess.get(key);
                return (val !== undefined && val !== null) ? val : def;
            }
            case 'addglobalvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{addglobalvar::key::value}}
                if (args.length < 2) return '';
                const key = args[0];
                const addRaw = args.slice(1).join('::');
                const curRaw = globalVariableAccess.get(key);
                const curNum = Number(curRaw);
                const addNum = Number(addRaw);
                const next = (Number.isFinite(curNum) && Number.isFinite(addNum)) ? String(curNum + addNum) : `${String(curRaw ?? '')}${String(addRaw ?? '')}`;
                globalVariableAccess.set(key, next);
                return '';
            }
            case 'incglobalvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{incglobalvar::key::amount}}
                const key = args[0];
                const amt = Number(args[1]) || 1;
                let val = Number(globalVariableAccess.get(key)) || 0;
                val += amt;
                globalVariableAccess.set(key, val);
                return '';
            }
            case 'decglobalvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{decglobalvar::key::amount}}
                const key = args[0];
                const amt = Number(args[1]) || 1;
                let val = Number(globalVariableAccess.get(key)) || 0;
                val -= amt;
                globalVariableAccess.set(key, val);
                return '';
            }

            // --- 随机/工具 ---
            case 'random': {
                // {{random::A::B::C}}
                if (args.length === 0) return '';
                const idx = Math.floor(Math.random() * args.length);
                return args[idx];
            }
            case 'dice': {
                // {{dice::1d20}}
                const match = (args[0] || '').match(/^(\d+)d(\d+)$/i);
                if (!match) return args[0] || '';
                const count = parseInt(match[1]);
                const sides = parseInt(match[2]);
                return String(this.rollDice(count, sides));
            }
            case 'time':
                return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            case 'date':
                return new Date().toLocaleDateString();
            
            // --- 逻辑控制 (简易版) ---
            case 'ifvar': {
                if (context?.variableRuntimeEnabled === false) return '';
                // {{ifvar::key::value::then::else}}
                if (args.length < 3) return '';
                const key = args[0];
                const checkVal = args[1];
                const thenVal = args[2] || '';
                const elseVal = args[3] || '';
                const current = String(variableAccess.get(key) || '');
                return current === checkVal ? thenVal : elseVal;
            }

            default:
                // 返回 null 表示此指令不是 macro 引擎处理的（或者拼写错误），保持原样
                return null;
        }
    }
}

export const buildMacroEngineRuntimeSource = () => [
    `const VARIABLE_MACRO_COMMANDS = new Set(${JSON.stringify(Array.from(VARIABLE_MACRO_COMMANDS))});`,
    `const VARIABLE_MACRO_HEAD_RE = ${VARIABLE_MACRO_HEAD_RE.toString()};`,
    `const stripPausedVariableMacros = ${stripPausedVariableMacros.toString()};`,
    `const stripCommentMacros = ${stripCommentMacros.toString()};`,
    'const logger = { warn: (...args) => { try { console.warn(...args); } catch {} } };',
    `const MacroEngine = ${MacroEngine.toString()};`,
].join('\n');
