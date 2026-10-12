/**
 * Device file manager (「文件管理」) — browse, push and extract.
 *
 * The panel holds a remote directory listing, walks into directories, uploads
 * into the directory currently on screen and downloads files back to the
 * browser. Uploads reuse the raw-body protocol (`POST /api/fs/upload`) with
 * `XMLHttpRequest`, because that is the only way to get an upload progress
 * event; `fetch` still cannot report one.
 *
 * `.apk` files are *installed*, everything else is pushed, and that is now the
 * only behaviour: the old 「APK 也当作普通文件推送」 checkbox is gone, so a
 * dropped APK always means "install this".
 */
export interface FilesContext {
  /** Whatever is in the device address box. */
  serial: () => string;
  log: (message: string) => void;
}

interface RemoteEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  size: number;
  date: string;
  target?: string;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: RemoteEntry[];
}

const DEFAULT_DIR = '/sdcard';
const DIR_KEY = 'ws-scrcpy5.fsdir';
/** A directory with 50k entries would freeze the sidebar; ask the user to narrow. */
const MAX_RENDER = 1000;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Join a remote directory and a child name without doubling separators. */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function isDirectory(entry: RemoteEntry): boolean {
  return entry.kind === 'dir' || entry.kind === 'link';
}

export function setupFiles(ctx: FilesContext): FilesApi {
  const details = el<HTMLDetailsElement>('filesDetails');
  const pathBar = el<HTMLDivElement>('fsPath');
  const list = el<HTMLUListElement>('fsList');
  const upBtn = el<HTMLButtonElement>('fsUp');
  const refreshBtn = el<HTMLButtonElement>('fsRefresh');
  const uploadBtn = el<HTMLButtonElement>('fsUpload');
  const uploadInput = el<HTMLInputElement>('fsUploadInput');
  const progress = el<HTMLDivElement>('fsProgress');
  const bar = el<HTMLDivElement>('fsBar');
  const fill = el<HTMLDivElement>('fsBarFill');
  const progressText = el<HTMLSpanElement>('fsProgressText');
  const overlay = el<HTMLDivElement>('dropOverlay');
  const overlayText = el<HTMLDivElement>('dropOverlayText');

  let currentPath = readSavedDir();
  let parent: string | null = null;
  let busy = false;
  /** Which device the listing belongs to, so an address change reloads it. */
  let loadedSerial = '';

  /* ---------------- progress ---------------- */

  function setProgress(pct: number | undefined, text: string): void {
    progress.classList.remove('hidden');
    progressText.textContent = text;
    if (pct === undefined) {
      bar.classList.add('indeterminate');
      fill.style.width = '30%';
      return;
    }
    bar.classList.remove('indeterminate');
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function hideProgress(): void {
    progress.classList.add('hidden');
    bar.classList.remove('indeterminate');
  }

  /* ---------------- path bar (clickable crumbs) ---------------- */

  function renderPath(): void {
    pathBar.innerHTML = '';
    const root = document.createElement('button');
    root.type = 'button';
    root.textContent = '/';
    root.title = '根目录';
    root.addEventListener('click', () => void load('/'));
    pathBar.appendChild(root);

    let acc = '';
    let first = true;
    for (const segment of currentPath.split('/').filter(Boolean)) {
      acc += `/${segment}`;
      const target = acc;
      const crumb = document.createElement('button');
      crumb.type = 'button';
      crumb.textContent = segment;
      crumb.title = target;
      crumb.addEventListener('click', () => void load(target));
      if (first) {
        // The root crumb already *is* `/`, so no separator before the first
        // segment — otherwise the bar reads `//sdcard`.
        first = false;
        pathBar.appendChild(crumb);
        continue;
      }
      const sep = document.createElement('span');
      sep.className = 'fs-sep';
      sep.textContent = '/';
      pathBar.append(sep, crumb);
    }
    pathBar.scrollLeft = pathBar.scrollWidth;
    upBtn.disabled = parent === null;
  }

  /* ---------------- listing ---------------- */

  function hintRow(text: string): void {
    const li = document.createElement('li');
    li.className = 'fs-empty';
    li.textContent = text;
    list.appendChild(li);
  }

  function render(entries: RemoteEntry[]): void {
    list.innerHTML = '';
    if (entries.length === 0) {
      hintRow('（空目录）');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries.slice(0, MAX_RENDER)) {
      const item = document.createElement('li');
      item.className = `fs-item fs-${isDirectory(entry) ? 'dir' : 'file'}`;

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'fs-name';
      name.textContent = isDirectory(entry) ? `📁 ${entry.name}` : `📄 ${entry.name}`;
      name.title = entry.target ? `${entry.name} → ${entry.target}` : entry.name;

      const meta = document.createElement('span');
      meta.className = 'fs-meta';
      meta.textContent = isDirectory(entry)
        ? entry.date
        : `${formatSize(entry.size)} · ${entry.date}`;

      if (isDirectory(entry)) {
        name.addEventListener('click', () => void load(joinPath(currentPath, entry.name)));
      } else {
        name.title = `${entry.name}（点击提取到本机）`;
        name.addEventListener('click', () => void download(entry));
      }

      item.append(name, meta);
      fragment.appendChild(item);
    }
    list.appendChild(fragment);
    if (entries.length > MAX_RENDER) {
      hintRow(`仅显示前 ${MAX_RENDER} 项，共 ${entries.length} 项，请进入子目录查看`);
    }
  }

  async function load(path: string, options: { keepOnError?: boolean } = {}): Promise<void> {
    const serial = ctx.serial().trim();
    if (!serial) {
      currentPath = path || DEFAULT_DIR;
      parent = null;
      renderPath();
      list.innerHTML = '';
      hintRow('请先在上方填写设备地址，再打开文件管理');
      return;
    }
    const target = path || DEFAULT_DIR;
    list.innerHTML = '';
    hintRow('读取中…');
    try {
      const query = new URLSearchParams({ serial, path: target });
      const res = await fetch(`/api/fs?${query.toString()}`);
      const data = (await res.json()) as Listing & { error?: string };
      if (!res.ok || data.error) {
        if (!options.keepOnError) {
          currentPath = target;
          renderPath();
        }
        list.innerHTML = '';
        hintRow(`无法读取：${data.error ?? `HTTP ${res.status}`}`);
        if (options.keepOnError) ctx.log(`文件管理: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      currentPath = data.path;
      parent = data.parent;
      loadedSerial = serial;
      saveDir(currentPath);
      renderPath();
      render(data.entries ?? []);
    } catch (e) {
      list.innerHTML = '';
      hintRow(`无法读取：${(e as Error).message}`);
    }
  }

  function readSavedDir(): string {
    try {
      return window.localStorage.getItem(DIR_KEY) || DEFAULT_DIR;
    } catch {
      return DEFAULT_DIR;
    }
  }

  function saveDir(dir: string): void {
    try {
      window.localStorage.setItem(DIR_KEY, dir);
    } catch {
      /* private mode — the path just will not be remembered */
    }
  }

  /* ---------------- extract (device -> browser) ---------------- */

  async function download(entry: RemoteEntry): Promise<void> {
    const serial = ctx.serial().trim();
    if (!serial) {
      ctx.log('提取失败：请先在设备地址里填写设备');
      return;
    }
    const path = joinPath(currentPath, entry.name);
    const query = new URLSearchParams({ serial, path });
    ctx.log(`正在提取 ${entry.name}…`);
    try {
      /*
       * Ask the server to stat the file first. `<a download>` cannot surface a
       * 403/404 — the browser would just save the JSON error as a file — so the
       * check runs as a normal request and only a verified file is handed to
       * the download machinery.
       */
      const check = await fetch(`/api/fs/download?${query.toString()}&check=1`);
      const data = (await check.json()) as { size?: number; error?: string };
      if (!check.ok || data.error) {
        ctx.log(`提取 ${entry.name} 失败: ${data.error ?? `HTTP ${check.status}`}`);
        return;
      }
      const link = document.createElement('a');
      link.href = `/api/fs/download?${query.toString()}`;
      link.download = entry.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      ctx.log(`已开始提取 ${entry.name}（${formatSize(data.size ?? entry.size)}）`);
    } catch (e) {
      ctx.log(`提取 ${entry.name} 失败: ${(e as Error).message}`);
    }
  }

  /* ---------------- upload (browser -> device) ---------------- */

  function setBusy(state: boolean): void {
    busy = state;
    uploadBtn.classList.toggle('busy', state);
  }

  function uploadOne(file: File): Promise<boolean> {
    const serial = ctx.serial().trim();
    if (!serial) {
      ctx.log('上传失败：请先在设备地址里填写目标设备');
      return Promise.resolve(false);
    }
    const dir = currentPath || DEFAULT_DIR;
    // An APK is always an install now; anything else is a plain file push.
    const installing = /\.apk$/i.test(file.name);
    const verb = installing ? '正在安装' : '正在上传';
    const query = new URLSearchParams({
      serial,
      name: file.name,
      dir,
      mode: installing ? 'install' : 'file',
    });
    setProgress(0, `上传 ${file.name}…`);

    return new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/fs/upload?${query.toString()}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        setProgress(pct, `上传 ${file.name}… ${pct}%`);
      };
      // Upload done, adb's turn: no percentage left to report.
      xhr.upload.onload = () => setProgress(undefined, `${verb} ${file.name}…`);
      xhr.onload = () => {
        let data: { ok?: boolean; message?: string; error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText) as typeof data;
        } catch {
          data = { error: `服务端返回异常 (HTTP ${xhr.status})` };
        }
        if (xhr.status === 200 && data.ok) {
          ctx.log(`${data.message ?? `已上传 ${file.name}`}（目录 ${dir}）`);
          resolve(true);
          return;
        }
        if (xhr.status === 200 && data.ok === false) {
          ctx.log(data.message ?? `上传 ${file.name} 失败`);
          resolve(false);
          return;
        }
        ctx.log(`上传 ${file.name} 失败: ${data.error ?? `HTTP ${xhr.status}`}`);
        resolve(false);
      };
      xhr.onerror = () => {
        ctx.log(`上传 ${file.name} 失败: 网络错误`);
        resolve(false);
      };
      xhr.send(file);
    });
  }

  async function handleFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (busy) {
      ctx.log('还有文件正在传输，请稍候');
      return;
    }
    details.open = true;
    setBusy(true);
    let ok = 0;
    for (const file of files) {
      if (await uploadOne(file)) ok++;
    }
    setBusy(false);
    hideProgress();
    if (files.length > 1) ctx.log(`共 ${files.length} 个文件，成功 ${ok} 个`);
    // A just-uploaded/installed file should show up in the listing.
    if (ok > 0 && currentPath) await load(currentPath, { keepOnError: true });
  }

  /* ---------------- drag & drop (whole window) ---------------- */

  let dragDepth = 0;
  const hasFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlayText.textContent = ctx.serial().trim()
      ? `松开即上传到 ${currentPath || DEFAULT_DIR}（.apk 直接安装）`
      : '松开前请先填写设备地址';
    overlay.classList.remove('hidden');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    // Without this the browser navigates to the dropped file instead.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add('hidden');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    void handleFiles(Array.from(e.dataTransfer?.files ?? []));
  });

  /* ---------------- buttons ---------------- */

  upBtn.addEventListener('click', () => {
    if (parent !== null) void load(parent);
  });
  refreshBtn.addEventListener('click', () => void load(currentPath));
  uploadBtn.addEventListener('click', () => {
    if (busy) return;
    uploadInput.value = '';
    uploadInput.click();
  });
  uploadInput.addEventListener('change', () => {
    void handleFiles(Array.from(uploadInput.files ?? []));
  });
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    // Never re-read on every expand unless the device changed underneath.
    const serial = ctx.serial().trim();
    if (!serial) void load(currentPath);
    else if (serial !== loadedSerial || list.children.length === 0) void load(currentPath);
  });

  renderPath();
  list.innerHTML = '';
  hintRow('展开后将读取设备目录');

  /**
   * A listing loaded from device A must not keep pretending to be device B's,
   * so `main.ts` calls this whenever the address box changes.
   */
  function onSerialChange(): void {
    const serial = ctx.serial().trim();
    if (serial === loadedSerial) return;
    loadedSerial = '';
    if (details.open) {
      void load(currentPath);
    } else {
      list.innerHTML = '';
      hintRow('设备地址已变更，展开后重新读取');
    }
  }

  return { onSerialChange };
}

export interface FilesApi {
  /** Reload the listing when the device address changed. */
  onSerialChange: () => void;
}
