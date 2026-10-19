import * as ort from 'onnxruntime-web/wasm';
let session:ort.InferenceSession|undefined;
self.onmessage=async(event:MessageEvent<{rgb:Uint8ClampedArray;base:string}>)=>{
 try{
  const started=performance.now(),{rgb,base}=event.data;
  ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths=`${base}vendor/`;
  const loadStarted=performance.now();
  if(!session){self.postMessage({progress:'U²-NetPモデルとWASMを読み込み中…'});session=await ort.InferenceSession.create(`${base}models/u2netp.onnx`,{executionProviders:['wasm'],graphOptimizationLevel:'all'});}
  const modelLoad=performance.now()-loadStarted,preprocessStarted=performance.now();
  self.postMessage({progress:'320×320 RGBを正規化し、実際の入力テンソルを準備中…'});
  const n=320*320,data=new Float32Array(n*3),mean=[.485,.456,.406],std=[.229,.224,.225];let max=0;
  for(let i=0;i<n;i++)for(let c=0;c<3;c++)max=Math.max(max,rgb[i*4+c]);max=Math.max(max,1e-6);
  for(let i=0;i<n;i++)for(let c=0;c<3;c++)data[c*n+i]=(rgb[i*4+c]/max-mean[c])/std[c];
  const preprocess=performance.now()-preprocessStarted,inferenceStarted=performance.now();
  self.postMessage({progress:'U²-NetPのニューラルネット推論を実行中…'});
  const result=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',data,[1,3,320,320])});
  const inference=performance.now()-inferenceStarted,normalizeStarted=performance.now();
  self.postMessage({progress:'実際のAI出力を前景確率マスクへ正規化中…'});
  const output=result[session.outputNames[0]].data as Float32Array;let lo=Infinity,hi=-Infinity;
  for(let i=0;i<n;i++){lo=Math.min(lo,output[i]);hi=Math.max(hi,output[i]);}
  if(!Number.isFinite(lo)||!Number.isFinite(hi)||hi-lo<1e-8)throw Error('AIマスクが一様です。画像を変更してください。');
  const probabilities=new Float32Array(n);for(let i=0;i<n;i++)probabilities[i]=(output[i]-lo)/(hi-lo);
  const normalize=performance.now()-normalizeStarted,total=performance.now()-started;
  self.postMessage({result:{probabilities,width:320,height:320,elapsedMs:total,timingsMs:{modelLoad,preprocess,inference,normalize,total}}},[probabilities.buffer]);
 }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};
