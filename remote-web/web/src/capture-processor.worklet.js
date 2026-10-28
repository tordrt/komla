// AudioWorklet processor for voice capture. Runs in AudioWorkletGlobalScope —
// no DOM/window APIs available, only `registerProcessor` and AudioWorkletProcessor.
// Posts each 128-sample input frame back to the main thread.

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0 && channels[0].length > 0) {
      // Copy: the underlying buffer is reused on the next process() call.
      this.port.postMessage(new Float32Array(channels[0]));
    }
    return true;
  }
}

registerProcessor('komla-capture-processor', CaptureProcessor);
