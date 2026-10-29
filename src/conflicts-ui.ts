import { mergeText } from "./sync/merge";
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { SyncEngine } from "./sync/engine";

export class ConflictReviewModal extends Modal {
  private selected=new Set<string>();
  private batchBusy=false;
  private closeTimer?: number;
  onClose() { if (this.closeTimer !== undefined) window.clearTimeout(this.closeTimer); this.closeTimer = undefined; }
  private selectionBox(setting:Setting, checked:boolean, label:string, change:(value:boolean)=>void):Setting {
    const input=setting.controlEl.createEl("input",{type:"checkbox",attr:{"aria-label":label}});
    input.checked=checked;input.disabled=this.batchBusy;
    input.addEventListener("change",()=>change(input.checked));
    return setting;
  }
  constructor(app: App, private engine: SyncEngine) { super(app); }
  private async openInObsidian(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice("文件不存在；不会自动创建空白笔记。",10000); return; }
    const textExtensions = ["md","markdown","txt","json","csv","yaml","yml","xml","html","css","js","ts","log"];
    const internalMedia = ["pdf","png","jpg","jpeg","gif","svg","webp","avif","bmp","mp3","wav","ogg","m4a","mp4","webm","canvas","base"];
    if (!textExtensions.includes(file.extension) && !internalMedia.includes(file.extension)) {
      new Notice("Obsidian 暂不支持此文件的内部预览，未调用外部程序。",10000); return;
    }
    this.close();
    const leaf = this.app.workspace.getLeaf("tab");
    if (textExtensions.includes(file.extension)) {
      await leaf.setViewState({type:"markdown",state:{file:file.path,mode:"source"},active:true});
    } else await leaf.openFile(file,{active:true});
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf,{focus:true});
    leaf.view.containerEl.ownerDocument.defaultView?.focus();
  }

  private async openMerge(path:string):Promise<void> {
    try {
      const snapshot=await this.engine.readConflictMerge(path);
      const comparison=mergeText(snapshot.local ?? "",snapshot.remote ?? "");
      const modal=new Modal(this.app);
      modal.modalEl.addClass("baidu-merge-modal");
      modal.contentEl.createEl("h2",{text:"比较并合并："+path});
      modal.contentEl.createEl("p",{text:"− 本地内容，+ 网盘内容。下方编辑同一份合并结果，删除冲突标记后保存。无历史正文基线，差异需人工判断。"});
      if(snapshot.local===null || snapshot.remote===null) modal.contentEl.createEl("p",{text:snapshot.local===null?"本地已删除；保存将恢复此文件。":"网盘已删除；保存并提交将恢复网盘文件。"});
      const diff=modal.contentEl.createEl("pre",{cls:"baidu-merge-diff"});
      for(const line of comparison.diff.split("\n")) diff.createEl("div",{text:line,cls:line.startsWith("- ")?"baidu-merge-removed":line.startsWith("+ ")?"baidu-merge-added":""});
      const editor=modal.contentEl.createEl("textarea",{cls:"baidu-merge-editor",attr:{"aria-label":"合并结果","spellcheck":"false"}});
      editor.value=comparison.merged;
      new Setting(modal.contentEl)
        .addButton(b=>b.setButtonText("采用本地内容").onClick(()=>{editor.value=snapshot.local ?? "";}))
        .addButton(b=>b.setButtonText("采用网盘内容").onClick(()=>{editor.value=snapshot.remote ?? "";}))
        .addButton(b=>b.setButtonText("重置为冲突标记").onClick(()=>{editor.value=comparison.merged;}));
      new Setting(modal.contentEl).setDesc("保存后自动提交并标记已解决，成功后从冲突列表移除；备份保留。提交失败时保留待办。")
        .addButton(b=>b.setButtonText("取消").onClick(()=>modal.close()))
        .addButton(b=>b.setButtonText("保存并解决冲突").setCta().onClick(async()=>{
          b.setDisabled(true);
          try {await this.engine.saveConflictMerge(path,snapshot,editor.value);modal.close();this.onOpen();}
          catch(e:any){new Notice(e.message || String(e),10000);b.setDisabled(false);}
        }));
      modal.open();
    } catch(e:any) {new Notice(e.message || String(e),10000);}
  }

  private confirmBatch(side:"local"|"remote"):void {
    if(this.batchBusy) return;
    const paths=[...this.selected];
    if(!paths.length) {new Notice("请先勾选需要处理的冲突");return;}
    const modal=new Modal(this.app);
    modal.contentEl.createEl("h2",{text:`接受所选${side==="local"?"本地":"远端"}版本（${paths.length} 项）`});
    modal.contentEl.createEl("p",{text:side==="local"?"以当前本地内容覆盖网盘；本地已删除的文件会同步删除网盘版本。成功后自动移出冲突列表。":"以网盘版本覆盖本地；网盘已删除的文件会移入本地回收站。被覆盖的本地内容会保留备份，成功后自动移出冲突列表。"});
    const list=modal.contentEl.createEl("ul");for(const path of paths) list.createEl("li",{text:path});
    const status=modal.contentEl.createEl("p",{text:"确认后将逐项处理。"});
    new Setting(modal.contentEl)
      .addButton(b=>b.setButtonText("关闭窗口").onClick(()=>modal.close()))
      .addButton(b=>b.setButtonText("确认批量接受").setWarning().onClick(async()=>{
        b.setDisabled(true);this.batchBusy=true;
        status.setText("等待正在传输的文件安全完成，然后优先处理所选冲突…关闭窗口不会取消正在进行的提交。");
        try {
          const result=await this.engine.acceptConflictVersions(paths,side,(done,total,path)=>{
            status.setText(done===0?`等待同步让出执行机会（0/${total}）…`:`已处理 ${done}/${total}：${path}`);
            b.setButtonText(`处理中 ${done}/${total}`);
          });
          for(const path of result.resolved) this.selected.delete(path);
          modal.close();
          new Notice(`批量解决完成：成功 ${result.resolved.length} 项，失败 ${result.failed.length} 项`,10000);
          if(result.failed.length) {
            const errors=new Modal(this.app);errors.contentEl.createEl("h2",{text:"以下冲突未完成，仍保留在列表"});
            for(const error of result.failed) errors.contentEl.createEl("p",{text:`${error.path}：${error.message}`});errors.open();
          }
        } catch(e:any) {new Notice(e.message || String(e),10000);b.setDisabled(false);}
        finally {this.batchBusy=false;this.onOpen();}
      }));
    modal.open();
  }

  private confirmTrash(conflictPath: string, target: string): void {
    const modal = new Modal(this.app);
    new Setting(modal.contentEl).setName("确认移入本地回收站").setHeading();
    modal.contentEl.createEl("p",{text:`将 ${target} 移入 Obsidian 本地回收站，可恢复。此操作不会删除网盘文件。删除原文件后，只有另行点击“确认已解决并提交”才会将删除同步到网盘。`});
    new Setting(modal.contentEl)
      .addButton(b=>b.setButtonText("取消").onClick(()=>modal.close()))
      .addButton(b=>b.setButtonText("确认移入回收站").setWarning().onClick(async()=>{
        b.setDisabled(true);
        try { await this.engine.trashConflictFile(conflictPath,target); modal.close(); this.onOpen(); }
        catch(e:any){new Notice(`删除失败：${e.message || String(e)}`,10000);b.setDisabled(false);}
      }));
    modal.open();
  }

  onOpen() {
    this.contentEl.empty();
    new Setting(this.contentEl).setName("待人工解决的同步冲突").setHeading();
    this.contentEl.createEl("p", {text:"点击“比较并合并”查看逐行 diff，在同一个编辑框中解决冲突；保存后自动提交并从列表移除。副本仅作为安全备份。若原文件已删除，确认会同步删除网盘文件。未确认前暂停此文件同步，其他文件照常。"});
    const conflicts = this.engine.getPendingConflicts();
    for(const path of this.selected) if(!conflicts.some(c=>c.path===path)) this.selected.delete(path);
    if(conflicts.length) this.selectionBox(new Setting(this.contentEl).setName(`全选（已选 ${this.selected.size} / ${conflicts.length}）`),this.selected.size===conflicts.length,"全选冲突",value=>{
        this.selected.clear();if(value) for(const c of conflicts) this.selected.add(c.path);this.onOpen();
      })
      .addButton(b=>b.setButtonText("接受所选远端版本").setDisabled(this.batchBusy).onClick(()=>this.confirmBatch("remote")))
      .addButton(b=>b.setButtonText("接受所选本地版本").setDisabled(this.batchBusy).onClick(()=>this.confirmBatch("local")));
    if (!conflicts.length) {
      this.contentEl.createEl("p", {text:"暂无待处理冲突，窗口将在 3 秒后关闭。"});
      this.onClose();
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = undefined;
        if (!this.batchBusy && !this.engine.getPendingConflicts().length) this.close();
      }, 3000);
    } else this.onClose();
    for (const record of conflicts) {
      this.selectionBox(new Setting(this.contentEl).setName(record.path),this.selected.has(record.path),`选择冲突：${record.path}`,value=>{if(value)this.selected.add(record.path);else this.selected.delete(record.path);this.onOpen();})
        .setDesc(record.remote.exists ? "双方版本已保留，等待人工确认" : "网盘端已删除，本地版本保留，等待人工确认")
        .addButton(b=>b.setButtonText("比较并合并").onClick(()=>this.openMerge(record.path)))
        .addButton(b => b.setButtonText("打开原文件").onClick(async () => {
          if (await this.app.vault.adapter.exists(record.path)) await this.openInObsidian(record.path);
          else new Notice("原文件已删除；需要保留内容时请先手动恢复原文件。确认解决会采用删除。",10000);
        }))
        .addButton(b=>b.setButtonText("删除原文件").setWarning().onClick(()=>this.confirmTrash(record.path,record.path)));
      for (const copy of record.copies) {
        new Setting(this.contentEl).setName(copy)
          .addButton(b => b.setButtonText("打开远端副本").onClick(async () => {
            if (await this.app.vault.adapter.exists(copy)) await this.openInObsidian(copy);
            else new Notice("该副本不存在，请先点击更新远端副本。",10000);
          }))
          .addButton(b=>b.setButtonText("删除副本").setWarning().onClick(()=>this.confirmTrash(record.path,copy)));
      }
      new Setting(this.contentEl).setName("检查远端最新版本")
        .addButton(b => b.setButtonText("更新远端副本").onClick(async () => {
          b.setDisabled(true);
          try { await this.engine.refreshPendingConflict(record.path); }
          catch (e: any) { new Notice(`更新失败：${e.message || String(e)}`,10000); }
          this.onOpen();
        }));
      new Setting(this.contentEl).setName("人工处理完成后提交")
        .setDesc("以原文件当前内容作为最终结果；原文件不存在则采用删除。副本保留供追溯，不自动同步。")
        .addButton(b => b.setButtonText("确认已解决并提交").setWarning().onClick(async () => {
          b.setDisabled(true);
          try { await this.engine.confirmConflictResolved(record.path); }
          catch (e: any) { new Notice(`未完成处理：${e.message || String(e)}`,15000); }
          this.onOpen();
        }));
    }
  }
}
