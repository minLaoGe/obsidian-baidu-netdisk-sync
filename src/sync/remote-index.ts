import { App } from "obsidian";
import { BaiduClient } from "../api/baidu-client";
import { RemoteFileInfo } from "../types";
import { AtomicFileSystem } from "../utils/atomic";
import { calculateMd5 } from "../utils/crypto";
import { normalizeVaultPath, toRemotePath } from "../utils/path";

export const INDEX_DIR = ".baidu-sync-index-v1";
// Reserved during migration: all devices must ignore this before v2 writes begin.
export const NEXT_INDEX_DIR = INDEX_DIR + "/v2";
const SNAPSHOT_DIR = INDEX_DIR + "/snapshots";
const SNAPSHOT_LIMIT = 20 * 1024 * 1024;
const AUDIT_INTERVAL = 24 * 60 * 60 * 1000;
export { boundedInventoryRead } from "../utils/read-timeout";
import { boundedInventoryRead } from "../utils/read-timeout";
interface Event { version: 1; id: string; phase: "begin" | "done"; paths: string[]; }
interface Cache {
  version: 1; scope: string; auditedAt: number;
  files: RemoteFileInfo[];
  historical?: Record<string,string>;
  events: Record<string,{ fingerprint:string; event:Event }>;
}
function validPath(path:unknown): path is string {
  return typeof path === "string" && path.length>0 && path.length<=4096 &&
    !/[\\\x00-\x1f]/.test(path) && normalizeVaultPath(path)===path &&
    path.split("/").every(p=>p!=="." && p!=="..") && path!==INDEX_DIR && !path.startsWith(INDEX_DIR+"/") &&
    path!==NEXT_INDEX_DIR && !path.startsWith(NEXT_INDEX_DIR+"/");
}
function validateEvent(value:any, name:string):Event {
  const v2=name.startsWith("v2/");
  const match=/^([a-f0-9]{32})\.(begin|done)\.json$/.exec(v2 ? name.slice(3) : name);
  if(!match || value?.version!==1 || value.id!==match[1] || value.phase!==match[2] || !Array.isArray(value.paths) || !value.paths.length || value.paths.length>(v2 ? 10000 : 200) || !value.paths.every(validPath)) throw new Error("变更记录格式无效");
  return {version:1,id:value.id,phase:value.phase,paths:value.paths};
}
function fingerprint(file:RemoteFileInfo):string {return JSON.stringify([file.fsId,file.md5,file.size,file.serverMtime]);}

/** A local full inventory plus immutable remote invalidation records. A begin
 * record MUST be committed before mutating a note. Unfinished writes are always
 * rechecked against the actual remote directory; events never assert deletion.
 * Every device owns unique record names; no shared manifest is overwritten. */
export class RemoteIndex {
  private cachePath:string;
  constructor(private app:App,private client:BaiduClient,private root:string,private scope:string,
    private log:(message:string)=>void,private shouldYield:()=>boolean, private phase?:(text:string)=>void) {
    this.cachePath=`${app.vault.configDir || ".obsidian"}/plugins/baidu-sync/remote-index.json`;
  }
  private checkYield() {if(this.shouldYield()) throw new Error("SYNC_YIELD_FOR_CONFLICT");}
  private validateCache(envelope:any):Cache|undefined {
    try {
      const d=envelope.data;
      if(!d || envelope.checksum!==calculateMd5(new TextEncoder().encode(JSON.stringify(d)).buffer)) return;
      if(d.version!==1 || d.scope!==this.scope || !Number.isFinite(d.auditedAt) || d.auditedAt>Date.now() || !Array.isArray(d.files) || !d.events || typeof d.events!=="object" || Array.isArray(d.events)) return;
      const paths=new Set<string>();
      for(const f of d.files) {
        const prefix=toRemotePath(this.root,"")+"/";
        if(typeof f.path!=="string" || !f.path.startsWith(prefix) || !validPath(f.path.slice(prefix.length)) || paths.has(f.path) || f.isdir!==0 || typeof f.fsId!=="string" || !Number.isFinite(f.size) || !Number.isFinite(f.serverMtime)) return;
        paths.add(f.path);
      }
      if(d.historical!==undefined && (!d.historical || typeof d.historical!=="object" || Array.isArray(d.historical) || Object.entries(d.historical).some(([name,value])=>! /^(?:v2\/)?[a-f0-9]{32}\.(?:begin|done)\.json$/.test(name) || typeof value!=="string"))) return;
      for(const [name,item] of Object.entries(d.events) as [string,any][]) {
        if(typeof item.fingerprint!=="string") return;
        validateEvent(item.event,name);
      }
      return d;
    } catch {return;}
  }
  private async load():Promise<Cache|undefined> {
    try {return this.validateCache(JSON.parse(await this.app.vault.adapter.read(this.cachePath)));} catch {return;}
  }
  private async snapshotDeviceId():Promise<string> {
    const path=`${this.app.vault.configDir || ".obsidian"}/plugins/baidu-sync/snapshot-device-id`;
    try {const id=(await this.app.vault.adapter.read(path)).trim();if(/^[a-f0-9]{32}$/.test(id)) return id;} catch {}
    const id=Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,"0")).join("");
    await new AtomicFileSystem(this.app).atomicWrite(path,id);
    return id;
  }
  private async publishSnapshot(cache:Cache):Promise<void> {
    const data=JSON.stringify({checksum:calculateMd5(new TextEncoder().encode(JSON.stringify(cache)).buffer),data:cache});
    const bytes=new TextEncoder().encode(data);
    if(bytes.byteLength>SNAPSHOT_LIMIT) {this.log("云端快照过大，跳过上传");return;}
    const dir=toRemotePath(this.root,SNAPSHOT_DIR);
    await this.client.createDirectory(this.root);
    await this.client.createDirectory(toRemotePath(this.root,INDEX_DIR));
    await this.client.createDirectory(dir);
    await this.client.uploadFile(dir+"/"+await this.snapshotDeviceId()+".json",bytes.buffer);
  }
  private async loadSnapshot():Promise<Cache|undefined> {
    const dir=toRemotePath(this.root,SNAPSHOT_DIR);
    const files=(await this.client.listFiles(dir,false,this.shouldYield)).filter(f=>f.isdir===0 && f.path.startsWith(dir+"/") && /^[a-f0-9]{32}\.json$/.test(f.path.slice(dir.length+1)) && f.size>0 && f.size<=SNAPSHOT_LIMIT);
    files.sort((a,b)=>b.serverMtime-a.serverMtime);
    for(const file of files.slice(0,5)) {
      this.checkYield();
      try {
        const raw=await boundedInventoryRead(this.client.downloadFile(file.fsId,file.size));
        if(raw.byteLength!==file.size || raw.byteLength>SNAPSHOT_LIMIT) continue;
        const cache=this.validateCache(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)));
        if(cache && Date.now()-cache.auditedAt<AUDIT_INTERVAL) return cache;
      } catch(e:any) {if(e.message==="SYNC_YIELD_FOR_CONFLICT") throw e;}
    }
    return;
  }
  private async save(cache:Cache) {
    const checksum=calculateMd5(new TextEncoder().encode(JSON.stringify(cache)).buffer);
    await new AtomicFileSystem(this.app).atomicWrite(this.cachePath,JSON.stringify({checksum,data:cache}));
  }
  async invalidate():Promise<void> {
    const cache=await this.load();
    if(cache) await this.save({...cache,auditedAt:0});
  }
  private async journal():Promise<Map<string,RemoteFileInfo>> {
    this.checkYield();
    const base=toRemotePath(this.root,INDEX_DIR);
    const list=await this.client.listFiles(base,false,this.shouldYield);
    const map=new Map<string,RemoteFileInfo>();
    let hasV2=false;
    for(const f of list) {
      const name=f.path.slice(base.length+1);
      if (f.isdir && f.path === toRemotePath(this.root,NEXT_INDEX_DIR)) { hasV2=true; continue; }
      if (f.isdir && f.path === toRemotePath(this.root,SNAPSHOT_DIR)) continue;
      if(f.isdir || !f.path.startsWith(base+"/") || !/^[a-f0-9]{32}\.(begin|done)\.json$/.test(name) || f.size>65536) throw new Error("变更目录包含无效记录");
      map.set(name,f);
    }
    if(hasV2) {
      const nested=toRemotePath(this.root,NEXT_INDEX_DIR);
      for(const f of await this.client.listFiles(nested,false,this.shouldYield)) {
        const name=f.path.slice(nested.length+1);
        if(f.isdir || !f.path.startsWith(nested+"/") || !/^[a-f0-9]{32}\.(begin|done)\.json$/.test(name) || f.size>1048576) throw new Error("批量变更目录包含无效记录");
        map.set("v2/"+name,f);
      }
    }
    return map;
  }
  private async events(list:Map<string,RemoteFileInfo>,cache?:Cache) {
    const events:Cache["events"]={};
    const records = [...list.entries()];
    const results: Array<Cache["events"][string]> = new Array(records.length);
    let next=0, checked=0, failed=false;
    const worker = async () => {
      while (!failed) {
        try { this.checkYield(); } catch(error) { failed=true; throw error; }
        const index=next++;
        if (index>=records.length) return;
        const [name,file]=records[index];
        try {
          const previous=cache?.events[name];
          if(previous && previous.fingerprint===fingerprint(file)) results[index]=previous;
          else {
            const data=await boundedInventoryRead(this.client.downloadFile(file.fsId, file.size));
            if(data.byteLength>(name.startsWith("v2/") ? 1048576 : 65536)) throw new Error("变更记录过大");
            const event=validateEvent(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data)),name);
            results[index]={fingerprint:fingerprint(file),event};
          }
          if (failed) return;
          checked++;
          if(checked===1 || checked%25===0 || checked===records.length) this.phase?.(`检查远端变更记录（${checked}/${records.length}）`);
        } catch(error) { failed=true; throw error; }
      }
    };
    const settled = await Promise.allSettled(Array.from({length:Math.min(4,records.length)},()=>worker()));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    this.checkYield();
    for(let i=0;i<records.length;i++) events[records[i][0]]=results[i];
    for(const [name,{event}] of Object.entries(events)) {
      if(event.phase==="done") {
        const begin=events[(name.startsWith("v2/") ? "v2/" : "")+event.id+".begin.json"]?.event;
        if(!begin || JSON.stringify(begin.paths)!==JSON.stringify(event.paths)) throw new Error("变更提交缺少有效起始记录");
      }
    }
    return events;
  }
  async inventory(force=false,allowSnapshot=true):Promise<{files:RemoteFileInfo[];incremental:boolean;changed:number;fromSnapshot?:boolean}> {
    let cache=await this.load();
    let snapshotUsed=false;
    if(!cache && !force && allowSnapshot) {
      try {cache=await this.loadSnapshot();if(cache) {snapshotUsed=true;this.log("已读取云端索引快照，正在检查后续变更");}}
      catch(e:any) {if(e.message==="SYNC_YIELD_FOR_CONFLICT") throw e;this.log("云端快照不可用，执行完整校验");}
    }
    let list:Map<string,RemoteFileInfo>|undefined, events:Cache["events"]|undefined;
    let historical:Record<string,string>={...cache?.historical};
    try {
      list=await this.journal();
      if(!cache) {
        // Completed pairs existing before the full scan are only a boundary;
        // open begins remain decoded and rechecked until their matching done.
        for(const [name,file] of list) {
          if(!name.endsWith(".begin.json")) continue;
          const done=name.slice(0,-"begin.json".length)+"done.json";
          const completion=list.get(done);
          if(completion) {historical[name]=fingerprint(file);historical[done]=fingerprint(completion);}
        }
      } else if(Object.entries(historical).some(([name,value])=>!list!.has(name) || fingerprint(list!.get(name)!)!==value)) {
        historical={};force=true;this.log("历史记录发生变化，重新完整校验");
      }
      if(cache && Object.entries(cache.events).some(([name,item])=>!list!.has(name) || fingerprint(list!.get(name)!)!==item.fingerprint)) {
        force=true;this.log("历史变更记录被删除或修改，重新完整校验后重建游标");
      }
      events=await this.events(new Map([...list].filter(([name])=>!(name in historical))),cache);
    } catch(e:any) {
      if(e.message==="SYNC_YIELD_FOR_CONFLICT") throw e;
      if(e.message==="SYNC_REMOTE_TIMEOUT") throw new Error("检查远端变更记录超时，请检查网络后重新点击同步");
      this.log("增量索引异常，回退完整目录校验："+e.message);
    }
    if(force || !cache || Date.now()-cache.auditedAt>=AUDIT_INTERVAL || !events) {
      this.checkYield();
      this.log("执行完整目录校验，建立本机同步索引");
      this.phase?.("完整校验目录，建立同步索引...");
      const files=(await this.client.listFiles(this.root,true,this.shouldYield)).filter(f=>f.isdir===0 && !f.path.startsWith(toRemotePath(this.root,INDEX_DIR)+"/") && !f.path.startsWith(toRemotePath(this.root,NEXT_INDEX_DIR)+"/"));
      // Only a validated journal captured BEFORE the scan can advance the cursor.
      // Open begins are rechecked on every later round; new commits remain unseen.
      if(events) {
        const snapshot:Cache={version:1,scope:this.scope,auditedAt:Date.now(),files,events,historical};
        await this.save(snapshot);
        try {await this.publishSnapshot(snapshot);} catch {this.log("云端索引快照上传失败，本机索引仍可使用");}
      }
      return {files,incremental:false,changed:files.length};
    }
    const changed=new Set<string>();
    for(const [name,item] of Object.entries(events)) {
      if(!cache.events[name] || (item.event.phase==="begin" && !events[(name.startsWith("v2/") ? "v2/" : "")+item.event.id+".done.json"])) for(const path of item.event.paths) changed.add(path);
    }
    this.phase?.(`检查远端变更（${changed.size} 个路径）`);
    const files=new Map(cache.files.map(f=>[f.path,f]));
    const directories=new Map<string,RemoteFileInfo[]>();
    for(const path of changed) {
      this.checkYield();
      const absolute=toRemotePath(this.root,path), parent=absolute.slice(0,absolute.lastIndexOf("/"));
      if(!directories.has(parent)) directories.set(parent,await this.client.listFiles(parent,false,this.shouldYield));
      const actual=directories.get(parent)!.find(f=>f.path===absolute && f.isdir===0);
      if(actual) files.set(absolute,actual); else files.delete(absolute);
    }
    const result=[...files.values()];
    await this.save({...cache,files:result,events,historical});
    return {files:result,incremental:!snapshotUsed,changed:changed.size,fromSnapshot:snapshotUsed};
  }
  async mutate<T>(path:string,operation:()=>Promise<T>):Promise<T> {
    return this.mutateMany([path],operation);
  }
  async mutateMany<T>(paths:string[],operation:()=>Promise<T>):Promise<T> {
    if(!paths.length) return operation();
    if(!paths.every(validPath)) throw new Error("非法的同步变更路径");
    const groups:{id:string;paths:string[];bytes:number}[]=[];
    for(const path of [...new Set(paths)]) {
      let group=groups[groups.length-1];
      const pathBytes=new TextEncoder().encode(JSON.stringify(path)).byteLength+1;
      if(!group || group.paths.length>=10000 || group.bytes+pathBytes>999000) {
        group={id:Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2,"0")).join(""),paths:[],bytes:2};groups.push(group);
      }
      group.paths.push(path);group.bytes+=pathBytes;
    }
    const legacyDir=toRemotePath(this.root,INDEX_DIR);
    const dir=toRemotePath(this.root,NEXT_INDEX_DIR);
    await this.client.createDirectory(this.root);
    await this.client.createDirectory(legacyDir);
    await this.client.createDirectory(dir);
    const publish=async(group:typeof groups[number],phase:"begin"|"done")=>{
      const event:Event={version:1,id:group.id,phase,paths:group.paths};
      await this.client.uploadFile(dir+"/"+group.id+"."+phase+".json",new TextEncoder().encode(JSON.stringify(event)).buffer);
    };
    const published:typeof groups=[];
    try {
      for(const group of groups) {await publish(group,"begin");published.push(group);}
      return await operation(); // Every intent must succeed before ANY user-file mutation.
    } finally {
      for(const group of published) {
        try {await publish(group,"done");} catch {this.log("变更提交记录未完成，后续会持续复查受影响文件");}
      }
    }
  }
}
