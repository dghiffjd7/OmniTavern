// 识别 SillyTavern 预设 JSON 的类型（预设面板导入与女仆附件识别共用）。
// store 为整套预设设定档；其余对应预设库的五类预设；无法识别返回 null。
export const detectPresetJsonType = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.presets && obj.active && obj.enabled) return 'store';
    if (typeof obj.story_string === 'string') return 'context';
    if (typeof obj.content === 'string' && ('post_history' in obj)) return 'sysprompt';
    if (typeof obj.input_sequence === 'string' || typeof obj.output_sequence === 'string') return 'instruct';
    if (typeof obj.prefix === 'string' && typeof obj.suffix === 'string' && typeof obj.separator === 'string') return 'reasoning';
    if ('temperature' in obj || 'top_p' in obj || 'temp_openai' in obj || 'top_p_openai' in obj ||
        'openai_max_context' in obj || 'openai_max_tokens' in obj || 'prompts' in obj || 'prompt_order' in obj) return 'openai';
    return null;
};
