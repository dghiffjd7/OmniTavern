// 世界书文件附带的正则集合（boundRegexSets）：按规则签名去重后导入并绑定到该世界书。
// 世界书面板的手动导入与女仆附件导入共用。

export const getWorldbookRegexRuleSignature = (rule = {}) => {
    const findRegex = String(rule?.findRegex || '').trim();
    const replaceString = String(rule?.replaceString ?? '');
    const trim = Array.isArray(rule?.trimStrings) ? rule.trimStrings.map(String).join('\n') : '';
    const placement = Array.isArray(rule?.placement)
        ? rule.placement.map(Number).filter(Number.isFinite).sort((a, b) => a - b).join(',')
        : '';
    const disabled = rule?.disabled ? '1' : '0';
    const markdownOnly = rule?.markdownOnly ? '1' : '0';
    const promptOnly = rule?.promptOnly ? '1' : '0';
    const runOnEdit = rule?.runOnEdit ? '1' : '0';
    const substituteRegex = String(Number(rule?.substituteRegex ?? 0));
    const minDepth = (rule?.minDepth === null || rule?.minDepth === undefined || rule?.minDepth === '')
        ? ''
        : String(rule.minDepth);
    const maxDepth = (rule?.maxDepth === null || rule?.maxDepth === undefined || rule?.maxDepth === '')
        ? ''
        : String(rule.maxDepth);
    if (!findRegex && !String(rule?.pattern || '').trim()) {
        const when = String(rule?.when || 'both');
        const pattern = String(rule?.pattern || '').trim();
        const flags = (rule?.flags === undefined || rule?.flags === null) ? 'g' : String(rule.flags);
        const replacement = String(rule?.replacement ?? '');
        return `${when}\u0000${pattern}\u0000${flags}\u0000${replacement}`;
    }
    return [
        findRegex, replaceString, trim, placement,
        disabled, markdownOnly, promptOnly, runOnEdit, substituteRegex, minDepth, maxDepth,
    ].join('\u0000');
};

export const collectWorldbookRegexSignaturesForWorld = (sets = [], worldId = '') => {
    const target = String(worldId || '').trim();
    const signatures = new Set();
    if (!target) return signatures;
    (Array.isArray(sets) ? sets : []).forEach((set) => {
        if (set?.bind?.type !== 'world' || String(set.bind.worldId || '').trim() !== target) return;
        (Array.isArray(set?.rules) ? set.rules : []).forEach((rule) => {
            signatures.add(getWorldbookRegexRuleSignature(rule));
        });
    });
    return signatures;
};

export const getWorldbookBoundRegexSets = json => (
    json?.boundRegexSets || json?.bound_regex_sets || json?.bound_regex_sets_v1 || null
);

// 跳过目标世界书已有或文件内重复的规则；每组以「组名 (世界书名)」新建并绑定到该世界书
export const importWorldbookBoundRegexSets = async ({
    worldId,
    boundSets = [],
    existingSets = [],
    upsertLocalSet,
} = {}) => {
    const existingSigs = collectWorldbookRegexSignaturesForWorld(existingSets, worldId);
    let importedRuleCount = 0;
    let skippedRuleCount = 0;
    const setIds = [];
    for (const s of Array.isArray(boundSets) ? boundSets : []) {
        const rulesRaw = Array.isArray(s?.rules) ? s.rules : [];
        const rules = [];
        const localSeen = new Set();
        for (const rr of rulesRaw) {
            const sig = getWorldbookRegexRuleSignature(rr);
            if (!sig || localSeen.has(sig) || existingSigs.has(sig)) {
                skippedRuleCount += 1;
                continue;
            }
            localSeen.add(sig);
            existingSigs.add(sig);
            rules.push(rr);
        }
        if (!rules.length) continue;
        const setName = String(s?.name || '正则').trim() || '正则';
        const setId = await upsertLocalSet({
            name: `${setName} (${worldId})`,
            enabled: s?.enabled !== false,
            bind: { type: 'world', worldId },
            rules,
        });
        if (setId) setIds.push(setId);
        importedRuleCount += rules.length;
    }
    return { importedRuleCount, skippedRuleCount, setIds };
};
