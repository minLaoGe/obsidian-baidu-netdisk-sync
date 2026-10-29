const assert=require('node:assert/strict'),esbuild=require('esbuild');
globalThis.crypto ||= require('node:crypto').webcrypto;
const mock={Platform:{isDesktopApp:false},FileSystemAdapter:class{}};
function load(entry){const m={exports:{}};new Function('require','module','exports',esbuild.buildSync({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']}).outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);return m.exports;}
const {AtomicFileSystem}=load('src/utils/atomic.ts');const {remoteTime,writeTimes}=load('src/utils/timestamps.ts');
class Disk{
 constructor(){this.files=new Map();this.times=new Map();this.dirs=new Set();this.failRename=false;}
 async exists(p){return this.files.has(p)||this.dirs.has(p)}
 async mkdir(p){this.dirs.add(p)}
 async write(p,s){return this.writeBinary(p,new TextEncoder().encode(s).buffer)}
 async writeBinary(p,b,opts){this.files.set(p,new Uint8Array(b).slice());this.times.set(p,{mtime:Date.now(),ctime:Date.now(),...opts})}
 async readBinary(p){return this.files.get(p).slice().buffer}
 async read(p){return new TextDecoder().decode(await this.readBinary(p))}
 async stat(p){return this.files.has(p)?{type:'file',size:this.files.get(p).length,...this.times.get(p)}:null}
 async remove(p){this.files.delete(p);this.times.delete(p)}
 async rename(a,b){if(this.failRename)throw Error('injected rename failure');this.files.set(b,this.files.get(a));this.times.set(b,this.times.get(a));await this.remove(a)}
 async list(p){return{files:[...this.files.keys()].filter(f=>f.startsWith(p+'/')),folders:[]}}
}
(async()=>{
 for(const platform of ['android','ios']){
  const disk=new Disk(),writer=new AtomicFileSystem({vault:{configDir:'.obsidian',adapter:disk}});
  await writer.atomicWrite('note.md','remote',undefined,{mtime:1600000000000,ctime:1500000000000});assert.equal((await disk.stat('note.md')).mtime,1600000000000);assert.equal((await disk.stat('note.md')).ctime,1500000000000);
  // Recovery of a first write retains staged metadata when rename is unavailable.
  disk.failRename=true;await assert.rejects(writer.atomicWrite('new.md','new',undefined,{mtime:1400000000000,ctime:1300000000000}));assert.equal(await disk.read('new.md'),'new');assert.equal((await disk.stat('new.md')).mtime,1400000000000);
 }
 for(const value of [undefined,null,0,-1,NaN,Infinity,'not a time',{},1e30])assert.equal(remoteTime(value),undefined);
 assert.equal(remoteTime('1600000000'),1600000000000);assert.deepEqual(writeTimes({mtime:-1,ctime:Infinity}),{});
 console.log('PASS: Android/iOS adapter timestamp options, recovery preserves staged times, invalid remote times rejected');
})().catch(e=>{console.error(e);process.exitCode=1});
