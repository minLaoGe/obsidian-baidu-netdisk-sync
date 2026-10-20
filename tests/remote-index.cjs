const assert=require('node:assert/strict'),esbuild=require('esbuild');
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
const mock={Platform:{isDesktopApp:false},FileSystemAdapter:class{},Notice:class{},TFile:class{}};
function load(file){const b=esbuild.buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);return m.exports;}
const {RemoteIndex,INDEX_DIR}=load('src/sync/remote-index.ts');
const {SyncEngine}=load('src/sync/engine.ts');
const enc=new TextEncoder(),dec=new TextDecoder();
class Disk {
  constructor() { this.files = new Map(); this.dirs = new Set(['']); this.snapshots = []; this.fail = null; }
  mutation(op, path, fn) {
    if (this.fail?.(op, path)) throw new Error('injected IO failure');
    fn(); this.snapshots.push(new Map([...this.files].map(([p, b]) => [p, b.slice()])));
  }
  async exists(p) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p) { this.dirs.add(p); }
  async write(p, s) { return this.writeBinary(p, enc.encode(s).buffer); }
  async writeBinary(p, b) { this.mutation('write', p, () => this.files.set(p, new Uint8Array(b).slice())); }
  async readBinary(p) { if (!this.files.has(p)) throw Error('missing ' + p); return this.files.get(p).slice().buffer; }
  async read(p) { return dec.decode(await this.readBinary(p)); }
  async remove(p) { this.mutation('remove', p, () => this.files.delete(p)); }
  async rename(a, b) { this.mutation('rename', b, () => { if (!this.files.has(a)) throw Error('missing source'); if (this.files.has(b)) throw Error('target exists'); this.files.set(b, this.files.get(a)); this.files.delete(a); }); }
  async stat(p) { return this.files.has(p) ? { size: this.files.get(p).length, mtime: 1, type: 'file' } : null; }
  async list(dir) { return { files: [...this.files.keys()].filter(p => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')), folders: [] }; }
  async trashLocal(p) { await this.remove(p); }
}
function appFor(disk) { return { vault: { configDir: '.custom', adapter: disk, getAbstractFileByPath: () => null } }; }

class Cloud {
 constructor(){this.files=new Map();this.calls=[];this.downloads=[];this.next=0;this.failUpload=null;this.failList=null;}
 put(path,text){const bytes=typeof text==='string'?enc.encode(text):new Uint8Array(text);const n=++this.next;this.files.set(path,{bytes,info:{path,fsId:String(n),md5:'hash'+n,size:bytes.length,serverMtime:n,isdir:0}});}
 async listFiles(root,recursive=true,shouldYield){if(shouldYield?.())throw Error('SYNC_YIELD_FOR_CONFLICT');this.calls.push([root,recursive]);if(this.failList?.(root))throw Error('listing failed');return [...this.files.values()].map(f=>f.info).filter(f=>f.path.startsWith(root+'/')&&(recursive||!f.path.slice(root.length+1).includes('/')));}
 async downloadFile(id){this.downloads.push(id);const f=[...this.files.values()].find(f=>f.info.fsId===id);if(!f)throw Error('missing cloud');return f.bytes.slice().buffer;}
 async uploadFile(path,data){if(this.failUpload?.(path))throw Error('upload failed');this.put(path,data);return {fsId:this.files.get(path).info.fsId,md5:this.files.get(path).info.md5};}
 async createDirectory(){}
 async deleteFile(path){this.files.delete(path);}
 async deleteFiles(paths){for(const p of paths)this.files.delete(p);return new Map(paths.map(p=>[p,undefined]));}
}
function setup(){const disk=new Disk(),cloud=new Cloud(),logs=[];const app=appFor(disk);return{disk,cloud,logs,index:new RemoteIndex(app,cloud,'/root','account',m=>logs.push(m),()=>false),app};}
(async()=>{
 // First scan establishes inventory; no-change round makes only a shallow journal listing.
 const x=setup();x.cloud.put('/root/a.md','old');x.cloud.put('/root/sub/b.md','b');
 const first=await x.index.inventory();assert.equal(first.incremental,false);assert.equal(first.files.length,2);
 x.cloud.calls=[];x.cloud.downloads=[];
 const same=await new RemoteIndex(x.app,x.cloud,'/root','account',()=>{},()=>false).inventory();
 assert.equal(same.incremental,true);assert.equal(same.changed,0);assert.deepEqual(x.cloud.calls,[['/root/'+INDEX_DIR,false]]);assert.equal(x.cloud.downloads.length,0);
 // Changed/new/deleted paths only inspect their parent directory, with downloads only for new records.
 await x.index.mutateMany(['a.md','new.md','sub/b.md'],async()=>{x.cloud.put('/root/a.md','updated');x.cloud.put('/root/new.md','new');x.cloud.files.delete('/root/sub/b.md');});
 x.cloud.calls=[];const delta=await x.index.inventory();assert.equal(delta.incremental,true);assert.equal(delta.changed,3);
 assert.deepEqual(delta.files.map(f=>f.path).sort(),['/root/a.md','/root/new.md']);
 assert.deepEqual(x.cloud.calls,[['/root/'+INDEX_DIR,false],['/root',false],['/root/sub',false]]);
 x.cloud.calls=[];x.cloud.downloads=[];await x.index.inventory();assert.equal(x.cloud.calls.length,1);assert.equal(x.cloud.downloads.length,0);
 // Failure to register intent prevents any note mutation.
 const y=setup();let mutated=false;y.cloud.failUpload=p=>p.endsWith('.begin.json');
 await assert.rejects(y.index.mutate('a.md',async()=>{mutated=true}));assert.equal(mutated,false);
 // Remote write succeeds but done publication fails: open intent keeps being inspected after restart.
 await y.index.inventory();y.cloud.failUpload=p=>p.endsWith('.done.json');
 await y.index.mutate('a.md',async()=>y.cloud.put('/root/a.md','committed'));
 let pending=await y.index.inventory();assert.equal(pending.changed,1);assert.equal(pending.files.length,1);
 y.cloud.put('/root/a.md','late completion');y.cloud.calls=[];
 pending=await new RemoteIndex(y.app,y.cloud,'/root','account',()=>{},()=>false).inventory();assert.equal(pending.changed,1);assert(y.cloud.calls.some(([p,r])=>p==='/root'&&!r));
 // Deleted/modified history cannot silently advance the cursor; fallback is a complete audit.
 const event=[...x.cloud.files.keys()].find(p=>p.endsWith('.done.json'));x.cloud.files.delete(event);x.cloud.calls=[];
 assert.equal((await x.index.inventory()).incremental,false);assert(x.cloud.calls.some(([p,r])=>p==='/root'&&r));
 // Malformed/out-of-root paths and orphan commits trigger audit, never apply their assertions.
 const z=setup();await z.index.inventory();const id='a'.repeat(32);
 z.cloud.put('/root/'+INDEX_DIR+'/'+id+'.begin.json',JSON.stringify({version:1,id,phase:'begin',paths:['../escape.md']}));
 assert.equal((await z.index.inventory()).incremental,false);
 assert(!z.cloud.calls.some(([p])=>p.includes('..')));
 // A completely pruned history forces one audit, then safely resumes incremental reads.
 const pruned=setup();await pruned.index.inventory();await pruned.index.mutate('a.md',async()=>pruned.cloud.put('/root/a.md','a'));await pruned.index.inventory();
 for(const path of [...pruned.cloud.files.keys()]) if(path.startsWith('/root/'+INDEX_DIR+'/')) pruned.cloud.files.delete(path);
 assert.equal((await pruned.index.inventory()).incremental,false);assert.equal((await pruned.index.inventory()).incremental,true);
 // Valid JSON with accidental changes to the cache is rejected by its checksum.
 const envelope=JSON.parse(await pruned.disk.read('.custom/plugins/baidu-sync/remote-index.json'));envelope.data.files=[];
 await pruned.disk.write('.custom/plugins/baidu-sync/remote-index.json',JSON.stringify(envelope));assert.equal((await pruned.index.inventory()).incremental,false);
 // Corrupt cache, account/root mismatch, explicit audit and aged cache fall back.
 const cachePath='.custom/plugins/baidu-sync/remote-index.json';
 const w=setup();w.cloud.put('/root/a.md','a');await w.index.inventory();
 await w.index.invalidate();
 assert.equal((await w.index.inventory()).incremental,false);
 assert.equal((await w.index.inventory(true)).incremental,false);
 assert.equal((await new RemoteIndex(w.app,w.cloud,'/root','different account',()=>{},()=>false).inventory()).incremental,false);
 await w.disk.write(cachePath,'{broken');assert.equal((await w.index.inventory()).incremental,false);
 // Enumeration failure never produces a partial inventory or erases the previous cache.
 const prior=await w.disk.read(cachePath);w.cloud.failList=()=>true;await assert.rejects(w.index.inventory());assert.equal(await w.disk.read(cachePath),prior);
 // Independently written devices create different names and both changes survive.
 const c=setup();await c.index.inventory();const second=new RemoteIndex(c.app,c.cloud,'/root','account',()=>{},()=>false);
 await Promise.all([c.index.mutate('one.md',async()=>c.cloud.put('/root/one.md','one')),second.mutate('two.md',async()=>c.cloud.put('/root/two.md','two'))]);
 assert.equal([...c.cloud.files.keys()].filter(p=>p.endsWith('.begin.json')).length,2);
 assert.equal((await c.index.inventory()).changed,2);
 // Safety yield interrupts enumeration without returning partial results.
 await assert.rejects(new RemoteIndex(c.app,c.cloud,'/root','account',()=>{},()=>true).inventory(),/SYNC_YIELD/);
 // Batch intent count stays bounded; notes cannot start before every group is registered.
 const batched=setup();const many=Array.from({length:450},(_,i)=>`folder/${i}.md`);
 await batched.index.mutateMany(many,async()=>{assert.equal([...batched.cloud.files.keys()].filter(p=>p.endsWith('.begin.json')).length,3)});
 assert.equal([...batched.cloud.files.keys()].filter(p=>p.endsWith('.done.json')).length,3);
 const abort=setup();let starts=0;abort.cloud.failUpload=p=>p.endsWith('.begin.json')&&++starts===2;
 let ran=false;await assert.rejects(abort.index.mutateMany(many,async()=>{ran=true}));assert.equal(ran,false);
 // Real engines, two isolated local vaults sharing one cloud: add, modify, clean delete, modify/delete conflict.
 {
  const cloud=new Cloud();cloud.put('/root/note.md','initial');
  const settings={accessToken:'test',remoteBasePath:'/root',appKey:'app',username:'user',incrementalSync:true,ignoredPatterns:[],uploadConcurrency:2};
  const make=()=>{const disk=new Disk(),app=appFor(disk);app.vault.getFiles=()=>[...disk.files.keys()].filter(p=>!p.startsWith('.custom/')).map(path=>({path}));return{disk,engine:new SyncEngine(app,()=>settings,cloud)}};
  const a=make(),b=make();a.engine.log=()=>{};b.engine.log=()=>{};
  await a.engine.initialize();await b.engine.initialize();
  await a.engine.runFullSync();await b.engine.runFullSync();assert.equal(await b.disk.read('note.md'),'initial');
  cloud.calls=[];cloud.downloads=[];await a.engine.runFullSync();assert.deepEqual(cloud.calls,[['/root/'+INDEX_DIR,false]]);assert.equal(cloud.downloads.length,0);
  await a.disk.write('added.md','from a');await a.engine.runFullSync();cloud.calls=[];
  const received=await b.engine.runFullSync();assert.equal(received.downloaded,1);assert.equal(await b.disk.read('added.md'),'from a');assert(!cloud.calls.some(([p,recursive])=>recursive));
  await a.disk.write('added.md','changed');await a.engine.runFullSync();await b.engine.runFullSync();assert.equal(await b.disk.read('added.md'),'changed');
  await a.disk.remove('added.md');const deleted=await a.engine.runFullSync();assert.equal(deleted.deleted,1);assert.equal(cloud.files.has('/root/added.md'),false);
  const propagated=await b.engine.runFullSync();assert.equal(propagated.deleted,1);assert.equal(await b.disk.exists('added.md'),false);
  // Opposite local edits must survive a remote deletion as a pending conflict.
  await b.disk.write('note.md','unsynced local edit');await a.disk.remove('note.md');await a.engine.runFullSync();
  const conflict=await b.engine.runFullSync();assert.equal(conflict.conflicted,1);assert.equal(await b.disk.read('note.md'),'unsynced local edit');assert.equal(b.engine.getPendingConflicts().length,1);
  // A direct edit by a legacy/non-indexed writer must be rechecked before our upload.
  await a.disk.write('legacy.md','base');await a.engine.runFullSync();
  cloud.put('/root/legacy.md','external change');await a.disk.write('legacy.md','our change');
  await a.engine.runFullSync();await a.engine.runFullSync();
  assert.equal(await a.disk.read('legacy.md'),'our change');
  assert.equal(dec.decode(cloud.files.get('/root/legacy.md').bytes),'external change');
  assert(a.engine.getPendingConflicts().some(c=>c.path==='legacy.md'));
  // First-time/incomplete inventory keeps legacy deletion confirmation.
  const fresh=make();fresh.engine.log=()=>{};await fresh.engine.initialize();fresh.engine.stateStore.set('absent.md',{path:'absent.md',localMd5:'base',remoteMd5:'base',localMtime:1,remoteMtime:1,remoteFsId:'base',lastSyncTime:1});
  cloud.put('/root/absent.md','remote');cloud.files.get('/root/absent.md').info.md5='base';
  const cold=await fresh.engine.runFullSync();assert.equal(cold.conflicted,1);assert(cloud.files.has('/root/absent.md'));
 }
 console.log('PASS: indexed restart/no-change, targeted add/edit/delete, failed intents, unfinished commits, concurrent devices, corrupt/missing history, audits, fail-closed enumeration');
})().catch(e=>{console.error(e);process.exitCode=1});
