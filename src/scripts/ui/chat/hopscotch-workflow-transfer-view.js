// 房子菜单「导入 / 导出」：工作流文件的导出、导入预览与结果、撤销上次导入；原来的板 JSON 收进「进阶」（只有创意写作）。
// 聊天模式没有板子：导出导入的是 Agent、内置提示词、卡片开关与相关设定。
// 复用面板的详情框与小组件（frameDetail、button 等），本模块只负责这几个画面与按钮行为。

const hintTypeLabel = (type, t) => ({ house: t('房子'), agent: 'Agent', repair_profile: t('修复档案'), setting: t('设定') })[type] || type;

export const openHopscotchWorkflowTransfer = ({
  detail, frameDetail, button, option, select, e, t, showError, confirm,
  workflowTransfer, place = 'writing', target, getDraft, isDirty, onImported, legacyBoardImport,
}) => {
  const writing = place === 'writing';
  const setStatus = (text) => {
    const el = detail.querySelector('[data-role="workflow-status"]');
    if (el) el.textContent = text;
  };
  const listBlock = (title, items) => (items.length
    ? `<div class="hop-workflow-block"><h3>${e(title)}</h3><ul>${items.map(item => `<li>${e(item)}</li>`).join('')}</ul></div>`
    : '');

  const home = async () => {
    const last = await workflowTransfer.getLastImport?.();
    const lastText = last ? t('上次导入「{name}」（{place} · {time}）', { name: last.name || t('工作流'), place: last.place === 'chat' ? t('聊天模式') : t('创意写作'), time: new Date(last.at || Date.now()).toLocaleString() }) : '';
    frameDetail(t('导入 / 导出'), `
      <p class="hop-hint">${e(writing
    ? t('把房子编排存成文件分享：包含房子、用到的 Agent、内置提示词和相关设定；不含 API 配置，模型一律改为「跟随当前」。')
    : t('把聊天的 Agent 配置存成文件分享：包含 Agent、内置提示词、卡片开关和相关设定；不含 API 配置，模型一律改为「跟随当前」。'))}</p>
      <div class="hop-workflow-block">
        <h3>${e(t('导出'))}</h3>
        <label>${e(t('工作流名称'))}<input name="workflowName" type="text" value="${e(workflowTransfer.defaultName?.(target) || t('工作流'))}"></label>
        <label class="hop-check"><input name="withPresets" type="checkbox" checked>${e(t('带上用到的预设'))}</label>
        ${button('export-workflow', t('导出为文件'))}
      </div>
      <div class="hop-workflow-block">
        <h3>${e(t('导入'))}</h3>
        ${button('import-workflow', t('从文件导入'))}
        ${last ? `<p class="hop-hint">${e(lastText)}</p>${button('undo-workflow', t('撤销这次导入'))}` : ''}
      </div>
      <p class="hop-hint" data-role="workflow-status" aria-live="polite"></p>
      ${writing ? `<details class="hop-workflow-advanced"><summary>${e(t('板 JSON（进阶）'))}</summary>
        <p class="hop-hint">${e(t('复制下方内容导出；粘贴后导入为草稿，不立即生效。'))}</p>
        <textarea name="boardJson" rows="10" data-i18n-skip="true">${e(JSON.stringify(getDraft(), null, 2))}</textarea>
        ${button('import', t('导入草稿'))}
      </details>` : ''}`);
    detail.querySelector('[data-action="import"]')?.addEventListener('click', () => legacyBoardImport(detail.querySelector('[name="boardJson"]').value));
    detail.querySelector('[data-action="export-workflow"]').onclick = async () => {
      if (writing && isDirty()) { showError(t('有未保存的修改，请先保存或撤销再导出')); return; }
      setStatus(t('正在导出…'));
      const result = await workflowTransfer.exportToFile({
        target,
        board: getDraft(),
        name: detail.querySelector('[name="workflowName"]').value,
        includePresets: detail.querySelector('[name="withPresets"]').checked,
      });
      if (result?.cancelled) { setStatus(''); return; }
      if (!result?.ok) { setStatus(''); showError(result?.message || t('导出失败')); return; }
      setStatus(t('已导出：{path}', { path: result.path || '' }));
    };
    detail.querySelector('[data-action="import-workflow"]').onclick = async () => {
      const text = await workflowTransfer.pickFile();
      if (text == null) return;
      const planned = await workflowTransfer.plan(text);
      if (!planned?.ok) { showError(planned?.message || t('无法读取工作流文件')); return; }
      preview(planned);
    };
    detail.querySelector('[data-action="undo-workflow"]')?.addEventListener('click', async () => {
      if (!await confirm({ title: t('撤销导入'), message: t('将还原上次导入前的房子编排（创意写作）、Agent、内置提示词、卡片开关和设定（导入时新建的预设会保留）。'), confirmText: t('撤销导入') })) return;
      const result = await workflowTransfer.undo();
      if (!result?.ok) { showError(result?.message || t('撤销失败')); return; }
      await onImported(target);
      await home();
      setStatus(t('已撤销上次导入'));
    });
  };

  const preview = (planned) => {
    const { plan } = planned;
    const created = plan.agents.filter(item => item.action === 'create').map(item => item.title);
    const replaced = plan.agents.filter(item => item.action === 'replace').map(item => item.title);
    const presetLine = item => (item.action === 'reuse' ? t('{name}（使用本机同名预设）', { name: item.name })
      : item.action === 'create' ? t('{name}（新建）', { name: item.name }) : t('文件里没带这个预设，改用提示词'));
    const localTarget = writing ? 'persona' : 'session';
    const chosenDefault = target === 'global' ? 'global' : localTarget;
    const onOff = value => (value ? t('开启') : t('关闭'));
    const changeCount = plan.settingsChanges.length + (plan.cardChanges || []).length;
    frameDetail(t('导入工作流「{name}」', { name: plan.name }), `
      ${select('workflowTarget', t('导入到'), option(localTarget, writing ? t('当前角色卡') : t('当前聊天'), chosenDefault) + option('global', writing ? t('所有角色卡') : t('聊天全局设置'), chosenDefault))}
      ${writing ? listBlock(t('房子（{count}）', { count: plan.houses.length }), plan.houses.map(item => item.label)) : `<p class="hop-hint">${e(t('聊天流程按设定推导，导入后由下列 Agent 与设定决定。'))}</p>`}
      ${listBlock(t('新建 Agent'), created)}
      ${listBlock(t('替换为文件里的设定'), replaced)}
      ${listBlock(t('预设'), plan.presets.map(presetLine))}
      ${listBlock(t('原本使用独立模型，导入后改为跟随当前'), plan.modelHints.map(hint => `${hintTypeLabel(hint.type, t)} · ${hint.label}${hint.model ? `（${hint.model}）` : ''}`))}
      ${listBlock(t('找不到的世界书（相关引用会显示为缺失）'), plan.missingWorldbooks)}
      ${listBlock(t('当前预设里找不到的预设条目（相关引用会显示为缺失）'), (plan.missingPromptEntries || []).map(item => `${item.agent} · ${item.entry}`))}
      ${listBlock(t('AC 卡片开关（随相关设定导入，整台设备共用）'), (plan.cardChanges || []).map(item => `${item.label}：${onOff(item.from)} → ${onOff(item.to)}`))}
      ${changeCount ? `<label class="hop-check"><input name="withSettings" type="checkbox" checked>${e(t('同时导入相关设定（{count} 项会改变，影响所有会话）', { count: changeCount }))}</label>` : ''}
      ${plan.promptProfileTypes.length ? `<label class="hop-check"><input name="withPrompts" type="checkbox" checked>${e(t('同时导入内置 Agent 提示词（套用到当前所用的预设）'))}</label>` : ''}
      <p class="hop-hint">${e(writing ? t('导入会覆盖所选范围的房子编排；导入前会自动备份，可以撤销。') : t('导入会覆盖所选范围的 Agent 配置；导入前会自动备份，可以撤销。'))}</p>`,
    `${button('confirm-workflow-import', t('确认导入'))}${button('back-workflow', t('返回'))}`);
    detail.querySelector('[data-action="back-workflow"]').onclick = () => { void home(); };
    detail.querySelector('[data-action="confirm-workflow-import"]').onclick = async () => {
      const chosen = detail.querySelector('[name="workflowTarget"]').value === 'global' ? 'global' : localTarget;
      if (writing && isDirty() && !await confirm({ title: t('未保存的修改'), message: t('当前编排有未保存的修改，导入后会被取代。'), confirmText: t('继续导入'), danger: true })) return;
      if (chosen === 'global' && !await confirm(writing
        ? { title: t('导入到所有角色卡'), message: t('会取代「所有角色卡」的编排，影响所有没有自己编排的角色卡。'), confirmText: t('继续导入') }
        : { title: t('导入到聊天全局设置'), message: t('会取代聊天全局设置里的 Agent 配置，影响所有没有自己设置的聊天。'), confirmText: t('继续导入') })) return;
      const result = await workflowTransfer.apply(planned.package, {
        target: chosen,
        includeSettings: detail.querySelector('[name="withSettings"]')?.checked !== false,
        includePromptProfiles: detail.querySelector('[name="withPrompts"]')?.checked !== false,
      });
      if (!result?.ok) { showError(result?.message || t('导入失败')); return; }
      await onImported(chosen);
      done(result.result, plan.name);
    };
  };

  const done = (report, name) => {
    frameDetail(t('已导入「{name}」', { name }), `
      ${listBlock(t('新建 Agent'), report.agentsCreated)}
      ${listBlock(t('已替换'), report.agentsReplaced)}
      ${listBlock(t('预设'), report.presets.map(item => (item.action === 'reuse' ? t('{name}（使用本机同名预设）', { name: item.name }) : t('{name}（新建）', { name: item.name }))))}
      ${listBlock(t('这些项目改为跟随当前模型，需要时请在各自的设定里重新选择'), report.modelHints.map(hint => `${hintTypeLabel(hint.type, t)} · ${hint.label}${hint.model ? `（${hint.model}）` : ''}`))}`,
    `${button('undo-workflow', t('撤销这次导入'))}${button('back-workflow', t('完成'))}`);
    detail.querySelector('[data-action="back-workflow"]').onclick = () => { void home(); };
    detail.querySelector('[data-action="undo-workflow"]').onclick = async () => {
      const result = await workflowTransfer.undo();
      if (!result?.ok) { showError(result?.message || t('撤销失败')); return; }
      await onImported(target);
      await home();
      setStatus(t('已撤销上次导入'));
    };
  };

  return home();
};
