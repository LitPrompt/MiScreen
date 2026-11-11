/**
 * 文件管理：通过服务端的 adb 接口浏览、预览、下载、上传、重命名、删除手机里的文件。
 */
interface Entry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PLACES: [string, string][] = [
  ['内部存储', '/sdcard'],
  ['下载', '/sdcard/Download'],
  ['相机', '/sdcard/DCIM/Camera'],
  ['截图', '/sdcard/DCIM/Screenshots'],
  ['图片', '/sdcard/Pictures'],
  ['文档', '/sdcard/Documents'],
  ['音乐', '/sdcard/Music'],
  ['根目录', '/'],
];

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv)$/i;
const AUDIO = /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const TEXT = /\.(txt|log|json|md|xml|csv|ini|conf)$/i;

const ICONS = {
  dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  image: '<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" />',
  video: '<rect x="3" y="5" width="13" height="14" rx="2" /><path d="M16 10l5-3v10l-5-3" />',
  audio: '<path d="M9 18V6l11-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" />',
  apk: '<rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 18.5h4" />',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />',
  download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16" />',
  rename: '<path d="M4 20h4L19 9l-4-4L4 16z" />',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`;

function iconFor(e: Entry) {
  if (e.dir) return ICONS.dir;
  if (IMAGE.test(e.name)) return ICONS.image;
  if (VIDEO.test(e.name)) return ICONS.video;
  if (AUDIO.test(e.name)) return ICONS.audio;
  if (/\.apk$/i.test(e.name)) return ICONS.apk;
  return ICONS.file;
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function formatTime(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p: string) => p.replace(/\/[^/]+$/, '') || '/';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}

/** 用 XHR 上传以获得进度 */
function uploadOne(url: string, file: File, onProgress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let err = '';
      try {
        err = JSON.parse(xhr.responseText).error || '';
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && !err) resolve();
      else reject(new Error(err || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

export class FileManager {
  private dlg = $<HTMLDialogElement>('filesDlg');
  private list = $('filesList');
  private crumbs = $('filesCrumbs');
  private progress = $('filesProgress');
  private preview = $('filesPreview');
  private serial = '';
  private path = '/sdcard';
  private entries: Entry[] = [];
  private loadSeq = 0;
  private uploading = false;

  constructor(private toast: (msg: string, ms?: number) => void) {
    try {
      this.path = localStorage.getItem('miscreen.filesPath') || '/sdcard';
      const sort = localStorage.getItem('miscreen.filesSort');
      if (sort) $<HTMLSelectElement>('filesSort').value = sort;
    } catch {
      /* ignore */
    }
    $('filesPlaces').innerHTML = PLACES.map(([n, p]) => `<button data-path="${p}">${n}</button>`).join('');
    $('filesPlaces').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-path]');
      if (b) this.load(b.dataset.path!);
    });
    this.crumbs.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-path]');
      if (b) this.load(b.dataset.path!);
    });
    $('filesClose').addEventListener('click', () => this.close());
    $('filesUp').addEventListener('click', () => this.path !== '/' && this.load(parentOf(this.path)));
    $('filesRefresh').addEventListener('click', () => this.load(this.path));
    $('filesMkdir').addEventListener('click', () => this.mkdir());
    $('filesSort').addEventListener('change', () => {
      try {
        localStorage.setItem('miscreen.filesSort', $<HTMLSelectElement>('filesSort').value);
      } catch {
        /* ignore */
      }
      this.render();
    });
    $('filesHidden').addEventListener('change', () => this.render());
    $<HTMLInputElement>('filesInput').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files?.length) this.upload([...input.files], this.path);
      input.value = '';
    });
    this.list.addEventListener('click', (e) => this.onListClick(e));
    this.preview.addEventListener('click', (e) => {
      if (e.target === this.preview || (e.target as HTMLElement).closest('.preview-close')) this.closePreview();
    });
    // 点对话框外的遮罩关闭
    this.dlg.addEventListener('click', (e) => e.target === this.dlg && this.close());
    this.dlg.addEventListener('cancel', (e) => {
      if (!this.preview.hidden) {
        e.preventDefault();
        this.closePreview();
      }
    });

    // 拖放上传到当前文件夹
    const drop = $('filesDrop');
    let depth = 0;
    const box = $('files');
    box.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      depth++;
      drop.hidden = false;
    });
    box.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    box.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        drop.hidden = true;
      }
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      drop.hidden = true;
      const fl = [...(e.dataTransfer?.files || [])];
      if (fl.length) this.upload(fl, this.path);
    });
  }

  private base() {
    return `api/devices/${encodeURIComponent(this.serial)}/files`;
  }

  open(serial: string) {
    if (!serial) return this.toast('请先选择设备');
    this.serial = serial;
    if (!this.dlg.open) this.dlg.showModal();
    this.load(this.path);
    api<{ total: number; free: number }>(`${this.base()}/storage`).then(
      (s) => ($('filesStorage').textContent = s.total ? `可用 ${formatSize(s.free)} / ${formatSize(s.total)}` : ''),
      () => {},
    );
  }

  close() {
    this.closePreview();
    this.dlg.close();
  }

  async load(path: string) {
    const seq = ++this.loadSeq;
    this.list.innerHTML = '<div class="files-empty">加载中…</div>';
    this.renderCrumbs(path);
    try {
      const r = await api<{ path: string; entries: Entry[] }>(`${this.base()}/list?path=${encodeURIComponent(path)}`);
      if (seq !== this.loadSeq) return;
      this.path = r.path;
      this.entries = r.entries;
      try {
        localStorage.setItem('miscreen.filesPath', r.path);
      } catch {
        /* ignore */
      }
      this.renderCrumbs(r.path);
      this.render();
      this.list.scrollTop = 0;
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.list.innerHTML = `<div class="files-empty">${(e as Error).message}</div>`;
      // 记住的路径不存在时回到内部存储
      if (path !== '/sdcard' && this.entries.length === 0) this.path = '/sdcard';
    }
  }

  private renderCrumbs(path: string) {
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    const html = ['<button data-path="/">/</button>'];
    for (const p of parts) {
      acc += `/${p}`;
      const label = acc === '/sdcard' ? '内部存储' : escapeHtml(p);
      html.push(`<span>›</span><button data-path="${escapeAttr(acc)}">${label}</button>`);
    }
    this.crumbs.innerHTML = html.join('');
    this.crumbs.scrollLeft = this.crumbs.scrollWidth;
    $<HTMLButtonElement>('filesUp').disabled = path === '/';
    for (const b of $('filesPlaces').querySelectorAll<HTMLButtonElement>('button'))
      b.classList.toggle('active', b.dataset.path === path);
  }

  private render() {
    const showHidden = $<HTMLInputElement>('filesHidden').checked;
    const sort = $<HTMLSelectElement>('filesSort').value;
    const items = this.entries.filter((e) => showHidden || !e.name.startsWith('.'));
    const cmp = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      if (sort === 'mtime') return b.mtime - a.mtime;
      if (sort === 'size') return b.size - a.size || cmp.compare(a.name, b.name);
      return cmp.compare(a.name, b.name);
    });
    const dirs = items.filter((e) => e.dir).length;
    $('filesCount').textContent = `${dirs} 个文件夹 · ${items.length - dirs} 个文件`;
    if (!items.length) {
      this.list.innerHTML = '<div class="files-empty">这个文件夹是空的</div>';
      return;
    }
    this.list.innerHTML = items
      .map((e) => {
        const n = escapeAttr(e.name);
        const meta = e.dir ? formatTime(e.mtime) : `${formatSize(e.size)} · ${formatTime(e.mtime)}`;
        return `<div class="file-row${e.dir ? ' is-dir' : ''}" data-name="${n}" data-dir="${e.dir ? 1 : 0}">
          <span class="file-icon">${svg(iconFor(e))}</span>
          <span class="file-main"><span class="file-name">${escapeHtml(e.name)}</span><span class="file-meta">${meta}</span></span>
          <span class="file-acts">
            <button data-act="download" title="${e.dir ? '打包下载' : '下载'}" aria-label="下载">${svg(ICONS.download)}</button>
            <button data-act="rename" title="重命名" aria-label="重命名">${svg(ICONS.rename)}</button>
            <button data-act="delete" title="删除" aria-label="删除">${svg(ICONS.trash)}</button>
          </span>
        </div>`;
      })
      .join('');
  }

  private onListClick(e: MouseEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row');
    if (!row) return;
    const name = row.dataset.name!;
    const isDir = row.dataset.dir === '1';
    const full = joinPath(this.path, name);
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')?.dataset.act;
    if (act === 'download') return this.download(full, isDir);
    if (act === 'rename') return this.rename(name);
    if (act === 'delete') return this.remove(name, isDir);
    if (isDir) return this.load(full);
    if (IMAGE.test(name) || VIDEO.test(name) || AUDIO.test(name) || TEXT.test(name)) return this.showPreview(name);
    this.download(full, false);
  }

  private url(op: string, path: string, extra = '') {
    return `${this.base()}/${op}?path=${encodeURIComponent(path)}${extra}`;
  }

  private download(full: string, isDir: boolean) {
    const a = document.createElement('a');
    a.href = this.url('download', full);
    a.download = isDir ? `${full.split('/').pop()}.tar` : full.split('/').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.toast(isDir ? '正在打包下载文件夹…' : '开始下载', 2000);
  }

  private showPreview(name: string) {
    const src = this.url('download', joinPath(this.path, name), '&inline=1');
    const n = escapeHtml(name);
    let body: string;
    if (IMAGE.test(name)) body = `<img src="${src}" alt="${n}" />`;
    else if (VIDEO.test(name)) body = `<video src="${src}" controls autoplay playsinline></video>`;
    else if (AUDIO.test(name)) body = `<audio src="${src}" controls autoplay></audio>`;
    else body = '<pre>加载中…</pre>';
    this.preview.innerHTML = `<div class="preview-bar"><span>${n}</span>
      <a class="icon-btn" href="${this.url('download', joinPath(this.path, name))}" download="${escapeAttr(name)}" title="下载">${svg(ICONS.download)}</a>
      <button class="icon-btn preview-close" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
      <div class="preview-body">${body}</div>`;
    this.preview.hidden = false;
    if (TEXT.test(name)) {
      fetch(src)
        .then((r) => r.text())
        .then((t) => {
          const pre = this.preview.querySelector('pre');
          if (pre) pre.textContent = t.length > 500000 ? `${t.slice(0, 500000)}\n…（文件过大，只显示前 500 KB）` : t;
        })
        .catch(() => {});
    }
  }

  private closePreview() {
    // 清空以停止视频/音频播放
    this.preview.innerHTML = '';
    this.preview.hidden = true;
  }

  private async mkdir() {
    const name = prompt('新建文件夹名称');
    if (!name) return;
    if (/[\/]/.test(name)) return this.toast('名称不能包含 /');
    try {
      await api(`${this.base()}/mkdir`, { method: 'POST', body: JSON.stringify({ path: joinPath(this.path, name) }) });
      this.load(this.path);
    } catch (e) {
      this.toast(`新建失败：${(e as Error).message}`);
    }
  }

  private async rename(name: string) {
    const to = prompt('重命名为', name);
    if (!to || to === name) return;
    if (/[\/]/.test(to)) return this.toast('名称不能包含 /');
    try {
      await api(`${this.base()}/rename`, {
        method: 'POST',
        body: JSON.stringify({ from: joinPath(this.path, name), to: joinPath(this.path, to) }),
      });
      this.load(this.path);
    } catch (e) {
      this.toast(`重命名失败：${(e as Error).message}`);
    }
  }

  private async remove(name: string, isDir: boolean) {
    if (!confirm(`确定删除${isDir ? '文件夹' : ''}「${name}」吗？${isDir ? '里面的所有内容都会被删除，' : ''}此操作无法撤销。`)) return;
    try {
      await api(`${this.base()}/delete`, { method: 'POST', body: JSON.stringify({ paths: [joinPath(this.path, name)] }) });
      this.toast('已删除', 2000);
      this.load(this.path);
    } catch (e) {
      this.toast(`删除失败：${(e as Error).message}`);
    }
  }

  /** 上传文件到 dir；serial 未打开对话框时由调用方传入 */
  async upload(fileList: File[], dir: string, serial = this.serial) {
    if (!serial) return this.toast('请先选择设备');
    if (this.uploading) return this.toast('正在上传，请稍候');
    this.uploading = true;
    const total = fileList.reduce((s, f) => s + f.size, 0);
    let done = 0;
    let ok = 0;
    const show = (name: string, loaded: number) => {
      const pct = total ? Math.floor(((done + loaded) / total) * 100) : 100;
      this.progress.hidden = false;
      this.progress.innerHTML = `<span>上传 ${escapeHtml(name)}（${ok + 1}/${fileList.length}）</span><b>${pct}%</b><i style="width:${pct}%"></i>`;
      if (!this.dlg.open) this.toast(`上传到手机 ${pct}%`, 60000);
    };
    try {
      for (const f of fileList) {
        show(f.name, 0);
        const url = `api/devices/${encodeURIComponent(serial)}/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`;
        try {
          await uploadOne(url, f, (l) => show(f.name, l));
          ok++;
        } catch (e) {
          this.toast(`「${f.name}」上传失败：${(e as Error).message}`, 6000);
        }
        done += f.size;
      }
      if (ok) this.toast(`已上传 ${ok} 个文件到 ${dir}`, 4000);
    } finally {
      this.uploading = false;
      this.progress.hidden = true;
      if (this.dlg.open && dir === this.path) this.load(this.path);
    }
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const escapeAttr = escapeHtml;
