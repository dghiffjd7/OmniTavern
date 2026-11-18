import assert from 'node:assert/strict';

// Vertex 的 Service Account JSON 像 API Key 一样可以存多份、切换当前使用的那份
const values = new Map();
globalThis.localStorage = {
  getItem: key => (values.has(String(key)) ? values.get(String(key)) : null),
  setItem: (key, value) => values.set(String(key), String(value)),
  removeItem: key => values.delete(String(key)),
};
delete globalThis.__TAURI__;

const { ConfigManager } = await import('../../src/scripts/storage/config.js');

const account = (project, email, keyMaterial) => JSON.stringify({
  type: 'service_account', project_id: project, client_email: email, private_key: keyMaterial,
});
const A = account('project-a', 'a@project-a.iam.gserviceaccount.com', 'secret-material-a');
const B = account('project-b', 'b@project-b.iam.gserviceaccount.com', 'secret-material-b');
const form = serviceAccount => ({
  provider: 'vertexai',
  baseUrl: 'https://aiplatform.googleapis.com',
  model: 'gemini-2.5-flash',
  vertexaiAuthMode: 'service_account',
  vertexaiRegion: 'global',
  ...(serviceAccount ? { vertexaiServiceAccount: serviceAccount } : {}),
});

const scope = `vertex_sa_keyring_${Date.now()}`;
const manager = new ConfigManager({ scope });
await manager.ensureStores();
await manager.createProfile('Vertex', form());
const pid = manager.getActiveProfile().id;

{
  await manager.save(form(A));
  await manager.save(form(B));
  const list = manager.listVertexServiceAccounts(pid);
  assert.deepEqual(list.map(item => [item.label, item.preview]), [
    ['project-b', 'b@project-b.iam.gserviceaccount.com'],
    ['project-a', 'a@project-a.iam.gserviceaccount.com'],
  ], '贴上新的 JSON 会另存一份，旧的还在');
  assert.equal(manager.getActiveProfile().activeVertexServiceAccountId, list[0].id);
  assert.equal(manager.get().vertexaiServiceAccount, B, '新存的那份设为当前');
  console.log('ok - saving a new service account keeps the earlier one and makes the new one current');
}

{
  await manager.save(form(A));
  const list = manager.listVertexServiceAccounts(pid);
  assert.equal(list.length, 2, '同一份 JSON 不重复保存');
  assert.equal(manager.get().vertexaiServiceAccount, A, '重新贴上已存的那份就把它设为当前');
  console.log('ok - saving an already stored service account switches to it without a duplicate');
}

{
  const idB = manager.listVertexServiceAccounts(pid).find(item => item.label === 'project-b').id;
  await manager.setActiveVertexServiceAccount(pid, idB);
  assert.equal(manager.get().vertexaiServiceAccount, B);
  const reloaded = new ConfigManager({ scope });
  assert.equal((await reloaded.load()).vertexaiServiceAccount, B, '重新载入后仍用选中的那份');
  console.log('ok - the selected service account is used and survives a reload');
}

{
  const idB = manager.listVertexServiceAccounts(pid).find(item => item.label === 'project-b').id;
  await manager.removeVertexServiceAccount(pid, idB);
  assert.deepEqual(manager.listVertexServiceAccounts(pid).map(item => item.label), ['project-a']);
  assert.equal(manager.get().vertexaiServiceAccount, A, '删掉当前那份后改用剩下的');
  assert.equal(manager.hasVertexServiceAccount(pid), true);
  console.log('ok - removing the current service account falls back to the remaining one');
}

{
  await assert.rejects(manager.addVertexServiceAccount(pid, '{"type":"service_account"}'), /client_email|private_key/);
  await assert.rejects(manager.addVertexServiceAccount(pid, 'not json'), /JSON/);
  await assert.rejects(manager.save(form('{"project_id":"x"}')), /client_email|private_key/);
  assert.equal(manager.listVertexServiceAccounts(pid).length, 1, '格式不对的 JSON 什么都不存');
  assert.equal(manager.get().vertexaiServiceAccount, A);
  console.log('ok - invalid service account JSON is rejected without storing anything');
}

{
  // 旧资料：只有一份记录，配置档上没有记当前用哪份
  delete manager.profileStore.profiles[pid].activeVertexServiceAccountId;
  await manager.persistProfiles();
  const reloaded = new ConfigManager({ scope });
  assert.equal((await reloaded.load()).vertexaiServiceAccount, A);
  console.log('ok - a profile without a selected service account uses the stored one');
}

{
  const stored = [...values.values()].join('\n');
  assert.equal(stored.includes('secret-material-a') || stored.includes('secret-material-b'), false, '明文不落盘');
  console.log('ok - service account plaintext is never persisted');
}
