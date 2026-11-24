// 本地识别组件；单文件读取内联资源，多文件预览读取同目录资源。
// 默认使用官方手势模型，旧关键点 QA 可显式请求 landmarks；不传输摄像头画面。
import { FilesetResolver, GestureRecognizer, HandLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

const runtimePromises = new Map();
const resourceUrls = new Set();
let embeddedAssets = null;
function decode(base64) {
  if (typeof base64 !== 'string') throw new Error('单文件缺少指定的本地手势资源');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  return bytes;
}
function objectUrl(bytes, type, ownedUrls) {
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  resourceUrls.add(url);ownedUrls.push(url);
  return url;
}

export function loadHandRuntime(kind='gesture') {
  if (kind!=='gesture'&&kind!=='landmarks') return Promise.reject(new Error('未知手势资源类型：'+kind));
  if (runtimePromises.has(kind)) return runtimePromises.get(kind);
  const ownedUrls = [];
  const promise = (async () => {
    const modelName = kind==='gesture'?'gesture_recognizer.task':'hand_landmarker.task';
    const embedded = document.getElementById('hand-runtime-assets');
    const simd = await FilesetResolver.isSimdSupported();
    const suffix = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    if (embedded) {
      if (!embeddedAssets) embeddedAssets=JSON.parse(embedded.textContent);
      if (typeof embeddedAssets[modelName]!=='string') throw new Error('此单文件未内嵌'+modelName+'；关键点QA请使用完整本地预览目录');
      const fileset = {
        wasmLoaderPath: objectUrl(decode(embeddedAssets[suffix+'.js']), 'text/javascript', ownedUrls),
        wasmBinaryPath: objectUrl(decode(embeddedAssets[suffix+'.wasm']), 'application/wasm', ownedUrls),
      };
      const visionSource=kind==='gesture'?new TextDecoder().decode(decode(embeddedAssets['vision_bundle.mjs'])):null;
      const wasmLoaderSource=kind==='gesture'?new TextDecoder().decode(decode(embeddedAssets[suffix+'.js'])):null;
      const wasmBinaryBuffer=kind==='gesture'?decode(embeddedAssets[suffix+'.wasm']):null;
      return {kind,GestureRecognizer,HandLandmarker,fileset,visionSource,wasmLoaderSource,wasmBinaryBuffer,
        modelAssetBuffer:decode(embeddedAssets[modelName])};
    }
    const base = new URL('./vendor/mediapipe/', document.baseURI);
    const fileset = {
      wasmLoaderPath: new URL('wasm/'+suffix+'.js',base).href,
      wasmBinaryPath: new URL('wasm/'+suffix+'.wasm',base).href,
    };
    const [response,visionResponse,loaderResponse,wasmResponse] = await Promise.all([
      fetch(new URL(modelName,base), {signal:AbortSignal.timeout(30000)}),
      kind==='gesture'?fetch(new URL('vision_bundle.mjs',base), {signal:AbortSignal.timeout(30000)}):null,
      kind==='gesture'?fetch(new URL('wasm/'+suffix+'.js',base), {signal:AbortSignal.timeout(30000)}):null,
      kind==='gesture'?fetch(new URL('wasm/'+suffix+'.wasm',base), {signal:AbortSignal.timeout(30000)}):null,
    ]);
    if (!response.ok) throw new Error('本地模型读取失败：'+modelName+'（HTTP '+response.status+'）');
    if(visionResponse&&!visionResponse.ok)throw new Error('本地识别线程组件读取失败：HTTP '+visionResponse.status);
    if(loaderResponse&&!loaderResponse.ok)throw new Error('本地识别引导代码读取失败：HTTP '+loaderResponse.status);
    if(wasmResponse&&!wasmResponse.ok)throw new Error('本地识别WASM读取失败：HTTP '+wasmResponse.status);
    const [buffer,visionSource,wasmLoaderSource,wasmBytes]=await Promise.all([
      response.arrayBuffer(),visionResponse?visionResponse.text():null,
      loaderResponse?loaderResponse.text():null,wasmResponse?wasmResponse.arrayBuffer():null,
    ]);
    return {kind,GestureRecognizer,HandLandmarker,fileset,visionSource,wasmLoaderSource,
      wasmBinaryBuffer:wasmBytes?new Uint8Array(wasmBytes):null,modelAssetBuffer:new Uint8Array(buffer)};
  })().catch(error => {
    if (runtimePromises.get(kind)===promise) runtimePromises.delete(kind);
    for (const url of ownedUrls){URL.revokeObjectURL(url);resourceUrls.delete(url);}
    throw error;
  });
  runtimePromises.set(kind,promise);
  return promise;
}

addEventListener('pagehide',()=>{
  resourceUrls.forEach(url=>URL.revokeObjectURL(url));resourceUrls.clear();
  runtimePromises.clear();embeddedAssets=null;
});
