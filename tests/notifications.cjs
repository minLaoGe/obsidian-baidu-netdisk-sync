const assert=require('node:assert/strict'),esbuild=require('esbuild');
const notices=[];const mock={Platform:{isDesktopApp:false},FileSystemAdapter:class{},TFile:class{},Notice:class{constructor(message){notices.push(message)}}};
const b=esbuild.buildSync({entryPoints:['src/sync/engine.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);const {SyncEngine}=m.exports;
(async()=>{
 const paths=Array.from({length:25},(_,i)=>i+'.md');
 const engine=new SyncEngine({vault:{configDir:'.custom',adapter:{},getFiles:()=>paths.map(path=>({path}))}},()=>({accessToken:'test',remoteBasePath:'/root',ignoredPatterns:[]}),{listFiles:async()=>paths.map(path=>({path:'/root/'+path,fsId:path,md5:'remote',isdir:0}))});
 engine.log=()=>{};engine.stateStore={getAll:()=>({}),getConflicts:()=>[],save:async()=>{},setLastFullSyncTimestamp:()=>{}};
 engine.inspectLocalFile=async()=>({exists:true,md5:'local'});engine.executeAction=async()=>engine.notifyConflict();
 const result=await engine.runFullSync();assert.equal(result.conflicted,25);assert.equal(notices.length,1);assert.match(notices[0],/同步完成/);
 notices.length=0;for(let i=0;i<25;i++)engine.notifyConflict();assert.equal(notices.length,1);
 notices.length=0;engine.interactiveConflictRequests=1;engine.notifyConflict();assert.equal(notices.length,0);
 console.log('PASS: 25 conflicts produce one sync summary; local conflict bursts are throttled; batch conflicts stay quiet');
})().catch(e=>{console.error(e);process.exitCode=1});
