// Opt-in: read the real remote inventory twice and atomically build ONLY the local
// index. Never uploads, deletes or modifies cloud files or note contents.
const fs=require('node:fs/promises'),path=require('node:path'),esbuild=require('esbuild');
const settingsPath=process.argv[2],vaultRoot=process.argv[3];
if(!settingsPath||!vaultRoot) throw Error('Pass plugin data.json and absolute vault root');
let requests=0;
class FileSystemAdapter {
 getBasePath(){return vaultRoot;}
 full(p){return path.join(vaultRoot,p);}
 async exists(p){try{await fs.stat(this.full(p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
 async mkdir(p){await fs.mkdir(this.full(p),{recursive:true})}
 async read(p){return fs.readFile(this.full(p),'utf8')}
 async readBinary(p){const b=await fs.readFile(this.full(p));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}
 async write(p,s){await fs.writeFile(this.full(p),s)}
 async writeBinary(p,b){await fs.writeFile(this.full(p),new Uint8Array(b))}
 async remove(p){await fs.unlink(this.full(p))}
 async rename(a,b){await fs.rename(this.full(a),this.full(b))}
 async list(p){const entries=await fs.readdir(this.full(p),{withFileTypes:true});return{files:entries.filter(e=>e.isFile()).map(e=>p+'/'+e.name),folders:[]}}
}
const mock={FileSystemAdapter,Platform:{isDesktopApp:true},requestUrl:async o=>{
 if(o.method && o.method!=='GET')throw Error('Read-only diagnostic refuses remote writes/refresh');
 requests++;
 const res=await fetch(o.url,{method:'GET',headers:o.headers,signal:AbortSignal.timeout(45000)});
 if(!res.ok)throw Error('HTTP '+res.status);
 const arrayBuffer=await res.arrayBuffer();return{arrayBuffer,get json(){return JSON.parse(Buffer.from(arrayBuffer).toString())}};
}};
function load(file){const b=esbuild.buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);return m.exports;}
(async()=>{
 const settings=JSON.parse(await fs.readFile(settingsPath,'utf8'));
 if(!settings.syncPaused)throw Error('Run only after current transfers have safely drained');
 const relative=path.relative(vaultRoot,path.dirname(settingsPath)).replace(/\\/g,'/');
 if(!relative.endsWith('/plugins/baidu-sync')||relative.startsWith('../'))throw Error('Invalid plugin location');
 const configDir=relative.slice(0,-'/plugins/baidu-sync'.length);
 const {BaiduClient}=load('src/api/baidu-client.ts'),{RemoteIndex}=load('src/sync/remote-index.ts'),{calculateMd5}=load('src/utils/crypto.ts');
 const client=new BaiduClient({...settings,onTokenRefreshed:()=>{throw Error('Read-only diagnostic requires fresh credentials')}});
 for(const method of ['uploadFile','deleteFile','createDirectory']) client[method]=async()=>{throw Error('Remote writes forbidden')};
 const scope=calculateMd5(new TextEncoder().encode(JSON.stringify([settings.remoteBasePath,settings.appKey,settings.username])).buffer);
 const index=new RemoteIndex({vault:{configDir,adapter:new FileSystemAdapter()}},client,settings.remoteBasePath,scope,()=>{},()=>false);
 for(let round=1;round<=2;round++){
  const before=requests,start=Date.now();const result=await index.inventory();
  console.log(JSON.stringify({round,files:result.files.length,incremental:result.incremental,changed:result.changed,requests:requests-before,seconds:Math.round((Date.now()-start)/100)/10}));
  if(round===2&&!result.incremental)throw Error('Second pass did not use incremental index');
 }
})().catch(e=>{console.error(String(e.message).replace(/access_token=[^&\s]+/g,'access_token=REDACTED'));process.exitCode=1});
