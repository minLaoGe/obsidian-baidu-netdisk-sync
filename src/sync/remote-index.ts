import { App } from "obsidian";
import { BaiduClient } from "../api/baidu-client";
import { RemoteFileInfo } from "../types";
import { AtomicFileSystem } from "../utils/atomic";
import { calculateMd5 } from "../utils/crypto";
import { normalizeVaultPath, toRemotePath } from "../utils/path";

export const INDEX_DIR = ".baidu-sync-index-v1";
const AUDIT_INTERVAL = 24 * 60 * 60 * 1000;
interface Event { version: 1; id: string; phase: "begin" | "done"; paths: string[]; }
interface Cache {
  version: 1; scope: string; auditedAt: number;
  files: RemoteFileInfo[];
  events: Record<string,{ fingerprint:string; event:Event }>;
}
function validPath(path:unknown): path is string {
  return typeof path === "string" && path.length>0 && path.length<=4096 &&
    !/[\\\x00-\x1f]/.test(path) && normalizeVaultPath(path)===path &&
    path.split("/").every(p=>p!=="." && p!=="..") && path!==INDEX_DIR && !path.startsWith(INDEX_DIR+"/");
}
function validateEvent(value:any, name:string):Event {
  const match=/^([a-f0-9]{32})\.(begin|done)\.json$/.exec(name);
  if(!match || value?.version!==1 || value.id!==match[1] || value.phase!==match[2] || !Array.isArray(value.paths) || !value.paths.length || value.paths.length>200 || !value.paths.every(validPath)) throw new Error("变更记录格式无效");
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
  private async load():Promise<Cache|undefined> {
    try {
      const envelope=JSON.parse(await this.app.vault.adapter.read(this.cachePath));
      const d=envelope.data;
      if(!d || envelope.checksum!==calculateMd5(new TextEncoder().encode(JSON.stringify(d)).buffer)) return;
      if(d.version!==1 || d.scope!==this.scope || !Number.isFinite(d.auditedAt) || d.auditedAt>Date.now() || !Array.isArray(d.files) || !d.events || typeof d.events!=="object" || Array.isArray(d.events)) return;
      const paths=new Set<string>();
      for(const f of d.files) {
        const prefix=toRemotePath(this.root,"")+"/";
        if(typeof f.path!=="string" || !f.path.startsWith(prefix) || !validPath(f.path.slice(prefix.length)) || paths.has(f.path) || f.isdir!==0 || typeof f.fsId!=="string" || !Number.isFinite(f.size) || !Number.isFinite(f.serverMtime)) return;
        paths.add(f.path);
      }
      for(const [name,item] of Object.entries(d.events) as [string,any][]) {
        if(typeof item.fingerprint!=="string") return;
        validateEvent(item.event,name);
      }
      return d;
    } catch {return;}
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
    for(const f of list) {
      const name=f.path.slice(base.length+1);
      if(f.isdir || !f.path.startsWith(base+"/") || !/^[a-f0-9]{32}\.(begin|done)\.json$/.test(name) || f.size>65536) throw new Error("变更目录包含无效记录");
      map.set(name,f);
    }
    return map;
  }
  private async events(list:Map<string,RemoteFileInfo>,cache?:Cache) {
    const events:Cache["events"]={};
    for(const [name,file] of list) {
      this.checkYield();
      const previous=cache?.events[name];
      if(previous && previous.fingerprint===fingerprint(file)) {events[name]=previous;continue;}
      const data=await this.client.downloadFile(file.fsId);
      if(data.byteLength>65536) throw new Error("变更记录过大");
      const event=validateEvent(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data)),name);
      events[name]={fingerprint:fingerprint(file),event};
    }
    for(const {event} of Object.values(events)) {
      if(event.phase==="done") {
        const begin=events[event.id+".begin.json"]?.event;
        if(!begin || JSON.stringify(begin.paths)!==JSON.stringify(event.paths)) throw new Error("变更提交缺少有效起始记录");
      }
    }
    return events;
  }
  async inventory(force=false):Promise<{files:RemoteFileInfo[];incremental:boolean;changed:number}> {
    const cache=await this.load();
    let list:Map<string,RemoteFileInfo>|undefined, events:Cache["events"]|undefined;
    try {
      list=await this.journal();
      if(cache && Object.entries(cache.events).some(([name,item])=>!list!.has(name) || fingerprint(list!.get(name)!)!==item.fingerprint)) {
        force=true;this.log("历史变更记录被删除或修改，重新完整校验后重建游标");
      }
      events=await this.events(list,cache);
    } catch(e:any) {
      if(e.message==="SYNC_YIELD_FOR_CONFLICT") throw e;
      this.log("增量索引异常，回退完整目录校验："+e.message);
    }
    if(force || !cache || Date.now()-cache.auditedAt>=AUDIT_INTERVAL || !events) {
      this.checkYield();
      this.log("执行完整目录校验，建立本机同步索引");
      this.phase?.("完整校验目录，建立同步索引...");
      const files=(await this.client.listFiles(this.root,true,this.shouldYield)).filter(f=>f.isdir===0 && !f.path.startsWith(toRemotePath(this.root,INDEX_DIR)+"/"));
      // Only a validated journal captured BEFORE the scan can advance the cursor.
      // Open begins are rechecked on every later round; new commits remain unseen.
      if(events) await this.save({version:1,scope:this.scope,auditedAt:Date.now(),files,events});
      return {files,incremental:false,changed:files.length};
    }
    const changed=new Set<string>();
    for(const [name,item] of Object.entries(events)) {
      if(!cache.events[name] || (item.event.phase==="begin" && !events[item.event.id+".done.json"])) for(const path of item.event.paths) changed.add(path);
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
    await this.save({...cache,files:result,events});
    return {files:result,incremental:true,changed:changed.size};
  }
  async mutate<T>(path:string,operation:()=>Promise<T>):Promise<T> {
    return this.mutateMany([path],operation);
  }
  async mutateMany<T>(paths:string[],operation:()=>Promise<T>):Promise<T> {
    if(!paths.length) return operation();
    if(!paths.every(validPath)) throw new Error("非法的同步变更路径");
    const groups:{id:string;paths:string[]}[]=[];
    for(const path of [...new Set(paths)]) {
      let group=groups[groups.length-1];
      if(!group || group.paths.length>=200 || JSON.stringify([...group.paths,path]).length>12000) {
        group={id:Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2,"0")).join(""),paths:[]};groups.push(group);
      }
      group.paths.push(path);
    }
    const dir=toRemotePath(this.root,INDEX_DIR);
    await this.client.createDirectory(this.root);
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
