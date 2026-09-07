import { Pcm16Framer } from './realtime-pcm-codec.js';
class RealtimeMicrophoneProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.framer = new Pcm16Framer(sampleRate, options.processorOptions.outputRate, options.processorOptions.frameMs || 20);
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) this.framer.push(input, bytes => this.port.postMessage(bytes, [bytes.buffer]));
    return true;
  }
}
registerProcessor('realtime-microphone', RealtimeMicrophoneProcessor);
