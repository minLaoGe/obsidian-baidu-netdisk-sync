const assert=require('node:assert/strict'),esbuild=require('esbuild');
const mock={Platform:{isDesktopApp:false},FileSystemAdapter:class{},Notice:class{},TFile:class{}};
const b=esbuild.buildSync({entryPoints:['src/sync/engine.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);const {SyncEngine}=m.exports;
(async()=>{
 let listings=0,creates=0,saves=0,actions=[];
 const app={vault:{configDir:'.custom',adapter:{},getFiles:()=>Array.from({length:100},(_,i)=>({path:i+'.md'}))}};
 const bases=Object.fromEntries(app.vault.getFiles().map(f=>[f.path,{localMd5:'same',remoteMd5:'same'}]));
 const engine=new SyncEngine(app,()=>({accessToken:'test',remoteBasePath:'/test',ignoredPatterns:[],uploadConcurrency:3}),{listFiles:async()=>{listings++;return app.vault.getFiles().map(f=>({path:'/test/'+f.path,md5:'same',fsId:f.path,isdir:0}))},createDirectory:async()=>{creates++}});
 engine.log=()=>{};engine.stateStore={get:p=>bases[p],getAll:()=>bases,save:async()=>{saves++},setLastFullSyncTimestamp:()=>{}};
 engine.inspectLocalFile=async()=>({exists:true,md5:'same'});engine.executeAction=async(p,r,d)=>actions.push(d.action);
 let result=await engine.runFullSync();
 assert.equal(result.skipped,100);assert.equal(listings,1);assert.equal(creates,0);assert.equal(saves,0);assert.deepEqual(actions,[]);
 await engine.syncSingleFile('0.md',true);
 assert.equal(listings,1);assert.equal(saves,0);assert.deepEqual(actions,[]);
 engine.inspectLocalFile=async()=>({exists:true,md5:'changed'});
 await engine.syncSingleFile('0.md',true);
 assert.equal(listings,2);assert.equal(saves,1);assert.deepEqual(actions,['upload']);
 // An explicit/full remote check must not skip a change made on another device.
 engine.inspectLocalFile=async()=>({exists:true,md5:'same'});
 engine.inspectRemoteFile=async()=>({exists:true,md5:'remote-edit',fsId:'x'});
 await engine.syncSingleFile('0.md');assert.equal(actions.at(-1),'download');
 // Pausing blocks both full sync and local-change jobs, including remote IO.
 engine.getSettings=()=>({accessToken:'test',remoteBasePath:'/test',syncPaused:true});
 const before={listings,saves,actions:actions.length};
 await engine.runFullSync();await engine.syncSingleFile('0.md',true);
 assert.deepEqual({listings,saves,actions:actions.length},before);
 console.log('PASS: 100 unchanged files = one listing, zero uploads/creates/checkpoints; identical local saves = zero network; local and remote edits still sync');
})().catch(e=>{console.error(e);process.exitCode=1});
