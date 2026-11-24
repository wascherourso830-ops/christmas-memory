# 第三方来源与许可

## 圣诞树实现参考

本原型的树形粒子分布、聚合／散开／照片聚焦三态和手势操作参考并改写自：

- [electronicminer/gesture-Christmas_tree-3d_with_photo](https://github.com/electronicminer/gesture-Christmas_tree-3d_with_photo)
- [触屏与手势实现](https://github.com/electronicminer/gesture-Christmas_tree-3d_with_photo/blob/main/christmas_tree_touch%26gesture.html)
- [原始 MIT 许可证](https://github.com/electronicminer/gesture-Christmas_tree-3d_with_photo/blob/main/LICENSE)

通过 GitHub 插件查看，核对日期：2026-11-23。未保留原项目的访客统计、地图、外部字体、图标服务及本地图片扫描逻辑。当前示意卡片由 Canvas 绘制，不取用上游照片。

```text
MIT License

Copyright (c) 2025 Pan  Wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Three.js

采用 [Three.js 官方 r160](https://github.com/mrdoob/three.js/tree/r160)，版本 0.160.0。代码与完整 MIT 许可保存于 `vendor/three/`。`build/three.module.js` 内容为官方 `three.module.min.js`。

## MediaPipe

采用 [Google MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe)，版本 0.10.3，代码许可证为 Apache-2.0。组件来自官方发布的 [npm 0.10.3 包](https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.3)，包含 `vision_bundle.mjs` 及 SIMD／非 SIMD 的 WASM 加载器与二进制。完整 Apache-2.0 许可保存于 `vendor/mediapipe/LICENSE`。

正式识别改用 Google 官方 [Gesture Recognizer float16 第 1 版模型](https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task)，本地文件名为 `gesture_recognizer.task`，8,373,440 字节。下载地址由 [官方示例固定提交中的 notebook](https://github.com/google-ai-edge/mediapipe-samples/blob/c29e185dc1d1ae6003df30868b632328b40a51da/examples/gesture_recognizer/python/gesture_recognizer.ipynb) 核验；本地文件同时通过 Google 存储 MD5 与官方资产 SHA-256 校验。

```text
SHA-256: 97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482
Google MD5 (Base64): Tb9IXEcyB2URAKGJU0PzWg==
```

接口使用本地 `GestureRecognizer.createFromOptions`、`recognizeForVideo` 及返回的 `gestures`、`landmarks`。官方类别是主识别路径，`pose-resolver.js` 在类别不明确时结合保守几何回退；未新增付费 API、运行时外部识别服务或 npm 安装。

正式页面在本地 classic Worker 中运行 CPU 识别，主线程只采样并接收结果。Worker 使用同一份官方组件、WASM 和模型，单文件内嵌所需源码；不增加外部服务，也不改变原组件许可。

WASM loader 原文在 Worker 的非严格脚本全局执行，采用该版本官方 `ModuleFactory` 与 `Module.wasmBinary` 入口直接初始化；不再通过主文档 Blob URL 导入代码或读取二进制。原始 loader 和 WASM 文件未修改，仍使用资源清单中的哈希进行校验。

原 [Hand Landmarker float16 第 1 版模型](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task) 仅保留在源目录供旧关键点 QA 使用，由 `loadHandRuntime('landmarks')` 显式载入。正式单文件只内联新手势模型，不同时内联两个模型。组件和两种模型的来源、版本、字节数及校验记录保存在 `vendor/mediapipe/resource-manifest.json`，本次核对日期为 2026-11-24。

识别资源保存在本地 `vendor/mediapipe/`，所需代码、两种 WASM 加载器／二进制和当前手势模型在单文件交付时内联，日常运行不访问 jsDelivr、Google 或其它模型下载服务。普通源码页面通过 localhost 读取同目录资源。摄像头自动申请系统权限，再初始化本地模型；画面在本机识别，不上传到外部服务，也不显示摄像头预览。
