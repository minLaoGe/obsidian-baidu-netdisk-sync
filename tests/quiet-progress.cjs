const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const mock = {Plugin:class{}, Component:class{}, PluginSettingTab:class{}, Modal:class{}, Platform:{}, TFile:class{}, FileSystemAdapter:class{}, Notice:class{constructor(){throw Error('Unexpected background notice');}}};
function load(entry) {
 const m={exports:{}};
 new Function('require','module','exports',esbuild.buildSync({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']}).outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);
 return m.exports;
}
(async()=>{
 const Plugin=load('src/main.ts').default;
 const {MobileSyncProgress}=load('src/progress-ui.ts');
 for(const platform of ['desktop','android','ios']) {
  mock.Platform.isMobile=platform!=='desktop';
  const plugin=new Plugin(); plugin.settings={accessToken:'test',syncPaused:false};
  let opened=0, called=0;
  plugin.mobileProgress={open(){opened++;},update(){}};
  plugin.syncEngine={async runFullSync(force,interactive){called++;assert.equal(interactive,called===2);}};
  await plugin.runSync(false,false);assert.equal(opened,0);
  plugin.lastSyncCompletedAt=0;
  await plugin.runSync();assert.equal(opened,1);
  const progress=new MobileSyncProgress({syncEngine:{getProgress:()=>({startedAt:1,busy:true,total:0,finishedAt:0})}});
  // No DOM exists: automatic updates must never create a card or modal.
  progress.update();progress.render();
 }
 console.log('PASS: desktop, Android and iOS background runs and progress updates never open UI; manual sync opens progress');
})().catch(e=>{console.error(e);process.exitCode=1});
