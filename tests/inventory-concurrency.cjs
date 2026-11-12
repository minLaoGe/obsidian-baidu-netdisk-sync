const assert=require('node:assert/strict'),esbuild=require('esbuild');
const m={exports:{}};new Function('require','module','exports',esbuild.buildSync({entryPoints:['src/sync/remote-index.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']}).outputFiles[0].text)(id=>id==='obsidian'?{Platform:{},FileSystemAdapter:class{}}:require(id),m,m.exports);
(async()=>{
 let active=0,max=0,done=0;const phases=[];const ids=Array.from({length:12},(_,i)=>i.toString(16).padStart(32,'0'));
 const list=new Map(ids.map(id=>[id+'.begin.json',{fsId:id,size:100,serverMtime:1}]));
 const client={async downloadFile(id){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;done++;return new TextEncoder().encode(JSON.stringify({version:1,id,phase:'begin',paths:['note.md']})).buffer;}};
 const index=new m.exports.RemoteIndex({vault:{configDir:'.obsidian'}},client,'/root','scope',()=>{},()=>false,p=>phases.push(p));
 const events=await index.events(list);assert.equal(Object.keys(events).length,12);assert.equal(done,12);assert(max>1&&max<=4);assert.match(phases.at(-1),/12\/12/);
 let remaining=0,readCount=0;
 client.downloadFile=async()=>{readCount++;remaining++;if(readCount===1){remaining--;throw Error('broken');}await new Promise(r=>setTimeout(r,12));remaining--;return new TextEncoder().encode('{}').buffer;};
 await assert.rejects(index.events(list),/broken/);assert.equal(remaining,0,'all started reads settle before reporting failure');assert(readCount<=4,'failure prevents scheduling further reads');
 let interrupted=false;client.downloadFile=async(id)=>{interrupted=true;return new TextEncoder().encode(JSON.stringify({version:1,id,phase:'begin',paths:['note.md']})).buffer;};
 const yielding=new m.exports.RemoteIndex({vault:{configDir:'.obsidian'}},client,'/root','scope',()=>{},()=>interrupted);
 await assert.rejects(yielding.events(list),/SYNC_YIELD_FOR_CONFLICT/);
 console.log('PASS: remote journal reads run at most four concurrently, complete in order and reject malformed records');
})().catch(e=>{console.error(e);process.exitCode=1});
