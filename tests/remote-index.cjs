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
function appFor(disk) {
 disk.localStorage ||= new Map();
 return { vault: { configDir: '.custom', adapter: disk, getAbstractFileByPath: () => null },
  loadLocalStorage:key=>JSON.parse(JSON.stringify(disk.localStorage.get(key) ?? null)),
  saveLocalStorage:(key,value)=>{if(value===null)disk.localStorage.delete(key);else disk.localStorage.set(key,JSON.parse(JSON.stringify(value)));} };
}

class Cloud {
 constructor(){this.files=new Map();this.dirs=new Set();this.calls=[];this.downloads=[];this.next=0;this.failUpload=null;this.failList=null;}
 put(path,text){const bytes=typeof text==='string'?enc.encode(text):new Uint8Array(text);const n=++this.next;this.files.set(path,{bytes,info:{path,fsId:String(n),md5:'hash'+n,size:bytes.length,serverMtime:n,isdir:0}});}
 async listFiles(root,recursive=true,shouldYield){if(shouldYield?.())throw Error('SYNC_YIELD_FOR_CONFLICT');this.calls.push([root,recursive]);if(this.failList?.(root))throw Error('listing failed');return [...this.files.values()].map(f=>f.info).concat([...this.dirs].map(path=>({path,isdir:1}))).filter(f=>f.path.startsWith(root+'/')&&(recursive||!f.path.slice(root.length+1).includes('/')));}
 async downloadFile(id){this.downloads.push(id);const f=[...this.files.values()].find(f=>f.info.fsId===id);if(!f)throw Error('missing cloud');return f.bytes.slice().buffer;}
 async uploadFile(path,data){if(this.failUpload?.(path,data))throw Error('upload failed');this.put(path,data);return {fsId:this.files.get(path).info.fsId,md5:this.files.get(path).info.md5};}
 async createDirectory(path){this.dirs.add(path);}
 async deleteFile(path){this.files.delete(path);}
 async deleteFiles(paths){for(const p of paths)this.files.delete(p);return new Map(paths.map(p=>[p,undefined]));}
}
function setup(){const disk=new Disk(),cloud=new Cloud(),logs=[];const app=appFor(disk);return{disk,cloud,logs,index:new RemoteIndex(app,cloud,'/root','account',m=>logs.push(m),()=>false),app};}
function phaseIs(phase){return(p,data)=>p.endsWith('.'+phase+'.json') || (/\/device-[a-f0-9]{32}\.json$/.test(p)&&JSON.parse(dec.decode(data)).entries.at(-1).phase===phase);}
function deviceFiles(cloud){return [...cloud.files.entries()].filter(([p])=>/\/device-[a-f0-9]{32}\.json$/.test(p));}
// Keep regression coverage for retained v1/v2 pairs and older writers.
async function legacyMutation(t,paths,operation){
 const id=require('node:crypto').randomBytes(16).toString('hex'),dir='/root/'+INDEX_DIR+'/v2';
 await t.cloud.createDirectory('/root/'+INDEX_DIR);await t.cloud.createDirectory(dir);
 const publish=phase=>t.cloud.uploadFile(dir+'/'+id+'.'+phase+'.json',enc.encode(JSON.stringify({version:1,id,phase,paths})).buffer);
 await publish('begin');try{return await operation();}finally{try{await publish('done');}catch{}}
}
// Use the production HTTP pagination logic while keeping data fully isolated.
function pagedListings(t){
 const requests=[],list=t.cloud.listFiles.bind(t.cloud),original=mock.requestUrl;
 mock.requestUrl=async({url})=>{
  const q=new URL(url).searchParams;assert.equal(q.get('method'),'list');
  const dir=q.get('dir'),start=Number(q.get('start')),limit=Number(q.get('limit'));requests.push({dir,start});
  const files=await list(dir,false);
  return{json:{errno:0,list:files.slice(start,start+limit).map(f=>({path:f.path,fs_id:f.fsId||'dir',isdir:f.isdir,size:f.size,md5:f.md5,server_mtime:f.serverMtime/1000}))}};
 };
 const {BaiduClient}=load('src/api/baidu-client.ts');
 const client=new BaiduClient({appKey:'test',secretKey:'test',accessToken:'test',refreshToken:'test',tokenExpiresAt:Date.now()+1e9});
 t.cloud.listFiles=client.listFiles.bind(client);
 return{requests,restore:()=>{mock.requestUrl=original;}};
}
(async()=>{
 // 2,000 unchanged user files do not cause 2,000 remote requests. Count
 // actual requestUrl calls, not just high-level listFiles invocations.
 {
  const t=setup(),http=pagedListings(t);
  try {
   await t.cloud.createDirectory('/root/docs');for(let i=0;i<2000;i++)t.cloud.put('/root/docs/'+i+'.md','data');
   await t.index.mutate('docs/0.md',async()=>{});await t.index.inventory();
   http.requests.length=0;t.cloud.downloads=[];
   const r=await t.index.inventory();assert.equal(r.incremental,true);assert.equal(r.files.length,2000);
   assert.equal(http.requests.length,2);assert.equal(t.cloud.downloads.length,0);
   console.log('PASS: 2,000 unchanged notes = 2 index listing HTTP requests, 0 object downloads');
  } finally{http.restore();}
 }
 // A warm device encountering 2,000 previously unseen completed records must
 // audit via paginated directories rather than download every old JSON.
 {
  const t=setup(),http=pagedListings(t);
  try {
   await t.index.inventory();
   for(let i=0;i<1000;i++)await legacyMutation(t,['note.md'],async()=>t.cloud.put('/root/note.md',String(i)));
   http.requests.length=0;t.cloud.downloads=[];
   const r=await t.index.inventory();assert.equal(r.incremental,false);assert.equal(r.files.length,1);
   assert.equal(http.requests.length,10);assert.equal(t.cloud.downloads.length,0);
   http.requests.length=0;assert.equal((await t.index.inventory()).incremental,true);
   assert.equal(http.requests.length,4);assert.equal(t.cloud.downloads.length,0);
   console.log('PASS: 2,000 unseen legacy records = 10 listing HTTP requests for catch-up, 4 on next round, 0 per-record downloads');
   // History removal must establish a fresh boundary, not trigger audits forever.
   t.cloud.files.delete([...t.cloud.files.keys()].find(p=>p.endsWith('.done.json')));
   assert.equal((await t.index.inventory()).incremental,false);assert.equal((await t.index.inventory()).incremental,true);
  } finally{http.restore();}
 }
 // Too many open intents are not discarded or saved as an incremental cursor.
 // Repeated audits continue to observe late writes without 2,000 downloads.
 {
  const t=setup();await t.index.inventory();const key='.custom/plugins/baidu-sync/remote-index.json',before=await t.disk.read(key);
  await t.cloud.createDirectory('/root/'+INDEX_DIR+'/v2');
  for(let i=0;i<2000;i++){
   const id=i.toString(16).padStart(32,'0');
   t.cloud.put('/root/'+INDEX_DIR+'/v2/'+id+'.begin.json',JSON.stringify({version:1,id,phase:'begin',paths:['pending.md']}));
  }
  t.cloud.downloads=[];assert.equal((await t.index.inventory()).incremental,false);assert.equal(await t.disk.read(key),before);
  t.cloud.put('/root/pending.md','late');const next=await t.index.inventory();assert.equal(next.incremental,false);assert(next.files.some(f=>f.path==='/root/pending.md'));
  assert.equal(t.cloud.downloads.length,0);assert.equal(await t.disk.read(key),before);
 }
 // A new device skips downloading pre-existing completed pairs, but reads
 // open intents and observes changes written during the first full scan.
 {
  const t=setup();const old='a'.repeat(32),open='b'.repeat(32),late='c'.repeat(32);
  const put=(id,phase,paths)=>t.cloud.put('/root/'+INDEX_DIR+'/'+id+'.'+phase+'.json',JSON.stringify({version:1,id,phase,paths}));
  put(old,'begin',['old.md']);put(old,'done',['old.md']);put(open,'begin',['open.md']);
  const list=t.cloud.listFiles.bind(t.cloud);let injected=false;
  t.cloud.listFiles=async(root,recursive=true,yieldFn)=>{const r=await list(root,recursive,yieldFn);if(root==='/root'&&recursive&&!injected){injected=true;put(late,'begin',['late.md']);put(late,'done',['late.md']);t.cloud.put('/root/late.md','new');}return r;};
  assert.equal((await t.index.inventory()).incremental,false);assert.equal(t.cloud.downloads.length,1,'only open intent is downloaded');
  t.cloud.downloads=[];const next=await t.index.inventory();assert.equal(next.incremental,true);assert.equal(next.changed,2);assert(next.files.some(f=>f.path==='/root/late.md'));assert.equal(t.cloud.downloads.length,2,'only new records are downloaded');
 }
 // A clean device reads a cloud snapshot, applies later journal records and
 // keeps first-sync deletion protection without recursively listing the vault.
 {
  const t=setup();t.cloud.put('/root/a.md','initial');await t.index.inventory();
  assert([...t.cloud.files.keys()].some(p=>p.includes('/snapshots/')));
  await t.index.mutate('later.md',async()=>t.cloud.put('/root/later.md','new'));
  const device=new Disk(),app=appFor(device);t.cloud.calls=[];
  const fresh=new RemoteIndex(app,t.cloud,'/root','account',()=>{},()=>false);
  const result=await fresh.inventory();assert.equal(result.incremental,false);assert(result.files.some(f=>f.path==='/root/a.md'));assert(result.files.some(f=>f.path==='/root/later.md'));
  assert(!t.cloud.calls.some(([p,recursive])=>p==='/root'&&recursive));
  assert.equal((await fresh.inventory()).incremental,true);
  // Corrupt cloud snapshots are ignored; incomplete lists never become a cache.
  const bad=setup();bad.cloud.put('/root/a.md','a');await bad.index.inventory();
  for(const [p] of bad.cloud.files)if(p.includes('/snapshots/'))bad.cloud.put(p,'{broken');
  const fresh2=new RemoteIndex(appFor(new Disk()),bad.cloud,'/root','account',()=>{},()=>false);bad.cloud.calls=[];
  assert.equal((await fresh2.inventory()).incremental,false);assert(bad.cloud.calls.some(([p,recursive])=>p==='/root'&&recursive));
 }
 // Timed compaction folds completed entries only and keeps all cloud files.
 {
  const t=setup();await t.index.inventory();
  await legacyMutation(t,['done.md'],async()=>t.cloud.put('/root/done.md','done'));
  t.cloud.failUpload=p=>p.endsWith('.done.json');
  await legacyMutation(t,['open.md'],async()=>t.cloud.put('/root/open.md','open'));t.cloud.failUpload=null;
  const cachePath='.custom/plugins/baidu-sync/remote-index.json';const envelope=JSON.parse(await t.disk.read(cachePath));
  envelope.data.compactedAt=Date.now()-3601000;
  envelope.checksum=require('node:crypto').createHash('md5').update(JSON.stringify(envelope.data)).digest('hex');
  await t.disk.write(cachePath,JSON.stringify(envelope));
  const pathsBefore=new Set(t.cloud.files.keys());await t.index.inventory();
  const updated=JSON.parse(await t.disk.read(cachePath)).data;
  assert.equal(Object.keys(updated.historical).length,2);assert.equal(Object.keys(updated.events).length,1);
  for(const name of pathsBefore)assert(t.cloud.files.has(name),'cloud records are retained');
  const fresh=new RemoteIndex(appFor(new Disk()),t.cloud,'/root','account',()=>{},()=>false);
  const got=await fresh.inventory();assert(got.files.some(f=>f.path==='/root/done.md'));assert(got.files.some(f=>f.path==='/root/open.md'));
  t.cloud.put('/root/open.md','later');const follow=await fresh.inventory();assert(follow.changed>=1,'unfinished record is rechecked');
 }
 // Failed snapshot publication retains event contents for retry.
 {
  const t=setup();await t.index.inventory();await legacyMutation(t,['file.md'],async()=>t.cloud.put('/root/file.md','a'));
  const key='.custom/plugins/baidu-sync/remote-index.json',e=JSON.parse(await t.disk.read(key));e.data.compactedAt=Date.now()-3601000;
  e.checksum=require('node:crypto').createHash('md5').update(JSON.stringify(e.data)).digest('hex');await t.disk.write(key,JSON.stringify(e));
  t.cloud.failUpload=p=>p.includes('/snapshots/');await t.index.inventory();
  let stored=JSON.parse(await t.disk.read(key)).data;assert.equal(Object.keys(stored.events).length,2);
  t.cloud.failUpload=null;await t.index.inventory();stored=JSON.parse(await t.disk.read(key)).data;assert.equal(Object.keys(stored.events).length,0);assert.equal(Object.keys(stored.historical).length,2);
 }
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
 assert.deepEqual(x.cloud.calls,[['/root/'+INDEX_DIR,false],['/root/'+INDEX_DIR+'/v2',false],['/root',false],['/root/sub',false]]);
 x.cloud.calls=[];x.cloud.downloads=[];await x.index.inventory();assert.equal(x.cloud.calls.length,2);assert.equal(x.cloud.downloads.length,0);
 // A reserved v2 subdirectory is ignored by the v1 reader and inventory.
 const nested=setup();
 const listNested=nested.cloud.listFiles.bind(nested.cloud);
 nested.cloud.listFiles=async(root,recursive=true,shouldYield)=>{const result=await listNested(root,recursive,shouldYield);if(root==='/root/'+INDEX_DIR&&!recursive)result.push({path:root+'/v2',isdir:1});return result;};
 assert.equal((await nested.index.inventory()).files.length,0);
 assert.equal((await nested.index.inventory()).incremental,true);
 assert.equal(new SyncEngine(nested.app,()=>({ignoredPatterns:[]}),nested.cloud).shouldIgnore(INDEX_DIR+'/v2/snapshot.json'),true);
 // Failure to register intent prevents any note mutation.
 const y=setup();let mutated=false;y.cloud.failUpload=phaseIs('begin');
 await assert.rejects(y.index.mutate('a.md',async()=>{mutated=true}));assert.equal(mutated,false);
 // Remote write succeeds but done publication fails: open intent keeps being inspected after restart.
 await y.index.inventory();y.cloud.failUpload=phaseIs('done');
 await y.index.mutate('a.md',async()=>y.cloud.put('/root/a.md','committed'));
 let pending=await y.index.inventory();assert.equal(pending.changed,1);assert.equal(pending.files.length,1);
 y.cloud.put('/root/a.md','late completion');y.cloud.calls=[];
 pending=await new RemoteIndex(y.app,y.cloud,'/root','account',()=>{},()=>false).inventory();assert.equal(pending.changed,1);assert(y.cloud.calls.some(([p,r])=>p==='/root'&&!r));
 // Deleted/modified history cannot silently advance the cursor; fallback is a complete audit.
 const event=deviceFiles(x.cloud)[0][0];x.cloud.files.delete(event);x.cloud.calls=[];
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
 assert.equal(deviceFiles(c.cloud).length,1,'same-device instances serialize and reuse their journal');
 assert.equal((await c.index.inventory()).changed,2);
 // Safety yield interrupts enumeration without returning partial results.
 await assert.rejects(new RemoteIndex(c.app,c.cloud,'/root','account',()=>{},()=>true).inventory(),/SYNC_YIELD/);
 // One bounded intent contains the whole batch before any note changes.
 const batched=setup();const many=Array.from({length:450},(_,i)=>`folder/${i}.md`);
 await batched.index.mutateMany(many,async()=>{assert.equal(JSON.parse(dec.decode(deviceFiles(batched.cloud)[0][1].bytes)).entries.at(-1).phase,'begin')});
 assert.equal(deviceFiles(batched.cloud).length,1);
 const batchRecord=deviceFiles(batched.cloud)[0];assert.equal(JSON.parse(dec.decode(batchRecord[1].bytes)).entries.at(-1).paths.length,450);
 assert.equal((await batched.index.inventory()).incremental,false);assert.equal((await batched.index.inventory()).incremental,true);
 const abort=setup();const larger=Array.from({length:10001},(_,i)=>`folder/${i}.md`);abort.cloud.failUpload=phaseIs('begin');
 let ran=false;await assert.rejects(abort.index.mutateMany(larger,async()=>{ran=true}));assert.equal(ran,false);
 // Growth is bounded by writers, not sync count; legacy records stay byte-identical.
 {
  const t=setup();await legacyMutation(t,['legacy.md'],async()=>t.cloud.put('/root/legacy.md','legacy'));
  const old=[...t.cloud.files].filter(([p])=>p.endsWith('.begin.json')||p.endsWith('.done.json')).map(([p,f])=>[p,dec.decode(f.bytes)]);
  await t.index.inventory();
  for(let i=0;i<1000;i++)await t.index.mutate('changing.md',async()=>t.cloud.put('/root/changing.md',String(i)));
  const records=deviceFiles(t.cloud);assert.equal(records.length,1);
  const journal=JSON.parse(dec.decode(records[0][1].bytes));assert.equal(journal.entries.length,64);assert.equal(journal.entries.at(-1).sequence,1000);assert(records[0][1].bytes.length<=256*1024);
  for(const [p,s] of old)assert.equal(dec.decode(t.cloud.files.get(p).bytes),s);
  const missed=await t.index.inventory();assert.equal(missed.incremental,false,'missed window forces a complete audit');assert(missed.files.some(f=>f.path==='/root/changing.md'));
  t.cloud.calls=[];t.cloud.downloads=[];assert.equal((await t.index.inventory()).incremental,true);assert.equal(t.cloud.downloads.length,0);assert(!t.cloud.calls.some(([,r])=>r));
  const cache=JSON.parse(await t.disk.read('.custom/plugins/baidu-sync/remote-index.json')).data;
  assert.equal(Object.keys(cache.historical).length,2);assert.equal(Object.keys(cache.rolling).length,1);assert.equal(Object.keys(cache.events).length,0);
  console.log('PASS: 1,000 mutations use one bounded journal, retain legacy bytes, and keep historical fingerprints constant');
 }
 // Exactly 64 unseen batches remain incremental; 65 require an audit that
 // still observes an update dropped from the retained window.
 for(const count of [64,65]) {
  const t=setup();await t.index.inventory();await t.index.mutate('anchor.md',async()=>t.cloud.put('/root/anchor.md','a'));await t.index.inventory();
  for(let i=0;i<count;i++)await t.index.mutate(i===0?'oldest.md':'latest.md',async()=>t.cloud.put('/root/'+(i===0?'oldest.md':'latest.md'),String(i)));
  const result=await t.index.inventory();assert.equal(result.incremental,count===64);assert(result.files.some(f=>f.path==='/root/oldest.md'));
 }
 // Online readers stay incremental across many rotations, including deletion.
 {
  const t=setup();await t.index.inventory();
  for(let i=0;i<150;i++) {
   await t.index.mutate('rolling.md',async()=>{if(i%2)t.cloud.files.delete('/root/rolling.md');else t.cloud.put('/root/rolling.md',String(i));});
   const r=await t.index.inventory();assert.equal(r.incremental,true);assert.equal(r.files.some(f=>f.path==='/root/rolling.md'),i%2===0);
  }
  assert.equal(deviceFiles(t.cloud).length,1);
 }
 // Device-local identity survives a normal restart, but copying the entire
 // vault (including plugin files) does not copy the writer identity.
 {
  const t=setup();await t.index.mutate('a.md',async()=>t.cloud.put('/root/a.md','a'));
  const original=deviceFiles(t.cloud)[0][0];
  const restarted=new RemoteIndex(appFor(t.disk),t.cloud,'/root','account',()=>{},()=>false);
  await restarted.mutate('b.md',async()=>t.cloud.put('/root/b.md','b'));
  assert.equal(deviceFiles(t.cloud).length,1);assert.equal(deviceFiles(t.cloud)[0][0],original);
  const copy=new Disk();copy.files=new Map(t.disk.files);
  const cloned=new RemoteIndex(appFor(copy),t.cloud,'/root','account',()=>{},()=>false);
  await Promise.all([restarted.mutate('c.md',async()=>t.cloud.put('/root/c.md','c')),cloned.mutate('d.md',async()=>t.cloud.put('/root/d.md','d'))]);
  assert.equal(deviceFiles(t.cloud).length,2);assert.equal((await restarted.inventory()).files.length,4);
 }
 // A crash during a note write must abandon the old identity; the open
 // journal remains visible after the restarted writer has completed work.
 {
  const t=setup();await t.index.inventory();let release,entered;
  const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  const pending=t.index.mutate('pending.md',async()=>{entered();await waiting;t.cloud.put('/root/pending.md','late');});
  await started;assert.equal(t.disk.localStorage.size,0);
  const restarted=new RemoteIndex(appFor(t.disk),t.cloud,'/root','account',()=>{},()=>false);
  await restarted.mutate('new.md',async()=>t.cloud.put('/root/new.md','new'));
  assert.equal(deviceFiles(t.cloud).length,2);
  const before=await restarted.inventory();assert.equal(before.changed,2);
  release();await pending;const after=await restarted.inventory();assert(after.files.some(f=>f.path==='/root/pending.md'));
 }
 // Restoring an older localStorage backup cannot overwrite a newer cloud
 // prefix that other devices have not read yet.
 {
  const t=setup();await t.index.mutate('one.md',async()=>t.cloud.put('/root/one.md','one'));await t.index.inventory();
  const oldStorage=new Map(t.disk.localStorage);
  await t.index.mutate('two.md',async()=>t.cloud.put('/root/two.md','two'));
  const [oldPath,oldFile]=deviceFiles(t.cloud)[0],oldBytes=dec.decode(oldFile.bytes);
  t.disk.localStorage=oldStorage;
  const restored=new RemoteIndex(appFor(t.disk),t.cloud,'/root','account',()=>{},()=>false);
  await restored.mutate('three.md',async()=>t.cloud.put('/root/three.md','three'));
  assert.equal(deviceFiles(t.cloud).length,2);assert.equal(dec.decode(t.cloud.files.get(oldPath).bytes),oldBytes);
  const r=await restored.inventory();assert.equal(r.incremental,true);assert.equal(r.files.length,3);
 }
 // An ambiguous begin/done upload may reach the server much later. Its path
 // is never reused, so it cannot roll back the replacement writer's history.
 for(const failPhase of ['begin','done']) {
  const t=setup();await t.index.inventory();let late;
  t.cloud.failUpload=(p,data)=>{if(phaseIs(failPhase)(p,data)){late=[p,new Uint8Array(data).slice()];return true;}return false;};
  if(failPhase==='begin')await assert.rejects(t.index.mutate('old.md',async()=>assert.fail('begin failed')));
  else await t.index.mutate('old.md',async()=>t.cloud.put('/root/old.md','old'));
  t.cloud.failUpload=null;
  await t.index.mutate('new.md',async()=>t.cloud.put('/root/new.md','new'));
  const replacement=deviceFiles(t.cloud).find(([p])=>p!==late[0]);assert(replacement);const bytes=dec.decode(replacement[1].bytes);
  t.cloud.put(...late);assert.equal(dec.decode(t.cloud.files.get(replacement[0]).bytes),bytes);
  const r=await t.index.inventory();assert(r.files.some(f=>f.path==='/root/new.md'));
 }
 // A rejected user operation is closed only after it settles, preserving any
 // partial writes for other devices and allowing subsequent queued operations.
 {
  const t=setup();await t.index.inventory();
  await assert.rejects(t.index.mutate('partial.md',async()=>{t.cloud.put('/root/partial.md','partial');throw Error('operation interrupted');}),/interrupted/);
  await t.index.mutate('next.md',async()=>t.cloud.put('/root/next.md','next'));
  const r=await t.index.inventory();assert.equal(r.changed,2);assert.equal(deviceFiles(t.cloud).length,1);
 }
 // Byte limits also bound long Unicode paths; a single oversized batch uses
 // an explicit full-scan marker instead of silently dropping any paths.
 {
  const t=setup();await t.index.inventory();
  const paths=Array.from({length:2000},(_,i)=>'附件/'.repeat(45)+i+'.md');
  await t.index.mutateMany(paths,async()=>{const j=JSON.parse(dec.decode(deviceFiles(t.cloud)[0][1].bytes));assert.equal(j.entries.at(-1).fullScan,true);t.cloud.put('/root/'+paths.at(-1),'last');});
  assert(deviceFiles(t.cloud)[0][1].bytes.length<=256*1024);
  const result=await t.index.inventory();assert.equal(result.incremental,false);assert(result.files.some(f=>f.path==='/root/'+paths.at(-1)));
  assert.equal((await t.index.inventory()).incremental,true);
  // Byte-based eviction can shorten the window even before 64 batches.
  const batch=paths.slice(0,250);
  for(let i=0;i<5;i++)await t.index.mutateMany(batch,async()=>{});
  const record=deviceFiles(t.cloud)[0][1];assert(record.bytes.length<=256*1024);assert(JSON.parse(dec.decode(record.bytes)).entries.length<6);
  assert.equal((await t.index.inventory()).incremental,false);
 }
 // Listing during a write sees begin; a later done must recheck the path.
 {
  const t=setup();await t.index.inventory();
  await t.index.mutate('during.md',async()=>{const r=await t.index.inventory();assert.equal(r.incremental,true);assert(!r.files.length);t.cloud.put('/root/during.md','after scan');});
  const after=await t.index.inventory();assert.equal(after.changed,1);assert(after.files.some(f=>f.path==='/root/during.md'));
 }
 // A byte-limited window can evict a begin after a reader saw it. Even with
 // no sequence gap, the old pending paths still need a final directory read.
 {
  const t=setup();await t.index.inventory();
  const paths=Array.from({length:450},(_,i)=>'目录/'.repeat(45)+i+'.md');
  await t.index.mutateMany(paths,async()=>{await t.index.inventory();t.cloud.put('/root/'+paths[0],'late');});
  await t.index.mutateMany(paths.map(p=>'new/'+p),async()=>{});
  const entries=JSON.parse(dec.decode(deviceFiles(t.cloud)[0][1].bytes)).entries;
  assert.equal(entries.length,1,'first batch evicted by the byte limit');
  const r=await t.index.inventory();assert.equal(r.incremental,true);assert(r.files.some(f=>f.path==='/root/'+paths[0]));
 }
 // Journal rollback, corruption and gaps fail closed; a failed complete scan
 // must never replace the last known good local inventory.
 for(const mode of ['rollback','malformed','gap','removed']) {
  const t=setup();await t.index.inventory();await t.index.mutate('a.md',async()=>t.cloud.put('/root/a.md','a'));await t.index.inventory();
  const [p,f]=deviceFiles(t.cloud)[0],old=f.bytes.slice();
  await t.index.mutate('b.md',async()=>t.cloud.put('/root/b.md','b'));await t.index.inventory();
  if(mode==='rollback')t.cloud.put(p,old);
  if(mode==='malformed')t.cloud.put(p,'{bad');
  if(mode==='removed')t.cloud.files.delete(p);
  if(mode==='gap'){const j=JSON.parse(dec.decode(t.cloud.files.get(p).bytes));j.entries[1].sequence=5;t.cloud.put(p,JSON.stringify(j));}
  const before=await t.disk.read('.custom/plugins/baidu-sync/remote-index.json');t.cloud.failList=root=>root==='/root';
  await assert.rejects(t.index.inventory(),/listing failed/);assert.equal(await t.disk.read('.custom/plugins/baidu-sync/remote-index.json'),before);
  t.cloud.failList=null;assert.equal((await t.index.inventory()).incremental,false);
 }
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
