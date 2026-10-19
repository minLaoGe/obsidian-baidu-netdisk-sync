import { App, Modal, Notice, Setting } from "obsidian";
import { SyncEngine } from "./sync/engine";

export class ConflictReviewModal extends Modal {
  constructor(app: App, private engine: SyncEngine) { super(app); }
  onOpen() {
    this.contentEl.empty();
    new Setting(this.contentEl).setName("待人工解决的同步冲突").setHeading();
    this.contentEl.createEl("p", {text:"原文件是本地版本，副本是当时的网盘版本。请人工比较，把最终内容写入原文件，再确认提交。若原文件已删除，确认会同步删除网盘文件。未确认前暂停此文件同步，其他文件照常。"});
    const conflicts = this.engine.getPendingConflicts();
    if (!conflicts.length) this.contentEl.createEl("p", {text:"暂无待处理冲突。"});
    for (const record of conflicts) {
      new Setting(this.contentEl).setName(record.path)
        .setDesc(record.remote.exists ? "双方版本已保留，等待人工确认" : "网盘端已删除，本地版本保留，等待人工确认")
        .addButton(b => b.setButtonText("打开原文件").onClick(async () => {
          if (await this.app.vault.adapter.exists(record.path)) await this.app.workspace.openLinkText(record.path, "", true);
          else new Notice("原文件已删除；需要保留内容时请先手动恢复原文件。确认解决会采用删除。",10000);
        }));
      for (const copy of record.copies) {
        new Setting(this.contentEl).setName(copy)
          .addButton(b => b.setButtonText("打开远端副本").onClick(async () => {
            if (await this.app.vault.adapter.exists(copy)) await this.app.workspace.openLinkText(copy, "", true);
            else new Notice("该副本不存在，请先点击更新远端副本。",10000);
          }));
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
