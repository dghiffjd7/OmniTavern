import { t } from '../i18n/index.js';

export const maidSkillMessage = error => {
  const code = typeof error === 'string' ? error : error?.code;
  const messages = {
    skill_invalid_title: t('标题需要 1–80 个字符'),
    skill_invalid_description: t('适用说明需要 1–1024 个字符'),
    skill_invalid_content: t('流程正文需要 1–16000 个字符'),
    skill_invalid_name: t('标识只能使用小写英文、数字和连字符，最多 64 个字符'),
    skill_invalid_features: t('最多引用 12 项功能'),
    skill_invalid_metadata: t('技能元数据格式无效'),
    skill_duplicate_name: t('这个技能标识已存在，请换一个'),
    skill_count_limit: t('最多保存 100 个自定义技能'),
    skill_storage_limit: t('技能库已达到 2 MiB 容量上限，请先导出并整理技能'),
    skill_revision_conflict: t('该技能已被修改，请保留草稿并重新载入后再保存'),
    skill_not_found: t('该技能已不存在，请重新选择'),
    skill_disabled: t('该技能已停用，请重新选择或先启用'),
    skill_selection_limit: t('一次最多选择 3 个技能'),
    skill_context_limit: t('所选技能超过本轮上下文预算，请减少选择或缩短正文'),
    skill_snapshot_unavailable: t('这次任务的技能版本已无法恢复，请重新发起任务'),
    skill_call_changed: t('通话已结束，技能选择已保留'),
    skill_store_invalid: t('技能库数据无法读取。请先备份并检查数据，再重新载入'),
    skill_yaml_invalid: t('YAML 格式无效，或包含不支持的别名、标签或嵌套'),
    skill_import_invalid_package: t('技能包格式或版本不受支持'),
    skill_import_type_unsupported: t('请选择 Markdown 或 OmniTavern 技能包'),
    skill_import_size_limit: t('一次最多导入 20 个文件、共 2 MiB；单个 Markdown 不超过 128 KiB'),
    skill_import_encoding: t('文件不是有效的 UTF-8 文本'),
    skill_import_read_failed: t('文件读取失败'),
    skill_import_empty: t('请至少选择一个要导入的技能'),
    skill_import_review_required: t('请确认仅导入流程说明，再继续导入'),
    skill_import_target_invalid: t('请选择一个有效且不重复的替换目标'),
    skill_import_ignored_fields: t('以下字段仅保留为元数据，不控制执行'),
    skill_import_commands_unsupported: t('发现动态命令语法；仅作为文字保留，不会执行'),
    skill_import_missing_resources: t('存在相对链接或资源引用；本次未导入关联文件'),
    skill_import_unknown_features: t('以下功能引用目前不可用，仍会保留'),
  };
  if (messages[code]) return messages[code];
  // Only unknown skill codes are skill-loading failures; other coded errors (attachments, storage…) keep their own message.
  if (String(code || '').startsWith('skill_')) return t('技能暂时无法载入');
  return String((typeof error === 'string' ? '' : error?.message) || t('技能操作失败，请重试'));
};
