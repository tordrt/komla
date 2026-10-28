type PtyDataCallback = (data: string, seq: number) => void;

const listeners = new Map<string, PtyDataCallback>();
let cleanup: (() => void) | null = null;

function ensureListener(): void {
  if (cleanup) return;
  cleanup = window.api.onPtyData((terminalId, data, seq) => {
    const callback = listeners.get(terminalId);
    if (callback) callback(data, seq);
  });
}

export function subscribePtyData(terminalId: string, callback: PtyDataCallback): () => void {
  listeners.set(terminalId, callback);
  ensureListener();
  return () => {
    listeners.delete(terminalId);
    if (listeners.size === 0 && cleanup) {
      cleanup();
      cleanup = null;
    }
  };
}
