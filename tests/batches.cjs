const assert=require('node:assert/strict'),esbuild=require('esbuild');
function load(path,mock){const b=esbuild.buildSync({entryPoints:[path],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);return m.exports;}
(async()=>{
 let response,request;
 const {BaiduClient}=load('src/api/baidu-client.ts',{requestUrl:async r=>{request=r;return {json:response};}});
 const c=new BaiduClient({appKey:'a',secretKey:'s',accessToken:'t',refreshToken:'r',tokenExpiresAt:Date.now()+1e9});
 response={errno:0,info:[{path:'/a',errno:0},{path:'/b',errno:12},{path:'/c',errno:-9}]};
 const r=await c.deleteFiles(['/a','/b','/c','/missing']);assert.equal(r.get('/a'),undefined);assert.ok(r.get('/b'));assert.equal(r.get('/c'),undefined);assert.ok(r.get('/missing'));assert.equal(JSON.parse(new URLSearchParams(request.body).get('filelist')).length,4);
 response={errno:0};assert.ok((await c.deleteFiles(['/a'])).get('/a'));
 await assert.rejects(c.deleteFiles(Array(51).fill('/a')));
 const {SyncEngine}=load('src/sync/engine.ts',{Platform:{isMobile:false,isDesktopApp:false},FileSystemAdapter:class{},TFile:class{},Notice:class{}});
 for(const mode of ['partial','network','modified']){
  const paths=Array.from({length:55},(_,i)=>`${i}.md`),base=Object.fromEntries(paths.map(p=>[p,{localMd5:'old',remoteMd5:'remote',remoteFsId:p}]));
  const remote=paths.map(p=>({path:'/root/'+p,md5:'remote',fsId:p,size:1,serverMtime:1,isdir:0}));let calls=[],removed=[],saved=0;
  const client={listFiles:async()=>remote,deleteFiles:async ps=>{calls.push(ps);if(mode==='network')throw Error('DNS failure');return new Map(ps.map(p=>[p,p==='/root/1.md'&&mode==='partial'?'denied':undefined]));}};
  const e=new SyncEngine({vault:{configDir:'.custom',getFiles:()=>[],adapter:{}}},()=>({incrementalSync:true,accessToken:'t',remoteBasePath:'/root',ignoredPatterns:[]}),client);
  e.log=()=>{};e.shouldIgnore=()=>false;e.inspectLocalFile=async p=>mode==='modified'&&p==='2.md'?{exists:true,md5:'edited'}:{exists:false};
  e.remoteIndex=()=>({inventory:async()=>({files:remote,incremental:true,changed:55}),mutateMany:async(ps,op)=>op()});
  e.stateStore={getAll:()=>base,getConflicts:()=>[],delete:p=>removed.push(p),save:async()=>{saved++;},setLastFullSyncTimestamp:()=>{}};
  // For modified scenario change after planning, during execution recheck.
  let checks=0;if(mode==='modified')e.inspectLocalFile=async p=>{checks++;return checks>55&&p==='2.md'?{exists:true,md5:'edited'}:{exists:false};};
  const result=await e.runFullSync();
  if(mode==='network'){assert.equal(calls.length,1);assert.equal(removed.length,0);assert.equal(result.deleted,0);}
  else {assert.equal(calls.length,2);assert.ok(calls.every(x=>x.length<=50));assert.equal(removed.length,54);assert.ok(!removed.includes(mode==='partial'?'1.md':'2.md'));if(mode==='partial')assert.equal(result.errors.length,1);}
 }
 const paths=Array.from({length:43},(_,i)=>`upload-${i}.md`);let active=0,peak=0,done=0,batches=0;
 const uploader=new SyncEngine({vault:{getFiles:()=>paths.map(path=>({path})),adapter:{}}},()=>({accessToken:'t',remoteBasePath:'/root',ignoredPatterns:[],uploadConcurrency:3}),{listFiles:async()=>[],createDirectory:async()=>{}},text=>{if(text.startsWith('批量上传'))batches++;});
 uploader.log=()=>{};uploader.shouldIgnore=()=>false;uploader.inspectLocalFile=async()=>({exists:true,md5:'local'});
 uploader.stateStore={getAll:()=>({}),getConflicts:()=>[],save:async()=>{},setLastFullSyncTimestamp:()=>{}};
 uploader.executeAction=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;done++;};
 const uploaded=await uploader.runFullSync();assert.equal(done,43);assert.equal(uploaded.uploaded,43);assert.equal(batches,3);assert.equal(peak,3);
 console.log('PASS: 43 uploads run in three bounded batches with configured concurrency');
 console.log('PASS: batch delete item failures/missing acknowledgements, 50-item bound, partial checkpoints, stop on network failure, changed-file exclusion');
})().catch(e=>{console.error(e);process.exitCode=1;});
