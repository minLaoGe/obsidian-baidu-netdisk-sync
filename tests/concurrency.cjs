const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const mock = { Platform:{isDesktopApp:false},FileSystemAdapter:class{},Notice:class{},TFile:class{} };
function load(file){const r=esbuild.buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',r.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);return m.exports;}
const {runBounded}=load('src/sync/queue.ts');
const {SyncEngine}=load('src/sync/engine.ts');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let active=0,peak=0,done=[];
 await runBounded(Array.from({length:9},(_,i)=>i),3,async i=>{active++;peak=Math.max(peak,active);await delay(5);active--;done.push(i)});
 assert.equal(peak,3);assert.equal(done.length,9);
 let drained=false,claimed=[];
 await assert.rejects(runBounded([0,1,2,3,4],2,async i=>{claimed.push(i);if(i===0){await delay(2);throw Error('fail')}await delay(15);drained=true;}));
 assert.equal(drained,true);assert.deepEqual(claimed,[0,1]);
 // Exercise the real full-sync scheduler. Uploads are bounded, failed uploads
 // have no baseline, disk checkpoints never overlap, and destructive work waits.
 for(const count of [1,3]){
  active=0;peak=0;let saving=0,saved=0,deleted=false,saveTail=Promise.resolve();
  const paths=['a.md','b.md','failed.md','c.md','delete.md'];
  const baseline={};
  const app={vault:{configDir:'.custom',getFiles:()=>paths.filter(p=>p!=='delete.md').map(path=>({path})),adapter:{}}};
  const engine=new SyncEngine(app,()=>({accessToken:'test',remoteBasePath:'/test',uploadConcurrency:count,ignoredPatterns:[]}),{createDirectory:async()=>{},listFiles:async()=>[{path:'/test/delete.md',fsId:'x',md5:'remote',serverMtime:1,isdir:0}]});
  engine.log=()=>{};
  engine.stateStore={getAll:()=>({'delete.md':{localMd5:'local',remoteMd5:'remote'}}),setLastFullSyncTimestamp:()=>{},save:()=>{saveTail=saveTail.then(async()=>{assert.equal(saving,0);saving++;await delay(1);saving--;saved++});return saveTail;}};
  engine.inspectLocalFile=async path=>path==='delete.md'?{exists:false}:{exists:true,md5:'local',size:8};
  engine.executeAction=async(path,remote,decision)=>{
   if(decision.action==='delete_remote'){assert.equal(active,0);deleted=true;return;}
   assert.equal(deleted,false);active++;peak=Math.max(peak,active);
   await delay(path==='a.md'?12:5);active--;
   if(path==='failed.md')throw Error('injected upload failure');
   baseline[path]=true;
  };
  const result=await engine.runFullSync();
  assert.equal(peak,count);assert.equal(result.uploaded,3);assert.equal(result.errors.length,1);assert.equal(result.errors[0].path,'failed.md');assert.equal(baseline['failed.md'],undefined);assert.equal(deleted,true);assert.equal(active,0);assert.equal(saved,5);
 }
 // A checkpoint failure must not release the global mutex before the other
 // upload finishes; queued single-file work can only start after full sync drains.
 {
  let inFlight=0,secondFinished=false,singleStarted=false;
  const app={vault:{configDir:'.custom',adapter:{},getFiles:()=>['a','b'].map(path=>({path}))}};
  const engine=new SyncEngine(app,()=>({accessToken:'test',remoteBasePath:'/test',uploadConcurrency:2,ignoredPatterns:[]}),{createDirectory:async()=>{},listFiles:async()=>[]});
  engine.log=()=>{};engine.stateStore={getAll:()=>({}),save:async()=>{throw Error('checkpoint failed')}};
  engine.inspectLocalFile=async()=>({exists:true,md5:'local'});
  engine.executeAction=async p=>{inFlight++;await delay(p==='a'?2:20);inFlight--;if(p==='b')secondFinished=true;};
  const full=engine.runFullSync();
  await delay(1);
  const single=engine.syncMutex.acquire(async()=>{assert.equal(inFlight,0);assert.equal(secondFinished,true);singleStarted=true;});
  await Promise.all([full,single]);assert.equal(singleStarted,true);
 }
 console.log('PASS: bounded uploads, drain on failure, serialized checkpoints, failed baselines, deletion barriers, full/single sync isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
