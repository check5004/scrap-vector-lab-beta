/** Reproducible public assets: fail closed on upstream or checksum errors. */
import {mkdir,readFile,writeFile,copyFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const digest=b=>createHash('sha256').update(b).digest('hex');
const model={url:'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',path:'public/models/u2netp.onnx',sha256:'309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',bytes:4574861};
await mkdir('public/models',{recursive:true});await mkdir('public/vendor',{recursive:true});
let data;try{data=await readFile(model.path)}catch{const r=await fetch(model.url,{signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error(`Model download HTTP ${r.status}`);data=Buffer.from(await r.arrayBuffer());}
if(data.length!==model.bytes||digest(data)!==model.sha256)throw Error('Model SHA256/length mismatch: refusing build');await writeFile(model.path,data);
for(const [name,hash] of [['ort-wasm-simd-threaded.wasm','45eaee27761ad883742a8d4b8fce1538d60ce43b51adf1726fafccc59b8c1a15'],['ort-wasm-simd-threaded.mjs','90a557d15c02bac4504d95b67f431d8594635ed2a0a62a7f2cd83d090ff91d3e']]){const source=`node_modules/onnxruntime-web/dist/${name}`,bytes=await readFile(source);if(digest(bytes)!==hash)throw Error(`Pinned runtime hash mismatch: ${name}`);await copyFile(source,`public/vendor/${name}`);}
for(const path of ['public/print/dictionary.json','public/print/a4-marker-sheet.svg','public/samples/l-shape.png','public/samples/circle-plate.png','public/samples/circle-plate.truth.json','public/samples/notched.png','public/samples/trapezoid-hole.png','public/samples/ai-l-shape.jpg','public/samples/ai-notched.jpg','public/samples/ai-trapezoid-hole.jpg','public/samples/ai-texture-provenance.json'])await access(path);
console.log('Verified U2NetP model, pinned ONNX Runtime 1.23.2, and generated sample inputs.');
