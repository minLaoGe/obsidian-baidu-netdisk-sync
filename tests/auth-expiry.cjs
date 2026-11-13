const assert=require('node:assert/strict'),esbuild=require('esbuild');
let calls=0,response;
const bundle=esbuild.buildSync({entryPoints:['src/api/baidu-client.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
const m={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(id=>id==='obsidian'?{requestUrl:async()=>{calls++;return{json:response}}}:require(id),m,m.exports);
(async()=>{
 const make=(opts={})=>new m.exports.BaiduClient({accessToken:'expired',refreshToken:'refresh',tokenExpiresAt:Date.now()-1000,appKey:'key',secretKey:'',...opts});
 await assert.rejects(make().listFiles('/root'),/授权已过期.*AppSecret/);assert.equal(calls,0);
 response={errno:-6};await assert.rejects(make({tokenExpiresAt:0}).listFiles('/root'),/授权无效或已过期/);
 response={error:'invalid_grant'};await assert.rejects(make({secretKey:'secret'}).listFiles('/root'),/授权已过期或续期失败/);
 const updated=make();updated.updateCredentials('expired','refresh',Date.now()-1000,'key','secret');calls=0;response={error:'invalid_grant'};await assert.rejects(updated.listFiles('/root'),/续期失败/);assert.equal(calls,1,'updated AppSecret reaches refresh request');
 console.log('PASS: expired credentials and errno -6 report actionable authorization errors');
})().catch(e=>{console.error(e);process.exitCode=1});
