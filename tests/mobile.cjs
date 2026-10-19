const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const vm = require('node:vm');
const platform = {isMobile:true,isDesktopApp:false};
const mock = {Platform:platform,Plugin:class{},PluginSettingTab:class{},Modal:class{},Notice:class{},TFile:class{},FileSystemAdapter:class{}};
const context = {console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,crypto:globalThis.crypto,setTimeout,clearTimeout,window:{setTimeout,clearTimeout,setInterval,clearInterval},module:{exports:{}},exports:{},require(id){assert.equal(id,'obsidian','Mobile must not load Node modules');return mock;}};
context.exports=context.module.exports;
vm.runInNewContext(esbuild.buildSync({entryPoints:['src/main.ts'],bundle:true,platform:'browser',format:'cjs',write:false,external:['obsidian','fs/promises']}).outputFiles[0].text,context);
assert.equal(typeof context.module.exports.default,'function');
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
 console.log('PASS: mobile bundle loads without Node; manual mode blocks queued uploads; unload cancels debounce');
})().catch(e=>{console.error(e);process.exitCode=1});
