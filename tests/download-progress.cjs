const assert=require('node:assert/strict'),esbuild=require('esbuild');
let response,lastRequest;
const bundle=esbuild.buildSync({entryPoints:['src/api/baidu-client.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
const m={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(id=>id==='obsidian'?{requestUrl:async r=>{lastRequest=r;return response()}}:require(id),m,m.exports);
(async()=>{
 const c=new m.exports.BaiduClient({accessToken:'token',refreshToken:'',tokenExpiresAt:Date.now()+1e8,appKey:'',secretKey:''});c.getDownloadLink=async()=> 'https://example.invalid/download';
 const ids=Array.from({length:100},(_,i)=>String(i+1));
 response=()=>({json:{errno:0,list:ids.slice().reverse().map(id=>({fs_id:id,dlink:'https://example.invalid/'+id}))}});
 const links=await c.getDownloadLinks(ids);assert.equal(links.size,100);assert.equal(links.get('1'),'https://example.invalid/1');assert.equal(new URL(lastRequest.url).searchParams.get('fsids'),'['+ids.join(',')+']');
 response=()=>({json:{errno:0,list:[{fs_id:'2',dlink:'https://example.invalid/2'}]}});assert.equal((await c.getDownloadLinks(['1','2'])).size,1);
 await assert.rejects(c.getDownloadLinks(Array.from({length:101},(_,i)=>String(i+1))));
 response=()=>({json:{errno:9}});await assert.rejects(c.getDownloadLinks(['1']));
 let updates=[];response=()=>({status:200,arrayBuffer:new Uint8Array(10).buffer,headers:{}});
 assert.equal((await c.downloadFile('1',10,(...v)=>updates.push(v))).byteLength,10);assert.deepEqual(updates,[[10,10]]);
 const total=4*1024*1024+5;let calls=0;updates=[];
 response=()=>{calls++;return {status:206,arrayBuffer:new Uint8Array(calls===1?4*1024*1024:5).buffer,headers:{'content-range':`bytes 0-1/${total}`}}};
 assert.equal((await c.downloadFile('2',total,(...v)=>updates.push(v))).byteLength,total);assert.deepEqual(updates,[[4*1024*1024,total],[total,total]]);
 console.log('PASS: download progress for single-response and ranged downloads');
})().catch(e=>{console.error(e);process.exitCode=1});
