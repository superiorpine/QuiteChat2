// PCM only; output remains silent. The sample cap also applies if main-thread timers pause.
class QuietChatRecorder extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.maxSamples = processorOptions.maxSamples;
    this.total = 0; this.used = 0; this.finished = false; this.buffer = new Float32Array(4096);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') this.finish();
      if (data.type === 'cancel') { this.buffer.fill(0); this.finished = true; }
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used); this.buffer.fill(0); this.used = 0;
    this.port.postMessage({ samples }, [samples.buffer]);
  }
  finish() {
    if (this.finished) return;
    this.flush(); this.finished = true; this.port.postMessage({ done: true });
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (input) for (let i = 0; i < input.length && this.total < this.maxSamples; i++) {
      this.buffer[this.used++] = input[i]; this.total++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.total >= this.maxSamples) this.finish();
    return !this.finished;
  }
}
registerProcessor('quietchat-recorder', QuietChatRecorder);
