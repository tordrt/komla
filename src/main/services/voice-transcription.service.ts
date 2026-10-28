import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';

import { utilityProcess, type UtilityProcess } from 'electron';

import { createLogger } from '../lib/logger';
import { MAIN_BUNDLE_DIR } from '../lib/module-path';
import { VOICE_SAMPLE_RATE, isFillerOnly, lacksSpeech } from '../lib/voice-audio';

import { configService } from './config.service';
import { getKomlaBasePath } from './paths';

import type { WorkerRequest, WorkerResponse } from '../workers/voice-transcription.worker';

// Omit each member of the union, so a request keeps its type-specific fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A WorkerRequest before it gets an id. */
type WorkerRequestBody = DistributiveOmit<WorkerRequest, 'id'>;

const logger = createLogger('VoiceTranscription');

export type ModelStatus = 'not-downloaded' | 'downloading' | 'extracting' | 'ready' | 'error';

export type ModelType = 'nemo_transducer' | 'nemo_ctc';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  sizeMB: number;
  runtimeMemoryMB: string;
  urls: string[];
  modelType: ModelType;
  // Files inside the extracted tarball directory
  files:
    | { encoder: string; decoder: string; joiner: string; tokens: string }
    | { model: string; tokens: string };
}

export interface ModelWithStatus extends ModelInfo {
  status: ModelStatus;
  isCurrent: boolean;
}

const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    name: 'NVIDIA Parakeet TDT 0.6B v3',
    description: 'Multilingual — supports 25 languages',
    sizeMB: 640,
    runtimeMemoryMB: '~0.9-1.2 GB',
    urls: [
      'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.gz',
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    ],
    modelType: 'nemo_transducer',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
  {
    id: 'parakeet-tdt-0.6b-v2-int8',
    name: 'NVIDIA Parakeet TDT 0.6B v2',
    description: 'English-only — strong English accuracy',
    sizeMB: 630,
    runtimeMemoryMB: '~0.9-1.2 GB',
    urls: [
      'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.gz',
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    ],
    modelType: 'nemo_transducer',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
  {
    id: 'parakeet-tdt-ctc-110m-int8',
    name: 'NVIDIA Parakeet TDT-CTC 110M',
    description: 'English, lightweight — faster and uses less memory',
    sizeMB: 126,
    runtimeMemoryMB: '~200-400 MB',
    urls: [
      'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.gz',
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
    ],
    modelType: 'nemo_ctc',
    files: {
      model: 'model.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
];

const DEFAULT_MODEL_ID = AVAILABLE_MODELS[0].id;

/** A download that receives no bytes for this long fails instead of hanging forever. */
const DOWNLOAD_STALL_MS = 30_000;

/** How long an unloading transcriber gets to exit on its own before it is killed. */
const WORKER_EXIT_GRACE_MS = 10_000;

/** Brief grace period for follow-up edits without pinning the recognizer in memory. */
const DEFAULT_IDLE_UNLOAD_MS = 10_000;

class VoiceTranscriptionService {
  private currentModelId: string;
  private worker: UtilityProcess | null = null;
  /** Resolves once an unloaded transcriber has exited. */
  private exitingWorker: Promise<void> | null = null;
  private workerReady = false;
  private loadingPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private recording = false;
  private activeTranscriptions = 0;
  private downloadAbortController: AbortController | null = null;
  private downloadingModelId: string | null = null;
  private downloadingStatus: 'downloading' | 'extracting' | null = null;
  private downloadPromise: Promise<void> | null = null;
  private nextRequestId = 0;
  /** Renderer request IDs of running transcriptions → worker request ID, null until sent. */
  private cancellableTranscriptions = new Map<string, number | null>();
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.currentModelId = configService.get().voice?.modelId ?? DEFAULT_MODEL_ID;
    this.cleanupStaleDownloadDirs();
  }

  private getModelDirPath(modelId: string): string {
    return join(getKomlaBasePath(), 'models', modelId);
  }

  private getModelsDirPath(): string {
    return join(getKomlaBasePath(), 'models');
  }

  private cleanupStaleDownloadDirs(): void {
    const modelsDir = this.getModelsDirPath();
    try {
      const knownTempPrefixes = AVAILABLE_MODELS.map((model) => `.${model.id}.download-`);
      const knownBackupPrefixes = AVAILABLE_MODELS.map((model) => `${model.id}.old-`);
      for (const entry of readdirSync(modelsDir)) {
        if (
          knownTempPrefixes.some((prefix) => entry.startsWith(prefix)) ||
          knownBackupPrefixes.some((prefix) => entry.startsWith(prefix))
        ) {
          rmSync(join(modelsDir, entry), { recursive: true, force: true });
        }
      }
    } catch (error) {
      logger.debug('Skipping stale voice model download cleanup', error);
    }
  }

  private modelFilesExist(modelId: string): boolean {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) return false;
    const dir = this.getModelDirPath(modelId);
    return Object.values(model.files).every((file) => existsSync(join(dir, file)));
  }

  getStatus(): ModelStatus {
    return this.getStatusForModel(this.currentModelId);
  }

  getCurrentModelId(): string {
    return this.currentModelId;
  }

  getStatusForModel(modelId: string): ModelStatus {
    if (this.downloadingModelId === modelId && this.downloadingStatus) {
      return this.downloadingStatus;
    }
    return this.modelFilesExist(modelId) ? 'ready' : 'not-downloaded';
  }

  getAvailableModels(): ModelInfo[] {
    return AVAILABLE_MODELS;
  }

  getModelsWithStatus(): ModelWithStatus[] {
    return AVAILABLE_MODELS.map((model) => ({
      ...model,
      status: this.getStatusForModel(model.id),
      isCurrent: model.id === this.currentModelId,
    }));
  }

  selectModel(modelId: string): void {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    if (this.currentModelId !== modelId) {
      this.unloadModel();
      this.currentModelId = modelId;
      // Config loading always fills in voice settings.
      const voiceConfig = configService.get().voice;
      if (voiceConfig) {
        configService.update({
          voice: { ...voiceConfig, modelId },
        });
      }
      logger.info('Selected voice model', { modelId });
    }
  }

  async downloadModel(
    modelId: string = this.currentModelId,
    onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
    onStatusChange?: (status: ModelStatus) => void
  ): Promise<void> {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    if (this.modelFilesExist(modelId)) {
      logger.info('Model already downloaded', { modelId });
      return;
    }

    if (this.downloadPromise) {
      if (this.downloadingModelId === modelId) {
        return this.downloadPromise;
      }
      throw new Error(
        `Cannot download ${modelId}: ${this.downloadingModelId} is already downloading`
      );
    }

    this.downloadingModelId = modelId;
    this.downloadingStatus = 'downloading';

    this.downloadPromise = this.downloadModelArchive(model, onProgress, onStatusChange).finally(
      () => {
        this.downloadAbortController = null;
        this.downloadingModelId = null;
        this.downloadingStatus = null;
        this.downloadPromise = null;
      }
    );
    return this.downloadPromise;
  }

  private async downloadModelArchive(
    model: ModelInfo,
    onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
    onStatusChange?: (status: ModelStatus) => void
  ): Promise<void> {
    const modelId = model.id;
    logger.info('Starting model download', { modelId, urls: model.urls });

    const abortController = new AbortController();
    this.downloadAbortController = abortController;
    const modelDir = this.getModelDirPath(modelId);
    const tempDir = join(dirname(modelDir), `.${modelId}.download-${process.pid}-${Date.now()}`);
    let archivePath = join(tempDir, 'model.tar.gz');
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        abortController.abort();
      }, DOWNLOAD_STALL_MS);
    };

    try {
      rmSync(tempDir, { recursive: true, force: true });
      mkdirSync(tempDir, { recursive: true });

      const { response, url } = await this.fetchModelArchive(model);
      archivePath = join(tempDir, url.endsWith('.tar.bz2') ? 'model.tar.bz2' : 'model.tar.gz');

      const contentLength = response.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
      let bytesDownloaded = 0;

      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Download the model archive to a temp file
      const { createWriteStream } = await import('fs');

      const writeStream = createWriteStream(archivePath);
      // Listen before the first write: an unhandled 'error' (e.g. disk full)
      // crashes the main process, and a failed write never emits 'drain'.
      const writeFailed = new Promise<never>((_, reject) => writeStream.on('error', reject));
      writeFailed.catch(() => {});
      const reader = response.body.getReader();

      try {
        while (true) {
          armStallTimer();
          const { done, value } = await Promise.race([reader.read(), writeFailed]);
          if (done) break;
          bytesDownloaded += value.length;
          onProgress?.(bytesDownloaded, totalBytes);
          const canWrite = writeStream.write(value);
          if (!canWrite) {
            await Promise.race([
              new Promise<void>((res) => writeStream.once('drain', res)),
              writeFailed,
            ]);
          }
        }
        clearTimeout(stallTimer);
        await Promise.race([new Promise<void>((res) => writeStream.end(() => res())), writeFailed]);
      } catch (error) {
        void reader.cancel().catch(() => {});
        // Windows can't delete the temp folder while the archive is still open.
        if (!writeStream.closed) {
          await new Promise<void>((resolve) => {
            writeStream.once('close', () => resolve());
            writeStream.destroy();
          });
        }
        throw error;
      }

      // Extract archive — files are inside a subdirectory in the archive
      this.downloadingStatus = 'extracting';
      onStatusChange?.('extracting');
      logger.info('Extracting model archive', { archivePath, modelDir: tempDir });
      await this.extractTarArchive(archivePath, tempDir);

      // Clean up the archive
      rmSync(archivePath, { force: true });

      // Verify expected files exist after extraction
      const expectedFiles = Object.values(model.files);
      const actualFiles = readdirSync(tempDir);
      const missing = expectedFiles.filter((f) => !existsSync(join(tempDir, f)));
      if (missing.length > 0) {
        logger.error('Extraction succeeded but expected files are missing', {
          modelId,
          modelDir: tempDir,
          expectedFiles,
          actualFiles,
          missing,
        });
        throw new Error(
          `Model files missing after extraction: ${missing.join(', ')}. Found: ${actualFiles.join(', ')}`
        );
      }

      this.publishModelDir(tempDir, modelDir);
      logger.info('Model downloaded and extracted successfully', { modelId });
    } catch (error) {
      if (stalled) {
        logger.error('Model download stalled', { modelId });
        rmSync(tempDir, { recursive: true, force: true });
        throw new Error(
          `Download stalled: no data for ${DOWNLOAD_STALL_MS / 1000} seconds. Check your connection and retry.`
        );
      }
      if ((error as Error).name === 'AbortError') {
        logger.info('Model download cancelled', { modelId });
        rmSync(tempDir, { recursive: true, force: true });
      } else {
        logger.error('Model download failed', error);
        rmSync(tempDir, { recursive: true, force: true });
        throw error;
      }
    } finally {
      clearTimeout(stallTimer);
    }
  }

  private async fetchModelArchive(model: ModelInfo): Promise<{ response: Response; url: string }> {
    let lastError: Error | null = null;
    const cancelSignal = this.downloadAbortController?.signal;
    for (const url of model.urls) {
      // A source that doesn't answer in time is skipped for the next one.
      const noAnswer = new AbortController();
      const answerTimer = setTimeout(
        () => noAnswer.abort(new DOMException('No response', 'TimeoutError')),
        DOWNLOAD_STALL_MS
      );
      try {
        const response = await fetch(url, {
          signal: cancelSignal ? AbortSignal.any([cancelSignal, noAnswer.signal]) : noAnswer.signal,
        });
        if (response.ok) {
          logger.info('Model archive download source selected', { modelId: model.id, url });
          return { response, url };
        }
        lastError = new Error(`Download failed: ${response.status} ${response.statusText}`);
        logger.warn('Model archive download source failed', {
          modelId: model.id,
          url,
          status: response.status,
          statusText: response.statusText,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw error;
        }
        lastError =
          (error as Error).name === 'TimeoutError'
            ? new Error(
                `Download stalled: no response for ${DOWNLOAD_STALL_MS / 1000} seconds. Check your connection and retry.`
              )
            : (error as Error);
        logger.warn('Model archive download source failed', {
          modelId: model.id,
          url,
          error,
        });
      } finally {
        clearTimeout(answerTimer);
      }
    }
    throw lastError ?? new Error(`Download failed: no URLs configured for ${model.id}`);
  }

  private publishModelDir(tempDir: string, modelDir: string): void {
    if (!existsSync(modelDir)) {
      renameSync(tempDir, modelDir);
      return;
    }

    const backupDir = `${modelDir}.old-${process.pid}-${Date.now()}`;
    renameSync(modelDir, backupDir);
    try {
      renameSync(tempDir, modelDir);
    } catch (error) {
      renameSync(backupDir, modelDir);
      throw error;
    }
    rmSync(backupDir, { recursive: true, force: true });
  }

  cancelDownload(): void {
    if (this.downloadAbortController) {
      logger.info('Cancelling model download');
      this.downloadAbortController.abort();
    }
  }

  deleteModel(modelId: string = this.currentModelId): void {
    const modelDir = this.getModelDirPath(modelId);
    logger.info('Deleting model', { modelId, modelDir });

    // Only unload if deleting the currently loaded model
    if (modelId === this.currentModelId) {
      this.unloadModel();
    }

    rmSync(modelDir, { recursive: true, force: true });
  }

  /** Pre-load the recognizer in the worker thread so transcription is instant. */
  async warmup(): Promise<void> {
    const status = this.getStatus();
    if (status !== 'ready') return;
    if (this.workerReady) return;
    try {
      await this.ensureWorkerLoaded();
    } catch (err) {
      logger.warn('Warmup failed (will retry on transcribe)', err);
      return;
    }
    this.resetIdleTimer();
  }

  async transcribe(audioBuffer: Float32Array, requestId?: string): Promise<string> {
    const status = this.getStatus();
    if (status !== 'ready') {
      throw new Error(`Cannot transcribe: model status is '${status}'`);
    }

    const audioSeconds = audioBuffer.length / VOICE_SAMPLE_RATE;
    if (lacksSpeech(audioBuffer)) {
      logger.info('Skipped transcription: no speech in recording', {
        audioSeconds: Math.round(audioSeconds * 10) / 10,
      });
      return '';
    }
    if (requestId) this.cancellableTranscriptions.set(requestId, null);
    try {
      return await this.transcribeInWorker(audioBuffer, audioSeconds, requestId);
    } finally {
      if (requestId) this.cancellableTranscriptions.delete(requestId);
    }
  }

  /** Stops a transcription started with this request ID; it resolves to ''. */
  cancelTranscription(requestId: string): void {
    if (!this.cancellableTranscriptions.has(requestId)) return;
    const transcribeId = this.cancellableTranscriptions.get(requestId);
    this.cancellableTranscriptions.delete(requestId);
    if (transcribeId != null) {
      this.worker?.postMessage({
        type: 'cancel',
        id: this.nextRequestId++,
        transcribeId,
      } satisfies WorkerRequest);
    }
  }

  private async transcribeInWorker(
    audioBuffer: Float32Array,
    audioSeconds: number,
    requestId: string | undefined
  ): Promise<string> {
    const loadStart = Date.now();
    await this.ensureWorkerLoaded();
    const loadWaitMs = Date.now() - loadStart;
    if (requestId && !this.cancellableTranscriptions.has(requestId)) return '';
    this.activeTranscriptions++;
    this.clearIdleTimer();

    const decodeStart = Date.now();
    try {
      const transcribeId = this.nextRequestId++;
      if (requestId) this.cancellableTranscriptions.set(requestId, transcribeId);
      const result = (await this.sendWorkerRequest(
        { type: 'transcribe', samples: audioBuffer },
        transcribeId
      )) as { text: string };
      const decodeMs = Date.now() - decodeStart;

      const text = isFillerOnly(result.text) ? '' : result.text;
      logger.info('Transcription complete', {
        audioSeconds: Math.round(audioSeconds * 10) / 10,
        loadWaitMs,
        decodeMs,
        textLength: text.length,
      });
      return text;
    } finally {
      this.activeTranscriptions--;
      if (this.workerReady && this.activeTranscriptions === 0) {
        this.resetIdleTimer();
      }
    }
  }

  private ensureWorkerLoaded(): Promise<void> {
    if (this.workerReady) return Promise.resolve();
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.loadWorker().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }

  private async loadWorker(): Promise<void> {
    // A transcriber still finishing a decode holds its own copy of the model.
    if (this.exitingWorker) await this.exitingWorker;
    this.spawnWorkerIfNeeded();

    const model = AVAILABLE_MODELS.find((m) => m.id === this.currentModelId);
    if (!model) throw new Error(`Unknown model: ${this.currentModelId}`);

    const dir = this.getModelDirPath(this.currentModelId);
    logger.info('Loading recognizer in worker', { modelId: this.currentModelId, dir });

    await this.sendWorkerRequest({
      type: 'load',
      modelDir: dir,
      modelType: model.modelType,
      files: model.files,
    });

    this.workerReady = true;
    logger.info('Recognizer loaded in worker');
  }

  private spawnWorkerIfNeeded(): void {
    if (this.worker) return;

    const worker = utilityProcess.fork(
      join(MAIN_BUNDLE_DIR, './workers/voice-transcription.worker.js'),
      [],
      { serviceName: 'Komla Voice Transcription' }
    );
    this.worker = worker;
    worker.on('message', (msg: WorkerResponse) => {
      if (this.worker !== worker) return;
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);

      if (msg.type === 'error') {
        pending.reject(new Error(msg.message));
      } else if (msg.type === 'transcribed') {
        pending.resolve({ text: msg.text });
      } else {
        pending.resolve(undefined);
      }
    });
    // Electron emits this on a fatal V8 error, before 'exit'. Without a
    // listener the EventEmitter would throw it in the main process.
    worker.on('error', (type, location) => {
      logger.error('Voice transcriber hit a fatal error', { type, location });
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      logger.warn('Voice worker exited unexpectedly', { code });
      this.worker = null;
      this.workerReady = false;
      // Reject any pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`The transcriber stopped unexpectedly (exit code ${code})`));
      }
      this.pendingRequests.clear();
    });
  }

  private sendWorkerRequest(msg: WorkerRequestBody, id = this.nextRequestId++): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  private terminateWorker(): void {
    if (this.worker) {
      const worker = this.worker;
      // The worker exits when told to unload. Electron reports kill() as a
      // crashed child process, so keep it for a worker that fails to exit.
      const forceKill = setTimeout(() => worker.kill(), WORKER_EXIT_GRACE_MS);
      forceKill.unref?.();
      const exited = new Promise<void>((resolve) =>
        worker.once('exit', () => {
          clearTimeout(forceKill);
          if (this.exitingWorker === exited) this.exitingWorker = null;
          resolve();
        })
      );
      this.exitingWorker = exited;
      worker.postMessage({ type: 'unload', id: this.nextRequestId++ } satisfies WorkerRequest);
      this.worker = null;
      this.workerReady = false;
      this.loadingPromise = null;
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Worker terminated'));
      }
      this.pendingRequests.clear();
    }
  }

  private async extractTarArchive(archivePath: string, destDir: string): Promise<void> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const isBzip2 = archivePath.endsWith('.tar.bz2');
    const listFlag = process.platform === 'win32' ? '-tf' : isBzip2 ? '-tjf' : '-tzf';
    const extractFlag = process.platform === 'win32' ? '-xf' : isBzip2 ? '-xjf' : '-xzf';

    // Some archives prefix paths with "./" (e.g. ./dir/file) while others
    // don't (dir/file). Detect the prefix so we strip the right number of
    // components to land files directly in destDir.
    const { stdout } = await execFileAsync('tar', [listFlag, archivePath], { timeout: 60_000 });
    const firstEntry = stdout.split('\n')[0] ?? '';
    const stripComponents = firstEntry.startsWith('./') ? 2 : 1;

    await execFileAsync(
      'tar',
      [extractFlag, archivePath, `--strip-components=${stripComponents}`, '-C', destDir],
      { timeout: 300_000 }
    );
  }

  unloadModel(): void {
    this.clearIdleTimer();
    if (this.worker && this.workerReady) {
      logger.info('Unloading recognizer from worker');
    }
    this.terminateWorker();
  }

  setRecordingState(active: boolean): void {
    this.recording = active;
    if (active) {
      // Suppress idle unload while recording
      this.clearIdleTimer();
    } else {
      // Recording stopped — start idle countdown if worker is loaded
      if (this.workerReady) {
        this.resetIdleTimer();
      }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(idleUnloadMs: number = DEFAULT_IDLE_UNLOAD_MS): void {
    this.clearIdleTimer();
    // Don't start the idle timer while a recording or transcription is in progress.
    if (this.recording || this.activeTranscriptions > 0) return;
    this.idleTimer = setTimeout(() => {
      logger.info('Model idle timeout reached, unloading');
      this.unloadModel();
    }, idleUnloadMs);
  }
}

export const voiceTranscriptionService = new VoiceTranscriptionService();
