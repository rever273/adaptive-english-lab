// Taps the microphone stream and hands raw samples to the page (served from the same origin: the page CSP forbids blob scripts).
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('tap', Tap);
