// Applies only to built-in phone prompt templates, never arbitrary model text.
export const withoutPhonePromptTime = value => String(value ?? '')
  .replace(/--(?:HH:mm|\d{1,2}[:：]\d{2}|发言时间|發言時間|post time)(?=--|\s|$)/gi, '')
  .replaceAll('前后依然要加发言人和时间', '前面依然要加发言人')
  .replaceAll('前後依然要加發言人和時間', '前面依然要加發言人')
  .replaceAll('it still requires the speaker and time around it', 'it still requires the speaker before it');

export const projectPhonePromptTime = (value, { timeMode = 'local', surface = 'chat' } = {}) => {
  const base = withoutPhonePromptTime(value);
  if (timeMode !== 'ai') return base;
  return base.split('\n').map(line => {
    if (!line.includes('--')) return line;
    const parts = line.split('--');
    if (surface === 'moment') {
      if (parts.length < 4) return line; // Comments retain their existing two fields.
      parts.splice(parts.length - 2, 0, /^\d+$/.test(parts.at(-1).trim()) ? '12:00' : 'HH:mm');
      return parts.join('--');
    }
    return `${line}--${/示例|Example|如/.test(line) ? '12:00' : 'HH:mm'}`;
  }).join('\n')
    .replaceAll('前面依然要加发言人', '前后依然要加发言人和时间')
    .replaceAll('前面依然要加發言人', '前後依然要加發言人和時間')
    .replaceAll('it still requires the speaker before it', 'it still requires the speaker and time around it');
};
