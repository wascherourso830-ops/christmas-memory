// 在 classic Worker 中运行同步 MediaPipe 推理，主线程只采样画面和接收结果。
// 不引入依赖，不在主线程执行 visionSource，不重新下载模型。
export function createGestureWorkerModel(runtime, { delegate = 'CPU', timeoutMs = 3500, initTimeoutMs = 20000 } = {}) {
  const makeError = (message, handCode, stage, original) => {
    const error = new Error(message);
    error.name = original?.name || 'GestureWorkerError';
    error.handCode = handCode;
    error.stage = stage;
    if (original?.stack) error.workerStack = String(original.stack);
    return error;
  };
  if (!runtime || typeof runtime.visionSource !== 'string' || typeof runtime.wasmLoaderSource !== 'string'
    || !runtime.wasmBinaryBuffer || !runtime.modelAssetBuffer) {
    return Promise.reject(makeError('本地手势 Worker 资源不完整', 'worker-init-failed', 'init'));
  }
  if (typeof Worker !== 'function' || typeof createImageBitmap !== 'function'
    || typeof Blob !== 'function' || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function') {
    return Promise.reject(makeError('当前浏览器不支持独立手势识别，请使用 Chrome 或 Edge', 'worker-init-failed', 'init'));
  }
  const frameTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3500;
  const initializationTimeout = Number.isFinite(initTimeoutMs) && initTimeoutMs > 0 ? initTimeoutMs : 20000;
  let source, modelBytes, wasmBytes;
  try {
    source = buildClassicGestureWorker(runtime.visionSource, runtime.wasmLoaderSource);
    const copyBytes = (input, label) => {
      let bytes;
      // 复制后转移，不分离缓存资源；Worker 重建时仍能使用原始模型与 WASM。
      if (input instanceof ArrayBuffer) bytes = new Uint8Array(input.slice(0));
      else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
      else throw new Error(label + '必须是 ArrayBuffer 或其视图');
      if (!bytes.byteLength) throw new Error(label + '为空');
      return bytes;
    };
    modelBytes = copyBytes(runtime.modelAssetBuffer, '手势模型');
    wasmBytes = copyBytes(runtime.wasmBinaryBuffer, 'WASM 二进制');
  } catch (error) {
    return Promise.reject(makeError(error.message, 'worker-init-failed', 'init', error));
  }

  let worker = null, workerUrl = null, stopped = false, ready = false, destroyed = false;
  let diagnostics = null;
  let pending = null, sequence = 0, lastTimestamp = -Infinity;
  let initializationTimer = null, shutdownTimer = null;
  let resolveInitialization, rejectInitialization;
  const initialization = new Promise((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });
  const closeBitmap = bitmap => { try { bitmap?.close(); } catch { /* 继续释放其他资源。 */ } };
  const clearInitializationTimer = () => {
    if (initializationTimer !== null) clearTimeout(initializationTimer);
    initializationTimer = null;
  };

  function destroyWorker() {
    if (destroyed) return;
    destroyed = true;
    clearInitializationTimer();
    if (shutdownTimer !== null) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* 终止过程不妨碍 URL 回收。 */ }
      worker = null;
    }
    if (workerUrl !== null) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
  }

  function settle(job, error, result) {
    if (!job || job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    closeBitmap(job.bitmap);
    job.bitmap = null;
    if (pending === job) pending = null;
    if (error) job.reject(error); else job.resolve(result);
  }

  function fail(error) {
    if (stopped) return;
    stopped = true;
    clearInitializationTimer();
    if (!ready) rejectInitialization(error);
    settle(pending, error);
    destroyWorker();
  }

  function close() {
    if (stopped) return;
    stopped = true;
    clearInitializationTimer();
    const error = makeError('手势识别已关闭', 'worker-closed', 'close');
    if (!ready) rejectInitialization(error);
    const busy = !!pending;
    settle(pending, error);
    // 正在同步推理的 Worker 无法及时处理 close 消息，直接终止整套运行时。
    if (busy || !ready || !worker) { destroyWorker(); return; }
    shutdownTimer = setTimeout(destroyWorker, 200);
    try { worker.postMessage({ type: 'close' }); }
    catch { destroyWorker(); }
  }

  const model = {
    close,
    get closed() { return stopped; },
    get diagnostics() { return diagnostics; },
    recognizeForVideo(input, timestamp) {
      if (stopped || !worker) return Promise.reject(makeError('手势识别已关闭', 'worker-closed', 'inference'));
      if (pending) return Promise.reject(makeError('上一帧手势仍在识别中', 'worker-busy', 'inference'));
      if (!Number.isFinite(timestamp) || timestamp <= lastTimestamp) {
        return Promise.reject(makeError('识别帧时间必须递增', 'worker-invalid-timestamp', 'inference'));
      }
      const job = { id: ++sequence, settled: false, bitmap: null, timer: null, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      pending = job;
      job.timer = setTimeout(() => {
        const error = makeError('独立手势识别超时，已终止识别任务，画面仍可继续播放', 'worker-timeout', 'inference');
        error.detailCode = 'worker-inference-timeout';
        error.workerTimeout = true;
        fail(error);
      }, frameTimeout);
      Promise.resolve().then(() => {
        if (stopped || job.settled) return null;
        // 视频、图片、ImageBitmap 和 canvas 均可输入；只缩小，不放大原画面。
        const width = Number(input?.videoWidth || input?.naturalWidth || input?.width);
        const height = Number(input?.videoHeight || input?.naturalHeight || input?.height);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && Math.max(width, height) > 640) {
          const scale = 640 / Math.max(width, height);
          return createImageBitmap(input, {
            resizeWidth: Math.max(1, Math.round(width * scale)),
            resizeHeight: Math.max(1, Math.round(height * scale)),
            resizeQuality: 'low',
          });
        }
        return createImageBitmap(input);
      }).then(bitmap => {
        if (!bitmap) return;
        if (stopped || job.settled || pending !== job || !worker) { closeBitmap(bitmap); return; }
        job.bitmap = bitmap;
        try {
          worker.postMessage({ type: 'frame', id: job.id, timestamp, bitmap }, [bitmap]);
          // 转移成功后位图归 Worker 所有，由 Worker 在推理 finally 中关闭。
          job.bitmap = null;
          lastTimestamp = timestamp;
        } catch (error) {
          fail(makeError('无法将摄像头画面交给独立识别任务：' + error.message, 'worker-inference-failed', 'transfer', error));
        }
      }).catch(error => {
        if (!stopped && !job.settled) {
          settle(job, makeError('读取识别画面失败：' + error.message, 'worker-inference-failed', 'capture', error));
        }
      });
      return promise;
    },
  };

  try {
    workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    // 保持 classic 兼容现有运行时；WASM 加载器与字节已内置，不再导入跨域 Blob。
    worker = new Worker(workerUrl);
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'closed') { destroyWorker(); return; }
      if (stopped) return;
      if (message.type === 'ready') {
        ready = true;
        diagnostics = Object.freeze(message.diagnostics || { resourceMode: 'inline', usesParentFileset: false });
        clearInitializationTimer();
        resolveInitialization(model);
      } else if (message.type === 'result') {
        if (pending?.id === message.id) settle(pending, null, message.result);
      } else if (message.type === 'error') {
        const phase = message.stage || (ready ? 'inference' : 'init');
        const code = ready ? 'worker-inference-failed' : 'worker-init-failed';
        fail(makeError(message.message || '独立手势识别失败', code, phase, message));
      }
    };
    worker.onerror = event => {
      event.preventDefault?.();
      fail(makeError(event.message || '独立识别脚本无法运行', ready ? 'worker-inference-failed' : 'worker-init-failed', ready ? 'inference' : 'init', event.error));
    };
    worker.onmessageerror = () => fail(makeError('独立识别结果无法传回页面', ready ? 'worker-inference-failed' : 'worker-init-failed', 'transport'));
    initializationTimer = setTimeout(() => {
      const error = makeError('独立手势模型初始化超过限定时间', 'worker-init-timeout', 'init');
      error.workerTimeout = true;
      fail(error);
    }, initializationTimeout);
    worker.postMessage({
      type: 'init', delegate, modelAssetBuffer: modelBytes, wasmBinaryBuffer: wasmBytes,
    }, [modelBytes.buffer, wasmBytes.buffer]);
  } catch (error) {
    fail(makeError('无法启动独立手势任务：' + error.message, 'worker-init-failed', 'init', error));
  }
  return initialization;
}

function buildClassicGestureWorker(visionSource, wasmLoaderSource) {
  const trailingExports = /\bexport\s*\{([^}]+)\}\s*;?\s*(?:\/\/[#@]\s*sourceMappingURL=[^\r\n]*\s*)?$/;
  const match = trailingExports.exec(visionSource);
  if (!match) throw new Error('本地 vision bundle 的导出格式不支持 classic Worker');
  let recognizerName = null;
  for (const entry of match[1].split(',')) {
    const names = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(entry);
    if (!names) throw new Error('无法解析本地 vision bundle 导出');
    if ((names[2] || names[1]) === 'GestureRecognizer') recognizerName = names[1];
  }
  if (!recognizerName) throw new Error('本地 vision bundle 缺少 GestureRecognizer');
  if (!/\b(?:var|let|const)\s+ModuleFactory\s*=/.test(wasmLoaderSource)) {
    throw new Error('本地 WASM 加载器缺少可识别的 ModuleFactory');
  }
  // 官方 Emscripten loader 依赖非严格经典脚本的块级函数兼容行为，必须原样置于全局。
  // 仅 vision bundle 与消息处理器使用严格闭包，不能把 loader 一并包入其中。
  return wasmLoaderSource + '\n;(() => {\n"use strict";\n' + visionSource.slice(0, match.index)
    + '\n('
    + runClassicGestureWorker.toString() + ')(' + recognizerName + ',ModuleFactory);\n})();\n';
}

function runClassicGestureWorker(GestureType, wasmFactory) {
  let recognizer = null;
  const report = (error, stage, id) => self.postMessage({
    type: 'error', stage, id, name: error?.name || 'Error',
    message: String(error?.message || error), stack: error?.stack ? String(error.stack) : undefined,
  });
  self.onmessage = async event => {
    const message = event.data || {};
    if (message.type === 'init') {
      try {
        if (typeof OffscreenCanvas !== 'function') throw new Error('当前浏览器不支持独立画布识别');
        if (typeof wasmFactory !== 'function') throw new Error('本地 WASM 运行时工厂不可用');
        // 0.10.3 官方入口：空 loader 路径跳过 importScripts；Module seed 直接供给 wasmBinary。
        // 不使用主线程 Blob URL、data URL、fetch 或全局网络替换，因此也适用于 file://。
        self.ModuleFactory = wasmFactory;
        self.Module = { wasmBinary: message.wasmBinaryBuffer };
        recognizer = await GestureType.createFromOptions({
          wasmLoaderPath: '', wasmBinaryPath: 'gesture-worker.wasm', assetLoaderPath: '',
        }, {
          baseOptions: { modelAssetBuffer: message.modelAssetBuffer, delegate: message.delegate || 'CPU' },
          canvas: new OffscreenCanvas(1, 1),
          runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: .45,
          minHandPresenceConfidence: .45,
          minTrackingConfidence: .45,
          cannedGesturesClassifierOptions: { maxResults: -1, scoreThreshold: 0 },
        });
        self.postMessage({ type: 'ready', diagnostics: {
          resourceMode: 'inline', loaderSource: 'worker-script', wasmSource: 'memory-buffer',
          usesParentFileset: false, delegate: message.delegate || 'CPU',
          modelBytes: message.modelAssetBuffer.byteLength, wasmBytes: message.wasmBinaryBuffer.byteLength,
        } });
      } catch (error) { report(error, 'init'); }
      finally { self.Module = self.ModuleFactory = undefined; }
    } else if (message.type === 'frame') {
      try {
        if (!recognizer) throw new Error('独立手势模型尚未就绪');
        const result = recognizer.recognizeForVideo(message.bitmap, message.timestamp);
        self.postMessage({ type: 'result', id: message.id, result });
      } catch (error) { report(error, 'inference', message.id); }
      finally { try { message.bitmap?.close(); } catch { /* Worker 继续保持可终止状态。 */ } }
    } else if (message.type === 'close') {
      try { recognizer?.close(); }
      catch { /* 即使模型关闭失败，Worker 仍会退出。 */ }
      recognizer = null;
      self.postMessage({ type: 'closed' });
      self.close();
    }
  };
}
