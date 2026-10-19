// Opt-in real Baidu upload benchmark. Only random synthetic bytes go to a new
// sibling directory; never reads note contents or changes the user's baseline.
const fs=require('node:fs'), path=require('node:path'),crypto=require('node:crypto'), esbuild=require('esbuild');
const largeOnly=process.argv.includes('--large-only');
const resultFile=largeOnly?'benchmark-large-results.json':'benchmark-results.json';
const settingsPath=process.argv[2];if(!settingsPath)throw Error('Pass local plugin data.json path');
const credentials=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
let requestTimings=[];
const mock={requestUrl:async o=>{
 const start=performance.now();
 const res=await fetch(o.url,{method:o.method||'GET',headers:o.headers,body:o.body,signal:AbortSignal.timeout(60000)});
 const body=await res.arrayBuffer();
 const url=new URL(o.url);requestTimings.push({stage:url.searchParams.get('method'),ms:performance.now()-start,status:res.status});
 if(!res.ok)throw Error('HTTP '+res.status);
 return {status:res.status,arrayBuffer:body,text:Buffer.from(body).toString(),get json(){return JSON.parse(Buffer.from(body).toString())}};
}};
function load(file){let r=esbuild.buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});let m={exports:{}};new Function('require','module','exports',r.outputFiles[0].text)(x=>x==='obsidian'?mock:require(x),m,m.exports);return m.exports;}
const {BaiduClient}=load('src/api/baidu-client.ts');
const {runBounded}=load('src/sync/queue.ts');
const client=new BaiduClient({...credentials,secretKey:credentials.secretKey, onTokenRefreshed:async()=>{throw Error('Benchmark requires a fresh token; reload credentials')}});
const directory=credentials.remoteBasePath.replace(/\/$/,'')+'-benchmark-'+Date.now();
const results=[];
(async()=>{
 if(credentials.tokenExpiresAt && credentials.tokenExpiresAt-Date.now()<300000)throw Error('Token near expiry; benchmark postponed');
 fs.mkdirSync('artifacts',{recursive:true});
 fs.writeFileSync('artifacts/benchmark-pending.json',JSON.stringify({directory}));
 await client.createDirectory(directory);
 for(let round=0;round<(largeOnly?1:4);round++){
  const concurrency=[1,3,3,1][round];
  const files=Array.from({length:largeOnly?1:9},(_,i)=>({name:`round-${round}-${i}.bin`,data:crypto.randomBytes(largeOnly?5*1024*1024+17:[16,128,512][i%3]*1024)}));
  requestTimings=[];const started=performance.now();
  await runBounded(files,concurrency,async f=>{const uploaded=await client.uploadFile(directory+'/'+f.name,f.data);f.fsId=uploaded.fsId;});
  const elapsedMs=performance.now()-started,bytes=files.reduce((n,f)=>n+f.data.length,0);
  const result={round:round+1,concurrency,files:files.length,bytes,seconds:+(elapsedMs/1000).toFixed(3),filesPerSecond:+(files.length/(elapsedMs/1000)).toFixed(3),MiBPerSecond:+(bytes/1048576/(elapsedMs/1000)).toFixed(3),requests:requestTimings.length,stageMeans:Object.fromEntries([...new Set(requestTimings.map(r=>r.stage))].map(stage=>{const v=requestTimings.filter(r=>r.stage===stage);return [stage,Math.round(v.reduce((n,r)=>n+r.ms,0)/v.length)]}))};
  results.push(result);console.log(JSON.stringify(result));
  for(const file of files){const downloaded=Buffer.from(await client.downloadFile(file.fsId));if(!downloaded.equals(file.data))throw Error('Downloaded bytes differ from uploaded test file');}
  console.log('Round byte-for-byte download verification passed');
  fs.writeFileSync('artifacts/'+resultFile,JSON.stringify({directory,results},null,2));
 }
})().catch(e=>{console.error('Benchmark failed:',String(e.message).replace(/access_token=[^&\s]+/g,'access_token=REDACTED'));process.exitCode=1;}).finally(async()=>{
 try{await client.deleteFile(directory);const remains=(await client.listFiles(path.posix.dirname(directory),false)).some(f=>f.path===directory);if(remains)throw Error('Benchmark directory still present');console.log('Benchmark directory cleaned');fs.writeFileSync('artifacts/benchmark-cleanup.json',JSON.stringify({directory,removed:true}));fs.unlinkSync('artifacts/benchmark-pending.json');}catch(e){console.error('Cleanup needs retry (directory recorded in artifacts/benchmark-pending.json)');process.exitCode=1;}
});
