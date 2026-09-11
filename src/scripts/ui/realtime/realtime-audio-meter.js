// A local, read-only tap on capture/playback. No samples are stored or sent as events.
export const createRealtimeAudioMeter = ({
  context = null,
  onLevel,
  createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) => {
  const ownsContext = !context;
  const channels = new Map();
  let timer = null, closed = false, silent = null;
  const notify = value => { try { onLevel?.(value); } catch {} };
  const detach = channel => {
    const tap = channels.get(channel);
    if (!tap) return;
    try { tap.source.disconnect(tap.analyser); } catch {}
    try { tap.analyser.disconnect(); } catch {}
    channels.delete(channel);
  };
  const read = channel => {
    const tap = channels.get(channel);
    if (!tap || tap.muted || context?.state !== 'running') return { level: 0, bands: [] };
    tap.analyser.getByteTimeDomainData(tap.wave);
    let energy = 0;
    for (const sample of tap.wave) energy += ((sample - 128) / 128) ** 2;
    // Remove the noise floor, then compress the dynamic range for quiet speech.
    const level = Math.min(1, Math.max(0, Math.sqrt(energy / tap.wave.length) - .008) * 5);
    tap.analyser.getByteFrequencyData(tap.frequency);
    const bands = Array.from({ length: 9 }, (_, i) => {
      const bin = Math.min(tap.frequency.length - 1, Math.max(1, Math.round((140 * 1.55 ** i) / (context.sampleRate / tap.analyser.fftSize))));
      return Math.min(1, (tap.frequency[bin] / 255) * Math.sqrt(level));
    });
    return { level, bands };
  };
  const sample = () => {
    if (closed) return;
    try { notify({ input: read('input'), output: read('output') }); } catch { /* Visuals never interrupt audio. */ }
  };
  const attach = (channel, sourceOrStream) => {
    if (closed || typeof onLevel !== 'function' || !sourceOrStream) return;
    detach(channel);
    let source, analyser;
    try {
      context ||= createContext();
      if (context.state === 'suspended') context.resume()?.catch?.(() => {});
      if (!silent) {
        silent = context.createGain();
        silent.gain.value = 0;
        silent.connect(context.destination);
      }
      source = typeof sourceOrStream.connect === 'function' ? sourceOrStream : context.createMediaStreamSource(sourceOrStream);
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = .65;
      // WebView2 can leave an otherwise disconnected context's clock at zero.
      // A zero-gain sink keeps analysis running without duplicating playback.
      analyser.connect(silent);
      source.connect(analyser);
      channels.set(channel, { source, analyser, wave: new Uint8Array(analyser.fftSize), frequency: new Uint8Array(analyser.frequencyBinCount), muted: false });
      if (timer == null) timer = setIntervalFn(sample, 40);
    } catch {
      try { if (analyser) source?.disconnect(analyser); analyser?.disconnect(); } catch {}
    }
  };
  const setMuted = (channel, muted) => {
    const tap = channels.get(channel);
    if (tap) tap.muted = muted === true;
    sample();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    if (timer != null) clearIntervalFn(timer);
    timer = null;
    for (const channel of channels.keys()) detach(channel);
    try { silent?.disconnect(); } catch {}
    silent = null;
    notify({ input: { level: 0, bands: [] }, output: { level: 0, bands: [] } });
    if (ownsContext && context && context.state !== 'closed') { try { await context.close(); } catch {} }
    context = null;
  };
  return { attach, setMuted, close };
};
