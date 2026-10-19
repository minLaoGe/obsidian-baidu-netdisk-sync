const assert=require('node:assert/strict'),esbuild=require('esbuild');
const buttons=[];let closes=0,deleted=0;const events=[];
class TFile{constructor(path){this.path=path;this.extension=path.split('.').pop()}}
class Modal{constructor(app){this.app=app;this.contentEl={empty(){},createEl(){}}}open(){this.onOpen?.()}close(){closes++}}
class Setting{constructor(){this.controlEl={createEl:()=>({addEventListener(){}})}}setName(){return this}setDesc(){return this}setHeading(){return this}addToggle(fn){fn({setValue(){return this},onChange(){return this}});return this}addButton(fn){const b={setButtonText(t){this.text=t;return this},setWarning(){return this},setDisabled(){return this},onClick(fn){this.callback=fn;return this}};fn(b);buttons.push(b);return this}}
const mock={Modal,Setting,TFile,Notice:class{}};const bundle=esbuild.buildSync({entryPoints:['src/conflicts-ui.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});const m={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(id=>id==='obsidian'?mock:require(id),m,m.exports);
const leaf={setViewState:async state=>{assert.equal(state.type,'markdown');assert.equal(state.state.mode,'source');events.push('open:'+state.state.file)},openFile:async file=>events.push('open:'+file.path),view:{containerEl:{ownerDocument:{defaultView:{focus:()=>events.push('focus-window')}}}}};
const app={vault:{adapter:{exists:async()=>true},getAbstractFileByPath:p=>new TFile(p)},workspace:{getLeaf:mode=>{assert.equal(mode,'tab');return leaf},revealLeaf:async l=>{assert.equal(l,leaf);events.push('reveal')},setActiveLeaf:()=>events.push('active')}};
const engine={getPendingConflicts:()=>[{path:'note.md',remote:{exists:true},copies:['note.conflict-20261019-000000-test.md']}],trashConflictFile:async()=>{deleted++}};
(async()=>{const ui=new m.exports.ConflictReviewModal(app,engine);ui.onOpen();await buttons.find(b=>b.text==='打开原文件').callback();assert.equal(closes,1);assert.deepEqual(events,['open:note.md','reveal','active','focus-window']);
 await buttons.find(b=>b.text==='删除副本').callback();assert.equal(deleted,0);await buttons.find(b=>b.text==='确认移入回收站').callback();assert.equal(deleted,1);
 console.log('PASS: open original in an Obsidian leaf and focus it; deletion requires explicit confirmation');
})().catch(e=>{console.error(e);process.exitCode=1});
