const assert=require('node:assert/strict'),esbuild=require('esbuild');
function client(handler){const b=esbuild.buildSync({entryPoints:['src/api/baidu-client.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(x=>x==='obsidian'?{requestUrl:async o=>({json:await handler(new URL(o.url))})}:require(x),m,m.exports);return new m.exports.BaiduClient({accessToken:'test',refreshToken:'',tokenExpiresAt:0,appKey:'',secretKey:''});}
const item=(path,isdir=0)=>({path,isdir,fs_id:path,server_filename:path.split('/').pop(),md5:'x'});
(async()=>{
 let calls=[];
 const c=client(u=>{const d=u.searchParams.get('dir');calls.push(d);return{errno:0,list:d==='/root'?[item('/root/sub',1),item('/root/a')]:d==='/root/sub'?[item('/root/sub/deep',1),item('/root/sub/b')]:[item('/root/sub/deep/c')]};});
 assert.equal((await c.listFiles('/root',true)).filter(f=>!f.isdir).length,3);assert.equal(calls.length,3);
 calls=[];assert.equal((await c.listFiles('/root',false)).length,2);assert.equal(calls.length,1);
 let pages=[];const paged=client(u=>{const start=+u.searchParams.get('start');pages.push(start);return{errno:0,list:start===0?Array.from({length:1000},(_,i)=>item('/root/'+i)):[item('/root/last')]};});
 assert.equal((await paged.listFiles('/root')).length,1001);assert.deepEqual(pages,[0,1000]);
 const repeated=client(()=>({errno:0,has_more:1,list:[item('/root/a')]}));await assert.rejects(repeated.listFiles('/root'),/分页重复/);
 const missingChild=client(u=>u.searchParams.get('dir')==='/root'?{errno:0,list:[item('/root/sub',1)]}:{errno:-9});await assert.rejects(missingChild.listFiles('/root'),/枚举不完整/);
 const malformed=client(()=>({errno:0}));await assert.rejects(malformed.listFiles('/root'));
 const outside=client(()=>({errno:0,list:[item('/other/x')]}));await assert.rejects(outside.listFiles('/root'));
 assert.deepEqual(await client(()=>({errno:-9})).listFiles('/new'),[]);
 console.log('PASS: explicit recursive traversal, missing has_more pagination, repeated/incomplete/out-of-root inventories fail closed');
})().catch(e=>{console.error(e);process.exitCode=1});
