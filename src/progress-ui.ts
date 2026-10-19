import { Component, Modal, Platform, setIcon } from 'obsidian';
import type BaiduNetdiskSyncPlugin from './main';

/** Visible mobile feedback independent of Obsidian's desktop-only status bar. */
export class MobileSyncProgress extends Component {
  private card?: HTMLElement;
  private title?: HTMLElement;
  private detail?: HTMLElement;
  private bar?: HTMLProgressElement;
  private modal?: Modal;
  private dismissed = false;
  private wasBusy = false;
  private lastRendered = 0;
  constructor(private plugin: BaiduNetdiskSyncPlugin) { super(); }
  onload() {
    const timer = window.setInterval(() => this.render(), 1000);
    this.register(() => { window.clearInterval(timer); this.modal?.close(); this.card?.remove(); });
  }
  update() {
    const busy = this.plugin.syncEngine?.getProgress().busy;
    if (busy && !this.wasBusy) this.dismissed = false;
    this.wasBusy = !!busy; if (Date.now()-this.lastRendered >= 100) this.render();
  }
  open() {
    this.dismissed = false;
    if (this.modal) { this.render(); return; }
    const modal = new Modal(this.plugin.app); this.modal = modal;
    modal.titleEl.setText('百度同步进度'); modal.modalEl.addClass('baidu-sync-progress-modal');
    modal.onClose = () => { this.modal = undefined; this.render(); };
    modal.open(); this.render();
  }
  private render() {
    const state = this.plugin.syncEngine?.getProgress(); if (!state) return;
    this.lastRendered = Date.now();
    if (!state.startedAt && !this.modal) return;
    const end = state.finishedAt || Date.now();
    const seconds = state.startedAt ? Math.max(0,Math.floor((end-state.startedAt)/1000)) : 0;
    const elapsed = `${Math.floor(seconds/60)}分${seconds%60}秒`;
    const phase = state.total > 0 ? `${state.done}/${state.total} 个（当前阶段）` : state.busy ? '正在检查，请稍候…' : '本轮已结束';
    const counts = `上传 ${state.uploaded} · 下载 ${state.downloaded} · 跳过 ${state.skipped} · 冲突 ${state.conflicted} · 失败 ${state.errors}`;
    if (!this.card && !this.dismissed) {
      this.card = document.body.createDiv({ cls: 'baidu-sync-mobile-progress', attr: { role: 'status', 'aria-live': 'polite' } });
      const header = this.card.createDiv({ cls: 'baidu-sync-progress-header' });
      const open = header.createEl('button', { cls: 'baidu-sync-progress-open', attr: { 'aria-label': '查看百度同步进度详情' } });
      this.title = open.createSpan(); open.onclick = () => this.open();
      const close = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '隐藏进度卡片（同步继续）', title: '隐藏卡片，不停止同步' } }); setIcon(close,'x');
      close.onclick = () => { this.dismissed = true; this.card?.remove(); this.card = undefined; };
      this.bar = this.card.createEl('progress'); this.detail = this.card.createDiv({ cls: 'baidu-sync-progress-detail' });
    }
    if (this.card) {
      this.card.style.display = this.modal ? 'none' : '';
      this.title?.setText(`百度同步 · ${state.status}`);
      if (this.bar) {
        if (state.total > 0) { this.bar.max = state.total; this.bar.value = state.done; }
        else if (state.busy) this.bar.removeAttribute('value'); else { this.bar.max = 1; this.bar.value = 1; }
      }
      this.detail?.setText(`${phase} · ${elapsed}\n${counts}`);
    }
    if (!this.modal) return;
    const content = this.modal.contentEl, scroll = content.scrollTop; content.empty();
    content.createEl('h3',{text:state.status});
    const bar = content.createEl('progress',{cls:'baidu-sync-progress-bar'});
    if (state.total > 0) { bar.max=state.total; bar.value=state.done; } else if (!state.busy) { bar.max=1; bar.value=1; }
    content.createEl('p',{text:`${phase} · 已用 ${elapsed}`});
    content.createEl('p',{text:counts});
    if (state.files.length) {
      content.createEl('h4',{text:'当前文件'});
      for (const file of state.files) content.createDiv({text:file,cls:'baidu-sync-progress-file'});
    }
    if (state.busy) {
      content.createEl('p', {
        text: Platform.isMobile
          ? '⚠️ 提示：同步期间请保持手机在前台亮屏，切勿息屏或切换后台（Android 休眠会切断网络导致 UnknownHostException 错误）。'
          : '💡 提示：正在与百度网盘进行安全双向同步，保持网络畅通即可。可收起弹窗，浮动卡片将继续展示进度。',
        cls: 'setting-item-description'
      });
    } else {
      content.createEl('p', {
        text: Platform.isMobile
          ? '💡 提示：若同步提示网络错误或域名解析失败，请检查手机网络连接、关闭科学上网代理或系统“专用 DNS”后保持亮屏重试。'
          : '💡 提示：本轮同步已结束。若遇网络异常，请检查网络连接或百度网盘授权状态。',
        cls: 'setting-item-description'
      });
    }
    const actions = content.createDiv({cls:'baidu-sync-progress-actions'});
    const hide = actions.createEl('button',{text:state.busy?'收起，继续同步':'关闭'}); hide.onclick=()=>this.modal?.close();
    const conflict = actions.createEl('button',{text:'查看冲突'}); conflict.onclick=()=>{this.modal?.close();this.plugin.openConflictReview();};
    content.createEl('h4',{text:'最近同步记录'});
    const logs=content.createDiv({cls:'baidu-sync-progress-logs'});
    for (const entry of this.plugin.syncEngine.getLogs().slice(0,30)) {
      logs.createDiv({text:`${new Date(entry.timestamp).toLocaleTimeString()} ${entry.message}${entry.detail ? `：${entry.detail}` : ''}`,cls:`baidu-sync-log-${entry.level}`});
    }
    if (!logs.childElementCount) logs.setText('等待同步开始…');
    content.scrollTop=scroll;
  }
}
