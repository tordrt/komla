// Runs in an Electron utility process, not a worker thread: a native abort
// inside onnxruntime ends only this process, never Komla's main process.
import { cpus } from 'os';
import { join } from 'path';

import { VOICE_SAMPLE_RATE, splitAtPauses } from '../lib/voice-audio';

// sherpa-onnx-node types (no published .d.ts)
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string };
}

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaOnnx {
  OfflineRecognizer: new (config: Record<string, unknown>) => SherpaRecognizer;
}

export type WorkerRequest =
  | {
      type: 'load';
      id: number;
      modelDir: string;
      modelType: 'nemo_transducer' | 'nemo_ctc';
      files: Record<string, string>;
    }
  | { type: 'transcribe'; id: number; samples: Float32Array }
  | { type: 'cancel'; id: number; transcribeId: number }
  | { type: 'unload'; id: number };

export type WorkerResponse =
  | { type: 'loaded'; id: number }
  | { type: 'transcribed'; id: number; text: string }
  | { type: 'error'; id: number; message: string };

let recognizer: SherpaRecognizer | null = null;
// Transcriptions in progress, and whether each has been cancelled.
const transcriptions = new Map<number, { cancelled: boolean }>();

function post(msg: WorkerResponse): void {
  process.parentPort.postMessage(msg);
}

function loadSherpaOnnx(): SherpaOnnx {
  const moduleName = 'sherpa-onnx-node';
  return require(moduleName) as SherpaOnnx;
}

function getNumThreads(): number {
  const cores = cpus().length;
  // Use half the cores (physical cores on hyperthreaded CPUs), clamped to 2-4.
  return Math.max(2, Math.min(4, Math.floor(cores / 2)));
}

async function transcribe(id: number, samples: Float32Array): Promise<void> {
  const state = { cancelled: false };
  transcriptions.set(id, state);
  try {
    const texts: string[] = [];
    for (const chunk of splitAtPauses(samples)) {
      if (state.cancelled) break;
      if (!recognizer) throw new Error('Recognizer not loaded');
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples: chunk });
      recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      if (text) texts.push(text);
      // Let a cancel or unload that arrived during the decode run.
      await new Promise((resolve) => setImmediate(resolve));
    }
    post({ type: 'transcribed', id, text: state.cancelled ? '' : texts.join(' ') });
  } catch (err) {
    post({ type: 'error', id, message: (err as Error).message });
  } finally {
    transcriptions.delete(id);
  }
}

function handleMessage(msg: WorkerRequest): void {
  switch (msg.type) {
    case 'load': {
      try {
        if (recognizer) {
          recognizer = null;
        }
        const onnx = loadSherpaOnnx();
        const modelSpecificConfig =
          msg.modelType === 'nemo_ctc'
            ? { nemoCtc: { model: join(msg.modelDir, msg.files.model) } }
            : {
                transducer: {
                  encoder: join(msg.modelDir, msg.files.encoder),
                  decoder: join(msg.modelDir, msg.files.decoder),
                  joiner: join(msg.modelDir, msg.files.joiner),
                },
              };
        recognizer = new onnx.OfflineRecognizer({
          featConfig: {
            sampleRate: VOICE_SAMPLE_RATE,
            featureDim: 80,
          },
          modelConfig: {
            ...modelSpecificConfig,
            tokens: join(msg.modelDir, msg.files.tokens),
            numThreads: getNumThreads(),
            provider: 'cpu',
            debug: 0,
            modelType: msg.modelType,
          },
        });
        post({ type: 'loaded', id: msg.id });
      } catch (err) {
        post({ type: 'error', id: msg.id, message: (err as Error).message });
      }
      break;
    }

    case 'transcribe':
      void transcribe(msg.id, msg.samples);
      break;

    case 'cancel': {
      const transcription = transcriptions.get(msg.transcribeId);
      if (transcription) transcription.cancelled = true;
      break;
    }

    case 'unload': {
      // Exit instead of waiting to be killed: Electron reports a killed
      // utility process as gone, which would file an error report.
      recognizer = null;
      process.exit(0);
    }
  }
}

process.parentPort.on('message', (event) => handleMessage(event.data as WorkerRequest));
