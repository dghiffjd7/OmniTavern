import assert from 'node:assert/strict';
import { createRealtimeAudioMeter } from '../../src/scripts/ui/realtime/realtime-audio-meter.js';

let tick, timerCount = 0, closedContexts = 0;
const frames = [], sources = [];
const source = () => ({ links: new Set(), connect(node) { this.links.add(node); }, disconnect(node) { assert(node, 'disconnect only the meter branch'); this.links.delete(node); } });
const playback = source(), speakers = {};
playback.connect(speakers);
const context = {
  state: 'running', sampleRate: 24000,
  destination: {},
  createGain() { return { gain: { value: 1 }, connect() { assert.equal(this.gain.value, 0, 'analysis sink is silent'); }, disconnect() {} }; },
  createMediaStreamSource() { const node = source(); sources.push(node); return node; },
  createAnalyser() { return { frequencyBinCount: 256, getByteTimeDomainData: data => data.fill(148), getByteFrequencyData: data => data.fill(180), connect() {}, disconnect() {} }; },
  async close() { closedContexts++; this.state = 'closed'; },
};
const timers = { setIntervalFn(callback, ms) { assert.equal(ms, 40); tick = callback; timerCount++; return 1; }, clearIntervalFn() { timerCount--; } };
const meter = createRealtimeAudioMeter({ context, onLevel: frame => frames.push(frame), ...timers });
meter.attach('input', {}); meter.attach('output', playback);
assert.equal(timerCount, 1, 'capture and playback share one bounded sampling timer');
tick();
assert(frames.at(-1).input.level > .5 && frames.at(-1).output.level > .5);
assert.equal(frames.at(-1).input.bands.length, 9);
assert(frames.at(-1).input.bands.every(value => value >= 0 && value <= 1));
meter.setMuted('input', true);
assert.equal(frames.at(-1).input.level, 0);
assert(frames.at(-1).output.level > 0, 'muting the microphone keeps playback metering');
meter.setMuted('output', true); assert.equal(frames.at(-1).output.level, 0);
meter.attach('input', {}); assert.equal(sources[0].links.size, 0, 'replaced tracks release their tap');
await meter.close(); await meter.close();
assert.equal(timerCount, 0); assert.equal(closedContexts, 0, 'shared playback context stays open');
assert.deepEqual([...playback.links], [speakers], 'meter cleanup preserves the speaker route');
assert.equal(frames.at(-1).input.level, 0);
const count = frames.length; tick(); meter.attach('input', {}); assert.equal(frames.length, count);

const owned = createRealtimeAudioMeter({ createContext: () => context, onLevel: () => {}, ...timers });
owned.attach('input', {}); await owned.close(); assert.equal(closedContexts, 1);
const unsupported = createRealtimeAudioMeter({ createContext: () => { throw Error('unsupported'); }, onLevel: () => {} });
assert.doesNotThrow(() => unsupported.attach('input', {})); await unsupported.close();
assert.equal(timerCount, 0);
console.log('realtime audio meter tests passed (levels, mute, track replacement, cleanup and fallback)');
