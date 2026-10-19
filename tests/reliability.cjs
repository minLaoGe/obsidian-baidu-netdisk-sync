const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const nodeCrypto = require('node:crypto');
const mockObsidian = { Platform: { isDesktopApp: false }, FileSystemAdapter: class {}, Notice: class {}, TFile: class {} };
function load(file) {
  const result = esbuild.buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(id => id === 'obsidian' ? mockObsidian : require(id), mod, mod.exports);
  return mod.exports;
}
const { AtomicFileSystem } = load('src/utils/atomic.ts');
const { SyncStateStore } = load('src/sync/state.ts');
const { SyncEngine } = load('src/sync/engine.ts');
const { determineSyncAction } = load('src/sync/conflict.ts');
const { calculateMd5 } = load('src/utils/crypto.ts');
const { encryptData, isEncrypted } = load('src/crypto/e2ee.ts');
const { importEncryptedConfig } = load('src/crypto/configShare.ts');
const enc = new TextEncoder(), dec = new TextDecoder();
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
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
(async () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 4096, 4194304]) {
    const b = nodeCrypto.randomBytes(n);
    assert.equal(calculateMd5(b), nodeCrypto.createHash('md5').update(b).digest('hex')); checks++;
  }
  // Restart after EVERY persistent mutation, including journal and cleanup operations.
  for (const existing of [false, true]) {
    const disk = new Disk();
    if (existing) disk.files.set('note.md', enc.encode('old content'));
    const app = appFor(disk);
    await new AtomicFileSystem(app).atomicWrite('note.md', 'new content');
    for (const [index, snapshot] of disk.snapshots.entries()) {
      const restart = new Disk(); restart.files = new Map(snapshot); restart.dirs = new Set(disk.dirs);
      await new AtomicFileSystem(appFor(restart)).recoverCrashAndCleanStale();
      const content = restart.files.has('note.md') ? await restart.read('note.md') : null;
      ok(existing ? ['old content', 'new content'].includes(content) : [null, 'new content'].includes(content), `crash at ${index}`);
      await new AtomicFileSystem(appFor(restart)).recoverCrashAndCleanStale();
      assert.equal(restart.files.has('note.md') ? await restart.read('note.md') : null, content); checks++;
    }
  }
  // Before-operation IO failures leave old/new data recoverable on restart.
  for (const operation of ['write', 'remove', 'rename']) {
    for (let nth = 1; nth <= 7; nth++) {
      const d = new Disk(); d.files.set('note.md', enc.encode('old'));
      let count = 0; d.fail = op => op === operation && ++count === nth;
      try { await new AtomicFileSystem(appFor(d)).atomicWrite('note.md', 'new'); } catch {}
      d.fail = null;
      await new AtomicFileSystem(appFor(d)).recoverCrashAndCleanStale();
      ok(['old', 'new'].includes(await d.read('note.md')), `${operation} ${nth}`);
    }
  }
  // User files with historical suffixes are never treated as plugin transactions.
  {
    const d = new Disk();
    for (const p of ['note.md', 'note.md.syncbak', 'only.syncbak', 'user.synctmp.123']) d.files.set(p, enc.encode(p));
    const before = new Map(d.files);
    await new AtomicFileSystem(appFor(d)).recoverCrashAndCleanStale();
    assert.deepEqual(d.files, before); checks++;
  }
  // Stale fully-cleaned journal entries are harmless; orphan payloads are not.
  for (const orphan of [false, true]) {
    const d = new Disk(), app = appFor(d), writer = new AtomicFileSystem(app);
    const record = writer.transactionDir + '/abcdef.json';
    d.dirs.add(writer.transactionDir);
    d.list = async () => ({files:[record],folders:[]});
    const read=d.read.bind(d);
    d.read=async path=>{if(path===record)throw Object.assign(new Error('gone'),{code:'ENOENT'});return read(path)};
    if(orphan)d.files.set(writer.transactionDir+'/abcdef.old',enc.encode('preserve'));
    if(orphan){await assert.rejects(writer.recoverCrashAndCleanStale());assert.equal(d.files.has(writer.transactionDir+'/abcdef.old'),true);}
    else await writer.recoverCrashAndCleanStale();
    checks++;
  }
  // Corrupt temporary payload never touches the old target.
  {
    const d = new Disk(); d.files.set('note.md', enc.encode('old'));
    const write = d.writeBinary.bind(d);
    d.writeBinary = async (p, b) => write(p, p.endsWith('.new') ? enc.encode('corrupt').buffer : b);
    await assert.rejects(new AtomicFileSystem(appFor(d)).atomicWrite('note.md', 'new'));
    assert.equal(await d.read('note.md'), 'old'); checks++;
  }
  // State saves can retry after a failed save; custom config path is respected.
  {
    const d = new Disk(), app = appFor(d), state = new SyncStateStore(app);
    state.setLastFullSyncTimestamp(1);
    d.fail = op => op === 'write';
    await assert.rejects(state.save());
    d.fail = null; await state.save();
    assert.equal(JSON.parse(await d.read('.custom/plugins/baidu-sync/sync-state.json')).lastFullSyncTimestamp, 1); checks++;
    d.files.set('.custom/plugins/baidu-sync/sync-state.json', enc.encode('{broken'));
    await assert.rejects(new SyncStateStore(app).load()); checks++;
  }
  // Concurrent upload checkpoints retain all committed entries, including
  // changes arriving during an earlier atomic save; recovery preserves JSON.
  {
    const d = new Disk(), app = appFor(d), state = new SyncStateStore(app);
    const entry = name => ({path:name,localMtime:1,localMd5:'a',remoteFsId:name,remoteMtime:1,remoteMd5:'b',lastSyncTime:1});
    state.set('first.md', entry('first.md'));
    const first = state.save();
    state.set('second.md', entry('second.md'));
    const second = state.save();
    state.set('third.md', entry('third.md'));
    await Promise.all([first, second, state.save()]);
    const diskState = JSON.parse(await d.read('.custom/plugins/baidu-sync/sync-state.json'));
    assert.deepEqual(Object.keys(diskState.files).sort(), ['first.md','second.md','third.md']); checks++;
    for (const snapshot of d.snapshots) {
      const restart = new Disk(); restart.files = new Map(snapshot); restart.dirs = new Set(d.dirs);
      await new AtomicFileSystem(appFor(restart)).recoverCrashAndCleanStale();
      const path = '.custom/plugins/baidu-sync/sync-state.json';
      if (restart.files.has(path)) {
        const parsed = JSON.parse(await restart.read(path));
        ok(Object.keys(parsed.files).every(name => ['first.md','second.md','third.md'].includes(name)), 'checkpoint recovery');
      }
    }
  }
  // Conflicts remain pending across restarts; neither side is auto-overwritten.
  {
    const d = new Disk(), app = appFor(d);
    d.files.set('note.md', enc.encode('local'));
    const settings = { enableE2EE: true, e2eePassword: 'test-only', conflictStrategy: 'keep_remote' };
    const ciphertext = await encryptData(enc.encode('remote').buffer, settings.e2eePassword);
    let uploads = 0, deletions = 0;
    const client = {downloadFile:async()=>ciphertext,uploadFile:async()=>{uploads++;return{fsId:'1',md5:'committed'}},deleteFile:async()=>{deletions++}};
    const engine = new SyncEngine(app, () => settings, client);
    const local = {exists:true,md5:calculateMd5(enc.encode('local'))};
    const remote = {exists:true,fsId:'1',md5:calculateMd5(ciphertext)};
    await engine.resolveConflict('note.md','/note.md',{action:'conflict'},local,remote);
    assert.equal(uploads,0);assert.equal(deletions,0);assert.equal(await d.read('note.md'),'local');checks+=3;
    const record=engine.getPendingConflicts()[0];
    assert.equal(await d.read(record.copies[0]),'remote');assert.equal(engine.stateStore.get('note.md'),undefined);checks+=2;
    assert.equal(engine.shouldIgnore('note.md'),true);assert.equal(engine.shouldIgnore(record.copies[0]),true);checks+=2;
    await engine.resolveConflict('note.md','/note.md',{action:'conflict'},local,remote);
    assert.equal(engine.getPendingConflicts()[0].copies.length,1);checks++;
    const restarted=new SyncStateStore(app);await restarted.load();assert.equal(restarted.getConflicts().length,1);checks++;
    // A crash/deleted snapshot can be refreshed without touching the original.
    await d.remove(record.copies[0]);
    engine.inspectRemoteFile=async()=>remote;
    await engine.refreshPendingConflict('note.md');
    assert.equal(await d.read(engine.getPendingConflicts()[0].copies.at(-1)), 'remote');checks++;
    // Remote changes again: refresh its copy and refuse the stale confirmation.
    let latest={...remote,md5:'new-remote'};engine.inspectRemoteFile=async()=>latest;
    await assert.rejects(engine.confirmConflictResolved('note.md'));
    assert.equal(uploads,0);assert.equal(engine.getPendingConflicts()[0].copies.length,3);checks+=2;
    await engine.confirmConflictResolved('note.md');
    assert.equal(uploads,1);assert.equal(engine.getPendingConflicts().length,0);checks+=2;
    assert.equal(engine.shouldIgnore(record.copies[0]),true);checks++;
    const reloaded=new SyncStateStore(app);await reloaded.load();assert.equal(reloaded.getConflicts().length,0);checks++;
    // Delete/modify conflicts also stay pending, even with an old auto strategy.
    await engine.resolveConflict('note.md','/note.md',{action:'conflict'},local,{exists:false});
    assert.equal(uploads,1);assert.equal(await d.read('note.md'),'local');checks+=2;
    assert.equal(engine.getPendingConflicts()[0].remote.exists,false);checks++;
  }
  // Identical plaintext and second-precision mtime never create a conflict,
  // including opaque server hashes. Existing duplicates go to recoverable trash.
  {
    const d=new Disk(),app=appFor(d);d.files.set('note.md',enc.encode('same'));
    const engine=new SyncEngine(app,()=>({}),{downloadFile:async()=>enc.encode('same').buffer,uploadFile:async()=>{throw Error('must not upload')}});
    const remote={exists:true,fsId:'1',md5:'opaque-server-hash',mtime:1};
    const local={exists:true,md5:calculateMd5(enc.encode('same')),mtime:1};
    let decision={action:'conflict'};
    await engine.resolveConflict('note.md','/note.md',decision,local,remote);
    assert.equal(decision.action,'noop');assert.equal(engine.getPendingConflicts().length,0);checks+=2;
    assert.equal(engine.stateStore.get('note.md').remoteMd5,'opaque-server-hash');checks++;
    // Same bytes with different or missing timestamps still need review.
    await engine.resolveConflict('note.md','/note.md',{action:'conflict'},local,{...remote,mtime:2000});
    const record=engine.getPendingConflicts()[0];assert.equal(record.copies.length,1);checks++;
    const edited='note.conflict-20261019-000000-edited.md';d.files.set(edited,enc.encode('manual edit'));
    record.copies.push(edited);
    await engine.resolveConflict('note.md','/note.md',{action:'conflict'},local,remote);
    assert.equal(engine.getPendingConflicts().length,0);assert.equal(d.files.has(record.copies[0]),false);assert.equal(await d.read(edited),'manual edit');assert.equal(await d.read('note.md'),'same');checks+=4;
    await engine.resolveConflict('note.md','/note.md',{action:'conflict'},local,{...remote,mtime:undefined});
    assert.equal(engine.getPendingConflicts().length,1);checks++;
  }
  // Conflict-page deletions are local-only, constrained, and retain pending state.
  {
    const d=new Disk(),app=appFor(d);d.files.set('note.md',enc.encode('keep'));d.files.set('copy.md',enc.encode('remote'));d.files.set('other.md',enc.encode('other'));
    let remoteMutations=0;const engine=new SyncEngine(app,()=>({syncPaused:true}),{deleteFile:async()=>{remoteMutations++},uploadFile:async()=>{remoteMutations++}});
    engine.stateStore.setConflict({path:'note.md',remotePath:'/note.md',copies:['copy.md'],remote:{exists:true},createdAt:1});
    await assert.rejects(engine.trashConflictFile('note.md','other.md'));assert.equal(await d.read('other.md'),'other');checks++;
    await engine.trashConflictFile('note.md','copy.md');assert.equal(d.files.has('copy.md'),false);assert.equal(await d.read('note.md'),'keep');checks+=2;
    await engine.trashConflictFile('note.md','note.md');assert.equal(remoteMutations,0);assert.equal(engine.getPendingConflicts().length,1);checks+=2;
  }
  // Merge preserves newer edits and removes pending state only after successful commit.
  {
    const d=new Disk(),app=appFor(d);d.files.set('note.md',enc.encode('local'));d.files.set('copy.md',enc.encode('remote'));
    const engine=new SyncEngine(app,()=>({syncPaused:false}),{});
    engine.stateStore.setConflict({path:'note.md',remotePath:'/note.md',copies:['copy.md'],remote:{exists:true},createdAt:1});
    const snapshot=await engine.readConflictMerge('note.md');
    await assert.rejects(engine.saveConflictMerge('note.md',snapshot,'<<<<<<< LOCAL\na\n=======\nb\n>>>>>>> REMOTE'));checks++;
    d.files.set('note.md',enc.encode('new edit'));
    await assert.rejects(engine.saveConflictMerge('note.md',snapshot,'merged'));assert.equal(await d.read('note.md'),'new edit');checks+=2;
    const fresh=await engine.readConflictMerge('note.md');
    d.files.set('copy.md',enc.encode('new remote'));
    await assert.rejects(engine.saveConflictMerge('note.md',fresh,'merged'));checks++;
    engine.inspectRemoteFile=async()=>({exists:true});
    engine.executeAction=async()=>{throw Error('network unavailable')};
    await assert.rejects(engine.saveConflictMerge('note.md',await engine.readConflictMerge('note.md'),'merged'));
    assert.equal(engine.getPendingConflicts().length,1);checks++;
    engine.executeAction=async()=>{};
    await engine.saveConflictMerge('note.md',await engine.readConflictMerge('note.md'),'merged');
    assert.equal(await d.read('note.md'),'merged');assert.equal(await d.read('copy.md'),'new remote');assert.equal(engine.getPendingConflicts().length,0);checks+=3;
  }
  // Batch accepts only selected records, backs up replaced bytes, and keeps failures.
  {
    const d=new Disk(),app=appFor(d);d.files.set('one.md',enc.encode('local one'));d.files.set('two.md',enc.encode('local two'));
    const engine=new SyncEngine(app,()=>({syncPaused:false}),{});
    for(const path of ['one.md','two.md']) engine.stateStore.setConflict({path,remotePath:'/'+path,copies:[],remote:{exists:true,md5:'remote',fsId:'1'},createdAt:1});
    engine.inspectRemoteFile=async()=>({exists:true,md5:'remote',fsId:'1'});
    engine.executeAction=async(path,remote,decision)=>{assert.equal(decision.action,'download');await engine.atomicFs.atomicWrite(path,enc.encode('remote bytes').buffer)};
    const result=await engine.acceptConflictVersions(['one.md','missing.md','one.md'],'remote');
    assert.deepEqual(result.resolved,['one.md']);assert.equal(result.failed.length,1);assert.equal(await d.read('one.md'),'remote bytes');assert.equal(await d.read('two.md'),'local two');checks+=4;
    const backup=[...d.files.keys()].find(p=>p.startsWith('one.conflict-'));assert.equal(await d.read(backup),'local one');assert.equal(engine.getPendingConflicts().length,1);checks+=2;
    engine.executeAction=async()=>{throw Error('upload failed')};
    const failed=await engine.acceptConflictVersions(['two.md'],'local');assert.equal(failed.failed.length,1);assert.equal(engine.getPendingConflicts().length,1);checks+=2;
    engine.executeAction=async()=>{};
    const done=await engine.acceptConflictVersions(['two.md'],'local');assert.deepEqual(done.resolved,['two.md']);assert.equal(engine.getPendingConflicts().length,0);checks+=2;
  }
  // Multiple writer instances share a per-vault lock.
  {
    const d = new Disk(), app = appFor(d);
    d.files.set('note.md', enc.encode('old'));
    await Promise.all([new AtomicFileSystem(app).atomicWrite('note.md', 'first'), new (load('src/utils/atomic.ts').AtomicFileSystem)(app).atomicWrite('note.md', 'second')]);
    assert.equal(await d.read('note.md'), 'second'); checks++;
  }
  // Invalid journals and externally changed targets block writes without cleanup.
  for (const invalid of [true, false]) {
    const d = new Disk(), app = appFor(d), writer = new AtomicFileSystem(app);
    const root = writer.transactionDir;
    d.dirs.add(root);
    d.files.set('note.md', enc.encode('external edit'));
    d.files.set(root + '/abc.old', enc.encode('old'));
    d.files.set(root + '/abc.json', enc.encode(invalid ? '{broken' : JSON.stringify({version:1,target:'note.md',oldHash:calculateMd5(enc.encode('old')),newHash:calculateMd5(enc.encode('new'))})));
    await assert.rejects(writer.recoverCrashAndCleanStale());
    assert.equal(await d.read('note.md'), 'external edit');
    ok(d.files.has(root + '/abc.old'), 'retain backup on ambiguous recovery');
    await assert.rejects(writer.atomicWrite('other.md', 'blocked')); checks++;
  }
  // Exercise desktop fsync + atomic overwrite on the actual Windows filesystem.
  {
    const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baidu-sync-reliability-'));
    class NativeDisk extends mockObsidian.FileSystemAdapter {
      getBasePath() { return root; }
      async exists(p) { try { await fs.stat(path.join(root,p)); return true; } catch(e) { if(e.code==='ENOENT') return false; throw e; } }
      async mkdir(p) { await fs.mkdir(path.join(root,p)); }
      async readBinary(p) { const b=await fs.readFile(path.join(root,p)); return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); }
      async read(p) { return fs.readFile(path.join(root,p),'utf8'); }
      async write(p,s) { await fs.writeFile(path.join(root,p),s); }
      async writeBinary(p,b) { await fs.writeFile(path.join(root,p),new Uint8Array(b)); }
      async remove(p) { assert.notEqual(p,'note.md','desktop must never delete target'); await fs.unlink(path.join(root,p)); }
      async rename(a,b) { await fs.rename(path.join(root,a),path.join(root,b)); }
      async list(p) { const entries=await fs.readdir(path.join(root,p),{withFileTypes:true}); return {files:entries.filter(e=>e.isFile()).map(e=>p+'/'+e.name),folders:[]}; }
    }
    const originalRename=fs.rename;
    try {
      mockObsidian.Platform.isDesktopApp=true;
      const disk=new NativeDisk(), writer=new AtomicFileSystem(appFor(disk));
      await fs.writeFile(path.join(root,'note.md'),'old');
      await writer.atomicWrite('note.md','new');
      assert.equal(await disk.read('note.md'),'new'); checks++;
      await writer.atomicWrite('note.md','newer');
      assert.equal(await disk.read('note.md'),'newer'); checks++;
      fs.rename=async(a,b)=>{if(b===root+'/note.md') throw Error('native overwrite unavailable');return originalRename(a,b)};
      await assert.rejects(writer.atomicWrite('note.md','must not replace'));
      assert.equal(await disk.read('note.md'),'newer'); checks++;
    } finally {
      fs.rename=originalRename;
      mockObsidian.Platform.isDesktopApp=false;
      if(path.dirname(root)!==os.tmpdir() || !path.basename(root).startsWith('baidu-sync-reliability-')) throw Error('unsafe cleanup path');
      await fs.rm(root,{recursive:true,force:true});
    }
  }
  // Mandatory encryption header rejects plaintext pairing payloads.
  await assert.rejects(importEncryptedConfig('BDSYNC:v1:' + Buffer.from('{}').toString('base64'), 'pin')); checks++;
  console.log(`PASS: ${checks} assertions (crash snapshots, IO faults, corruption, state retries, E2EE, user backups)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
