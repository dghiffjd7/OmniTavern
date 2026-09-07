export const bytesToBase64 = bytes => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
};
export const base64ToBytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
export const decodePcm16 = bytes => {
  if (bytes.byteLength % 2) throw new Error('Invalid PCM16 frame');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < output.length; index++) output[index] = view.getInt16(index * 2, true) / 32768;
  return output;
};
// Stateful integration resampling keeps fractional phase across render quanta.
export class Pcm16Framer {
  constructor(inputRate, outputRate, frameMs = 20) {
    if (!(inputRate >= outputRate && outputRate > 0)) throw new Error('Unsupported microphone sample rate');
    this.ratio = inputRate / outputRate; this.frameSize = Math.round(outputRate * frameMs / 1000);
    this.remaining = this.ratio; this.sum = 0; this.samples = [];
  }
  push(input, emit) {
    for (const sample of input) {
      let available = 1;
      while (available > 1e-8) {
        const used = Math.min(available, this.remaining);
        this.sum += sample * used; this.remaining -= used; available -= used;
        if (this.remaining < 1e-8) {
          this.samples.push(Math.round(Math.max(-1, Math.min(1, this.sum / this.ratio)) * (this.sum < 0 ? 32768 : 32767)));
          this.remaining = this.ratio; this.sum = 0;
          if (this.samples.length === this.frameSize) {
            const bytes = new Uint8Array(this.frameSize * 2); const view = new DataView(bytes.buffer);
            this.samples.forEach((value, index) => view.setInt16(index * 2, value, true)); this.samples = []; emit(bytes);
          }
        }
      }
    }
  }
}
