const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const vm = require('node:vm');
for (const profile of ['android', 'ios']) {
const notices=[];
const platform = {isMobile:true,isDesktopApp:false,isAndroidApp:profile==='android',isIosApp:profile==='ios'};
const mock = {Platform:platform,Plugin:class{},PluginSettingTab:class{},Modal:class{},Notice:class{constructor(text,duration){this.text=text;this.duration=duration;notices.push(this);}setMessage(text){this.text=text;}hide(){this.hidden=true;}},TFile:class{},FileSystemAdapter:class{},Component:class{register(){}}};
const context = {console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,crypto:globalThis.crypto || require('node:crypto').webcrypto,setTimeout,clearTimeout,window:{setTimeout,clearTimeout,setInterval,clearInterval},module:{exports:{}},exports:{},require(id){assert.equal(id,'obsidian','Mobile must not load Node modules');return mock;}};
context.exports=context.module.exports;
vm.runInNewContext(esbuild.buildSync({entryPoints:['src/main.ts'],bundle:true,platform:'browser',format:'cjs',write:false,external:['obsidian','fs/promises']}).outputFiles[0].text,context);
assert.equal(typeof context.module.exports.default,'function');
const plugin=new context.module.exports.default();
assert.equal(plugin.settings.mobileManualSync,true,profile+' defaults to manual sync');
let updated=false;
plugin.mobileProgress = { update: () => { updated = true; }, render: () => {}, open: () => {} };
plugin.updateStatusBar('同步变更 (1/10)',true);
assert.equal(updated, true);
plugin.onunload();
notices.length=0;

context.module={exports:{}};context.exports=context.module.exports;
vm.runInNewContext(esbuild.buildSync({entryPoints:['src/sync/engine.ts'],bundle:true,platform:'browser',format:'cjs',write:false,external:['obsidian','fs/promises']}).outputFiles[0].text,context);
(async()=>{
 const settings={mobileManualSync:false,syncPaused:false,accessToken:'test',ignoredPatterns:[]};
 const engine=new context.module.exports.SyncEngine({vault:{configDir:'.obsidian',adapter:{}}},()=>settings,{});
 engine.shouldIgnore=()=>false;
 let release;const held=engine.syncMutex.acquire(()=>new Promise(r=>release=r));
 await Promise.resolve();await Promise.resolve();
 const queued=engine.syncSingleFile('note.md',true);
 settings.mobileManualSync=true;release();await held;await queued;
 // No adapter or network methods exist: queued work must return before I/O.
 engine.handleLocalFileDeleted({path:'note.md'});assert.equal(engine.debounceManager.timers.size,0);
 settings.mobileManualSync=false;engine.handleLocalFileDeleted({path:'note.md'});assert.equal(engine.debounceManager.timers.size,1);
 engine.dispose();assert.equal(engine.debounceManager.timers.size,0);
 await engine.syncSingleFile('note.md',true);
 // Execute the bounded journal writer in the same browser-only sandbox, not
 // merely import it: mobile must persist identity without fs/Buffer/Node APIs.
 context.module={exports:{}};context.exports=context.module.exports;
 vm.runInNewContext(esbuild.buildSync({entryPoints:['src/sync/rolling-journal.ts'],bundle:true,platform:'browser',format:'cjs',write:false,external:['obsidian']}).outputFiles[0].text,context);
 const {RollingJournal}=context.module.exports,storage=new Map(),cloud=new Map();let completed=0;
 const app={loadLocalStorage:k=>storage.get(k)||null,saveLocalStorage:(k,v)=>{if(v===null)storage.delete(k);else storage.set(k,v);}};
 const client={uploadFile:async(p,b)=>{cloud.set(p,new Uint8Array(b));return{fsId:'1',md5:'hash'};}};
 const journal=new RollingJournal(app,client,'/root/index','scope',p=>typeof p==='string',()=>{});
 await Promise.all(Array.from({length:70},(_,i)=>journal.mutate([profile+'/'+i+'.md'],async()=>{completed++;})));
 assert.equal(completed,70);assert.equal(cloud.size,1);
 const bytes=[...cloud.values()][0],stored=JSON.parse(new TextDecoder().decode(bytes));
 assert.equal(stored.entries.length,64);assert.equal(stored.entries.at(-1).sequence,70);assert(bytes.length<=256*1024);
 console.log('PASS: '+profile+' bounded journal executes 70 queued writes without Node and retains one device file');
 console.log('PASS: '+profile+' loads without Node, defaults to manual sync, displays progress, blocks queued uploads and cleans up');
})().catch(e=>{console.error(e);process.exitCode=1});

}
