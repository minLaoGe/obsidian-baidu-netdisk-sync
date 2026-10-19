const assert=require('node:assert/strict'),esbuild=require('esbuild');
const {randomBytes}=require('node:crypto');
function clientWith(requestUrl){const r=esbuild.buildSync({entryPoints:['src/api/baidu-client.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',r.outputFiles[0].text)(id=>id==='obsidian'?{requestUrl}:require(id),m,m.exports);return new m.exports.BaiduClient({appKey:'test',secretKey:'test',accessToken:'test',refreshToken:'',tokenExpiresAt:0});}
(async()=>{
 for(const fail of [false,true]){
  const phases=[];
  const c=clientWith(async o=>{const u=new URL(o.url),method=u.searchParams.get('method');
   if(method==='precreate'){phases.push('precreate');return {json:{errno:0,return_type:1,uploadid:'session',block_list:[0,1]}};}
   if(method==='upload'){assert.equal(o.headers['Content-Length'],undefined);const part=u.searchParams.get('partseq');phases.push('part-'+part);if(fail&&part==='1')throw Error('network interrupted');return {json:{md5:'ok'}};}
   if(method==='create'){phases.push('commit');return {json:{errno:0,fs_id:123,md5:'remote-hash'}};}
   throw Error('unexpected API');
  });
  const promise=c.uploadFile('/test.bin',new Uint8Array(4*1024*1024+16));
  if(fail)await assert.rejects(promise);else assert.equal((await promise).fsId,'123');
  assert.deepEqual(phases,fail?['precreate','part-0','part-1']:['precreate','part-0','part-1','commit']);
 }
 // The server requests only missing blocks; no needless re-upload of existing parts.
 {
  const parts=[];const c=clientWith(async o=>{const u=new URL(o.url),m=u.searchParams.get('method');if(m==='precreate')return{json:{errno:0,return_type:1,uploadid:'s',block_list:[1]}};if(m==='upload'){parts.push(u.searchParams.get('partseq'));return{json:{}}}return{json:{errno:0,fs_id:1}};});
  await c.uploadFile('/test',new Uint8Array(4*1024*1024+1));assert.deepEqual(parts,['1']);
 }
 {
  let calls=0;const c=clientWith(async()=>{calls++;return{json:{errno:0,return_type:2,info:{fs_id:42,md5:'rapid'}}};});
  assert.equal((await c.uploadFile('/rapid',new Uint8Array(2))).fsId,'42');assert.equal(calls,1);
 }
 for(const response of [{errno:0,return_type:1,block_list:[0]},{errno:0,return_type:1,uploadid:'s',block_list:[99]},{errno:0,return_type:2}]){
  let calls=0;const c=clientWith(async()=>{calls++;return{json:response}});await assert.rejects(c.uploadFile('/invalid',new Uint8Array(2)));assert.equal(calls,1);
 }
 // Concurrent callers refresh and persist credentials exactly once.
 {
  let refreshes=0,saves=0;
  const c=clientWith(async()=>{refreshes++;await new Promise(r=>setTimeout(r,5));return{json:{access_token:'fresh',refresh_token:'next',expires_in:3600}};});
  c.refreshToken='expired-refresh';c.tokenExpiresAt=Date.now()-1;
  c.onTokenRefreshed=async()=>{saves++;await new Promise(r=>setTimeout(r,3));};
  const tokens=await Promise.all(Array.from({length:6},()=>c.ensureFreshToken()));
  assert.deepEqual(tokens,Array(6).fill('fresh'));assert.equal(refreshes,1);assert.equal(saves,1);
 }
 console.log('PASS: precreate protocol, ordered chunks, no commit after failed upload, partial-block reuse, rapid upload, invalid-session guards');
})().catch(e=>{console.error(e);process.exitCode=1});
