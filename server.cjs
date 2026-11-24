// 本地静态预览：输入为当前目录文件，只读提供；退出窗口或 Ctrl+C 停止。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = __dirname;
const port = Number(process.env.CHRISTMAS_PORT || 4183);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.task':'application/octet-stream','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
const server = http.createServer((req,res)=>{
  let relative;
  try { relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname); }
  catch { res.writeHead(400);res.end();return; }
  const file = path.resolve(root,'.'+(relative==='/'?'/index.html':relative));
  if(!file.startsWith(root+path.sep)||!['GET','HEAD'].includes(req.method)){res.writeHead(403);res.end();return;}
  fs.stat(file,(error,stat)=>{
    if(error||!stat.isFile()){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD'){res.end();return;}
    fs.createReadStream(file).pipe(res);
  });
});
server.on('error',error=>{console.error('预览启动失败：'+error.message+'。可更换 CHRISTMAS_PORT 后重试。');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{
  const url='http://127.0.0.1:'+port+'/';
  console.log('圣诞光屿预览：'+url);
  if(process.argv.includes('--open')&&process.platform==='win32'){
    const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});
    opener.on('error',()=>console.log('请在 Chrome 或 Edge 中打开上面的本机地址。'));
    opener.unref();
  }
});
