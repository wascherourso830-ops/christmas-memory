/**
 * 生成可双击的离线单文件，不安装任何依赖。
 * 输入：HTML/CSS/应用模块、vendor/three 与 vendor/mediapipe 中的代码、WASM、模型和许可证。
 * 输出：本目录「圣诞光屿.html」；照片和摄像头数据不进入构建产物。
 * 运行：node build-standalone.cjs（只校验并显示计划）；node build-standalone.cjs --write（显式生成）。
 * 失败：打印中文错误并保留已有产物和所有源文件；修正输入后重试。
 * 边界：这是仅支持当前项目 import/export 形式的受限打包器，未知语法会报错，不做静默删除。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = __dirname;
const output = path.join(root, '圣诞光屿.html');
function main() {
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--write') || args.length > 1) {
  console.error('用法：node build-standalone.cjs [--write]');
  process.exitCode = 1;
} else if (!args.includes('--write')) {
  console.log('预览：读取页面、应用模块、本地 Three.js 与 MediaPipe 组件、WASM 和官方手势模型。');
  console.log('计划输出：' + output);
  console.log('运行 node build-standalone.cjs --write 后才会生成或覆盖单文件；源文件保持不变。');
  try { build(false); } catch (error) {
    console.error('预览校验失败：'+error.message+'。未写入任何产物。');process.exitCode=1;
  }
} else {
  try { build(); } catch (error) {
    console.error('单文件生成失败：' + error.message + '。已有产物和源文件保持不变。');
    process.exitCode = 1;
  }
}
}

const upstreamLicense = "MIT License\n\nCopyright (c) 2025 Pan  Wang\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n";

function read(relative) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw new Error('输入路径越界：' + relative);
  return fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n');
}

function resolveModule(specifier, importer) {
  let resolved;
  if (specifier === 'three') resolved = 'vendor/three/build/three.module.js';
  else if (specifier.startsWith('three/addons/')) resolved = 'vendor/three/examples/jsm/' + specifier.slice('three/addons/'.length);
  else if (specifier.startsWith('.')) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  else throw new Error('未知模块来源：' + specifier + '（' + importer + '）');
  if (resolved.startsWith('../') || path.posix.isAbsolute(resolved) || !/\.(?:m?js)$/.test(resolved)) throw new Error('模块路径不受支持：' + resolved);
  return resolved;
}

function parseNames(list, label) {
  return list.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(item);
    if (!match) throw new Error(label + '含不支持的绑定：' + item);
    return { local: match[1], alias: match[2] || match[1] };
  });
}

function bundleModules() {
  const registry = new Map();
  const chunks = [];
  const active = new Set();
  function visit(modulePath) {
    if (active.has(modulePath)) throw new Error('不支持循环模块：' + modulePath);
    if (registry.has(modulePath)) return registry.get(modulePath);
    const id = registry.size;
    registry.set(modulePath, id);
    active.add(modulePath);
    let source = read(modulePath);
    if (modulePath === 'vendor/mediapipe/vision_bundle.mjs') source = source.replace(/^\s*\/\/# sourceMappingURL=.*$/gm, '');
    const imports = [];
    // 仅转换完整静态声明，未知语法会在下方检查时报错。
    const importPattern = /^[ \t]*import\s+(\*\s+as\s+[A-Za-z_$][\w$]*|\{[\s\S]*?\})\s+from\s+(['"])([^'"\r\n]+)\2\s*;[ \t]*/gm;
    source = source.replace(importPattern, (full, binding, quote, specifier) => {
      imports.push({ binding, specifier });
      return '';
    });
    const bindings = imports.map(({ binding, specifier }) => {
      const dependency = visit(resolveModule(specifier, modulePath));
      if (binding.startsWith('*')) {
        const name = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(binding)?.[1];
        if (!name) throw new Error('不支持的命名空间导入：' + modulePath);
        return 'const ' + name + ' = __modules[' + dependency + '];';
      }
      const names = parseNames(binding.slice(1, -1), modulePath + ' 导入');
      return 'const {' + names.map(item => item.local + ':' + item.alias).join(',') + '} = __modules[' + dependency + '];';
    });
    const exports = [];
    // Three.js 压缩模块的导出位于文件结尾，其他官方模块也遵循此形式。
    source = source.replace(/\bexport\s*\{([^}]+)\}\s*;?\s*$/, (full, list) => {
      exports.push(...parseNames(list, modulePath + ' 导出'));
      return '';
    });
    source = source.replace(/^[ \t]*export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, (full, name) => {
      exports.push({ local: name, alias: name });
      return 'function ' + name + '(';
    });
    const properties = exports.map(item => item.alias + ':' + item.local).join(',');
    const compiled = '__modules[' + id + '] = (() => {\n"use strict";\n' + bindings.join('\n') + '\n' + source + '\nreturn Object.freeze({' + properties + '});\n})();';
    // 残留的 export、静态 import、import.meta 和其他未知语法都会在此失败。
    new vm.Script(compiled, { filename: modulePath });
    chunks.push('// 模块：' + modulePath + '\n' + compiled);
    active.delete(modulePath);
    return id;
  }
  visit('app.js');
  return { script: 'const __modules = [];\n' + chunks.join('\n\n'), moduleCount: registry.size };
}

function build(writeOutput=true) {
  // 在正式写入之前完成打包、HTML 替换和脚本语法验证。
  const { script, moduleCount } = bundleModules();
  const manifest = JSON.parse(read('vendor/mediapipe/resource-manifest.json'));
  if (!manifest.complete) throw new Error('本地识别资源不完整，停止生成交付文件');
  const handAssets = {};
  for (const name of ['vision_bundle.mjs','vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm','gesture_recognizer.task']) {
    const relative = name.endsWith('.task')||name==='vision_bundle.mjs' ? name : 'wasm/'+name;
    const bytes = fs.readFileSync(path.join(root,'vendor/mediapipe',relative));
    const record = manifest.files.find(file=>file.file===relative);
    if (!record || crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('本地识别资源校验失败：'+relative);
    handAssets[name]=bytes.toString('base64');
  }
  let html = read('index.html');
  const css = read('style.css');
  if (/<\/style/i.test(css)) throw new Error('CSS 包含不支持的 style 结束标记');
  const stylePattern = /<link\s+rel="stylesheet"\s+href="style\.css"\s*\/?>/g;
  if ([...html.matchAll(stylePattern)].length !== 1) throw new Error('未找到唯一的本地样式入口');
  html = html.replace(stylePattern, () => '<style>\n' + css + '\n</style>');
  const importMapPattern = /<script\s+type="importmap">[\s\S]*?<\/script>/g;
  if ([...html.matchAll(importMapPattern)].length !== 1) throw new Error('未找到唯一的 importmap');
  html = html.replace(importMapPattern, '');
  const entryPattern = /<script\s+type="module">import\('\.\/app\.js'\)\.catch\([\s\S]*?<\/script>/g;
  if ([...html.matchAll(entryPattern)].length !== 1) throw new Error('未找到唯一的应用入口');
  const license = [
    '圣诞光屿：可离线打开的本地单文件。照片只保留在本页面内存中。',
    '渲染组件：https://github.com/mrdoob/three.js/tree/r160',
    read('vendor/three/LICENSE').trim(),
    '粒子布局与交互参考：https://github.com/electronicminer/gesture-Christmas_tree-3d_with_photo',
    upstreamLicense.trim(),
    '手势识别组件：https://github.com/google-ai-edge/mediapipe；版本 0.10.3；完整许可见内联 third-party-licenses。'
  ].join('\n\n');
  if (license.includes('*/')) throw new Error('许可文本包含不支持的注释终止符');
  const failure = [
    'console.error(error);',
    'const loader = document.querySelector("#loader");',
    'if (loader) { loader.style.opacity = 1; loader.innerHTML = "<span class=\\"loading-star\\">✧</span><p>圣诞树暂时没有点亮</p><small>请使用 Chrome 或 Edge 打开，并检查浏览器是否支持 WebGL。</small>"; }'
  ].join('\n');
  const inline = '/*\n' + license + '\n*/\n(() => {\n"use strict";\ntry {\n' + script + '\n} catch (error) {\n' + failure + '\n}\n})();';
  new vm.Script(inline, { filename: '圣诞光屿.inline.js' });
  // HTML 解析器先于 JS 解析器识别结束标签，必须转义所有大小写形式。
  const escaped = inline.replace(/<\/script/gi, '<\\/script');
  new vm.Script(escaped, { filename: '圣诞光屿.inline.js' });
  const legalText=JSON.stringify({MediaPipe:read('vendor/mediapipe/LICENSE')}).replace(/<\/script/gi,'<\\/script');
  html = html.replace(entryPattern, () => '<script type="application/json" id="third-party-licenses">'+legalText+'</script>\n<script type="application/json" id="hand-runtime-assets">'+JSON.stringify(handAssets)+'</script>\n<script>\n' + escaped + '\n</script>');
  if (/<script[^>]+\bsrc\s*=/i.test(html) || /type="(?:module|importmap)"/i.test(html) || /href="style\.css"/i.test(html)) throw new Error('交付文件仍含外部入口');
  const scriptMatches = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)];
  if (scriptMatches.length !== 1) throw new Error('交付文件脚本数量异常');
  new vm.Script(scriptMatches[0][1], { filename: '圣诞光屿.extracted.js' });
  if (!writeOutput) {
    console.log('预览校验通过：'+moduleCount+' 个模块，预计 '+Buffer.byteLength(html)+' 字节；资源哈希与提取脚本语法均通过。');
    console.log('仅内联 gesture_recognizer.task；原 hand_landmarker.task 保留在源目录供关键点 QA 使用。');
    return;
  }
  const temporary = output + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(temporary, html, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log('已生成：' + output);
  console.log('已内联 ' + moduleCount + ' 个模块；提取后的脚本语法检查通过；共 ' + Buffer.byteLength(html) + ' 字节。');
  console.log('识别组件、WASM 与官方手势模型已完整内联；打开后自动申请摄像头，无需联网下载。');
}

main();

