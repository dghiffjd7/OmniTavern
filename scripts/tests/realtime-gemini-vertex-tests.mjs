import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeRealtimeProfile, GEMINI_VERTEX_MODELS, validateRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { RealtimeProfileStore } from '../../src/scripts/storage/realtime-profile-store.js';
import { buildGeminiLiveSetup } from '../../src/scripts/ui/realtime/realtime-gemini-protocol.js';
import { NativeRealtimeSessionClient } from '../../src/scripts/ui/realtime/native-realtime-session-client.js';
import { VertexAIProvider } from '../../src/scripts/api/providers/vertexai.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const vertex = () => ({ ...makeRealtimeProfile('gemini_live'), geminiBackend: 'vertex', vertexaiAuthMode: 'service_account', vertexaiProjectId: 'voice-project', region: 'us-central1', model: GEMINI_VERTEX_MODELS[0] });
const account = JSON.stringify({ project_id: 'voice-project', client_email: 'voice@voice-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----' });
let count = 0;
const test = async (name, body) => { await body(); console.log(`ok - ${name}`); count++; };
await test('Gemini metadata migrates to Developer API; mode changes validate separate encrypted credentials', async () => {
  const keys = new Map(), persisted = [];
  const legacy = makeRealtimeProfile(); delete legacy.geminiBackend; delete legacy.vertexaiAuthMode; delete legacy.vertexaiProjectId;
  const store = new RealtimeProfileStore({ storage: { getItem: () => JSON.stringify({ version: 1, profiles: [legacy] }), setItem: () => {} },
    invoke: async (name, args) => { if (name === 'save_kv') persisted.push(args.data); return null; },
    keyring: { addKey: async (id, value) => { const key = crypto.randomUUID(); keys.set(key, value); return key; }, decryptKey: async (id, key) => keys.get(key), removeKey: async (id, key) => keys.delete(key) } });
  await store.ready; assert.equal(store.list()[0].geminiBackend, 'developer');
  const developer = await store.save(makeRealtimeProfile(), { apiKey: 'AI_STUDIO_SECRET' });
  const express = { ...developer, ...vertex(), id: developer.id, credentialId: developer.credentialId, vertexaiAuthMode: 'express' };
  await assert.rejects(store.save(express), /Express API Key/);
  const sa = await store.save({ ...express, vertexaiAuthMode: 'service_account', vertexaiProjectId: '' }, { apiKey: 'AI_STUDIO_SECRET', vertexaiServiceAccount: account });
  assert.equal(sa.vertexaiProjectId, 'voice-project'); assert.equal((await store.resolve()).config.credentials.vertexaiServiceAccount, account);
  assert(!JSON.stringify(persisted).includes('PRIVATE KEY')); assert(!JSON.stringify(persisted).includes('AI_STUDIO_SECRET'));
  const duplicate = await store.duplicate(sa.id); assert.equal(duplicate.geminiBackend, 'vertex'); assert.notEqual(duplicate.credentialId, sa.credentialId);
  await assert.rejects(store.save({ ...sa, vertexaiAuthMode: 'express' }), /Express API Key/);
  await store.save({ ...sa, vertexaiAuthMode: 'express' }, { vertexaiApiKey: 'EXPRESS_SECRET' });
  await assert.rejects(store.save({ ...sa, geminiBackend: 'developer', model: makeRealtimeProfile().model }), /API Key/);
});
await test('Vertex setup uses project resources or Express publisher resources and Live regions', () => {
  const profile = vertex(); validateRealtimeProfile(profile);
  assert.equal(buildGeminiLiveSetup(profile, 'role').setup.model, `projects/voice-project/locations/us-central1/publishers/google/models/${profile.model}`);
  assert.equal(buildGeminiLiveSetup({ ...profile, vertexaiAuthMode: 'express' }, 'role').setup.model, `publishers/google/models/${profile.model}`);
  assert.equal(buildGeminiLiveSetup(makeRealtimeProfile(), 'role').setup.model, `models/${makeRealtimeProfile().model}`);
  assert.throws(() => validateRealtimeProfile({ ...profile, region: 'global' }), /区域/);
  assert.throws(() => validateRealtimeProfile({ ...profile, model: makeRealtimeProfile().model }), /模型/);
  assert.throws(() => validateRealtimeProfile({ ...profile, geminiBackend: 'unknown' }), /接入方式/);
});
const clientFixture = (createVertexAuth) => {
  const commands = []; let callback;
  const client = new NativeRealtimeSessionClient({ createVertexAuth, createChannel: fn => { callback = fn; return { id: 1 }; },
    createAudio: () => ({ open: async () => {}, close: async () => {}, clear: () => {} }),
    invoke: async (name, args) => { commands.push([name, args]); if (name === 'realtime_transport_open') callback({ kind: 'open' }); if (name === 'realtime_transport_send' && args.messages.some(frame => JSON.parse(frame.data).setup)) callback({ kind: 'text', data: '{"setupComplete":{}}' }); } });
  return { client, commands };
};
await test('Vertex native bridge receives only active credentials; renewal requests a fresh valid token', async () => {
  let tokens = 0, authInstances = 0;
  const { client, commands } = clientFixture(async () => { authInstances++; return { getAccessToken: async () => `TOKEN_${++tokens}` }; });
  try {
    await client.connect({ config: { ...vertex(), credentials: { apiKey: 'UNUSED', vertexaiServiceAccount: account } }, sessionConfig: { instructions: 'role' } });
    client.resumeHandle = 'resume'; await client.renew();
    const connections = commands.filter(([name]) => name === 'realtime_transport_open').map(([, args]) => args.connection);
    assert.deepEqual(connections.map(c => c.credentials), [{ accessToken: 'TOKEN_1' }, { accessToken: 'TOKEN_2' }]); assert.equal(authInstances, 1);
    assert(!JSON.stringify(commands).includes('PRIVATE KEY')); assert(!JSON.stringify(commands).includes('UNUSED'));
    await client.connect({ config: { ...vertex(), vertexaiAuthMode: 'express', credentials: { apiKey: 'STUDIO', vertexaiApiKey: 'EXPRESS', vertexaiServiceAccount: account } }, sessionConfig: { instructions: 'role' } });
    assert.deepEqual(commands.filter(([name]) => name === 'realtime_transport_open').at(-1)[1].connection.credentials, { apiKey: 'EXPRESS' });
  } finally { await client.close(); }
});
await test('hanging up during OAuth aborts authentication and prevents late WebSocket creation', async () => {
  let release, authSignal;
  const { client, commands } = clientFixture(async () => ({ getAccessToken: ({ signal }) => { authSignal = signal; return new Promise(resolve => { release = resolve; }); } }));
  const controller = new AbortController();
  const connected = client.connect({ config: { ...vertex(), credentials: { vertexaiServiceAccount: account } }, sessionConfig: { instructions: 'role' }, signal: controller.signal });
  const rejected = assert.rejects(connected, error => error.name === 'AbortError');
  while (!release) await tick(); controller.abort(); await rejected;
  assert(authSignal.aborted); release('LATE_TOKEN'); await tick();
  assert(!commands.some(([name]) => name === 'realtime_transport_open')); assert(client.closed);
});
await test('shared text Vertex OAuth signs valid JWTs, caches tokens and accepts cancellation', async () => {
  const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
  const auth = new VertexAIProvider({ vertexaiAuthMode: 'service_account', vertexaiServiceAccount: JSON.stringify({ ...JSON.parse(account), private_key: pem }) });
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert(options.signal);
    const parts = new URLSearchParams(options.body).get('assertion').split('.');
    assert(await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, Buffer.from(parts[2], 'base64url'), Buffer.from(parts.slice(0, 2).join('.'))));
    assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).scope, 'https://www.googleapis.com/auth/cloud-platform');
    return new Response(JSON.stringify({ access_token: 'OAUTH_TOKEN', expires_in: 3600 }));
  };
  try {
    assert.equal(await auth.getAccessToken(), 'OAUTH_TOKEN'); assert.equal(await auth.getAccessToken(), 'OAUTH_TOKEN'); assert.equal(requests, 1);
    const controller = new AbortController(); controller.abort(); await assert.rejects(auth.getAccessToken({ signal: controller.signal }), error => error.name === 'AbortError');
  } finally { globalThis.fetch = originalFetch; }
});
console.log(`Gemini Live Vertex tests passed (${count})`);
