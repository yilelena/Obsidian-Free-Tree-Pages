import { Plugin, WorkspaceLeaf, ItemView, TFile, TFolder, TAbstractFile, Menu, Modal, TextComponent, Notice, App } from "obsidian";
import { SortManager, FolderOrderData } from "./sort-manager";

export const VIEW_TYPE = "free-tree-pages-tree";

// ── 中英文 ──
const I18N = {
  zh: {
    title: "📚 自由树状目录",
    newNote: "➕ 新建笔记",
    newFolder: "📁 新建文件夹",
    expandAll: "▼ 全部展开",
    collapseAll: "▶ 全部折叠",
    noFiles: "还没有文件，点击上方按钮创建。",
    openFile: "打开",
    addChild: "新建子页面",
    rename: "重命名",
    delete: "删除",
    confirmDelete: "确定要删除 \"{name}\" 及其所有内容吗？（不可撤销）",
    alreadyExists: "\"{name}\" 已存在",
    moveFailed: "移动失败",
    renameFailed: "重命名失败",
    deleteFailed: "删除失败",
    createFailed: "创建失败",
    cannotDropDescendant: "不能拖到自己的子节点里",
    promptNoteName: "笔记名称",
    promptFolderName: "文件夹名称",
    promptNewChild: "在 \"{name}\" 下新建子页面",
    promptRename: "重命名为",
    undo: "↶ 撤销",
    undoEmpty: "没有可撤销的操作",
    undone: "已撤销：{label}",
    undoFailed: "撤销失败",
    batchDelete: "删除所选 {n} 项",
    batchMove: "移动所选 {n} 项到…",
    batchDeleteConfirm: "确定要删除所选的 {n} 项及其内容吗？（此操作不可撤销）",
    batchMoveTitle: "选择目标文件夹",
    batchDone: "已处理 {n} 项",
    batchPartial: "成功 {ok} 项，失败 {fail} 项：{msg}",
    move: "移动",
    reorder: "排序",
    pickFolder: "选择目标文件夹",
  },
  en: {
    title: "📚 FreeTreePages",
    newNote: "➕ New Note",
    newFolder: "📁 New Folder",
    expandAll: "▼ Expand All",
    collapseAll: "▶ Collapse All",
    noFiles: "No files yet. Use the buttons above.",
    openFile: "Open",
    addChild: "Add Child",
    rename: "Rename",
    delete: "Delete",
    confirmDelete: "Delete \"{name}\" and all its contents? (cannot be undone)",
    alreadyExists: "\"{name}\" already exists",
    moveFailed: "Move failed",
    renameFailed: "Rename failed",
    deleteFailed: "Delete failed",
    createFailed: "Create failed",
    cannotDropDescendant: "Cannot drop into own descendant.",
    promptNoteName: "Note name",
    promptFolderName: "Folder name",
    promptNewChild: "New child under \"{name}\"",
    promptRename: "Rename to",
    undo: "↶ Undo",
    undoEmpty: "Nothing to undo",
    undone: "Undone: {label}",
    undoFailed: "Undo failed",
    batchDelete: "Delete {n} selected",
    batchMove: "Move {n} selected to…",
    batchDeleteConfirm: "Delete {n} selected items and their contents? (cannot be undone)",
    batchMoveTitle: "Choose destination folder",
    batchDone: "Processed {n} items",
    batchPartial: "{ok} succeeded, {fail} failed: {msg}",
    move: "Move",
    reorder: "Reorder",
    pickFolder: "Choose destination folder",
  },
};
type Lang = keyof typeof I18N;

function fmt(str: string, vars: Record<string, string>): string {
  return str.replace(/{(\w+)}/g, (_, k) => vars[k] ?? `{${k}}`);
}

// 安全拼接路径：过滤空段与首尾斜杠，根目录返回空串
function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

interface TreeNode {
  id: string;
  baseName: string;
  type: "merged" | "folder" | "note";
  notePath?: string;
  folderPath?: string;
  children: TreeNode[];
  collapsed: boolean;
  isRoot: boolean;
}

// 可撤销的底层操作
type UndoOp =
  | { kind: "rename"; from: string; to: string }
  | { kind: "create"; path: string; isFolder: boolean }
  | { kind: "delete"; path: string; content: string };

export class TreeView extends ItemView {
  private plugin: Plugin;
  private sortManager: SortManager;
  private treeContainer: HTMLElement | null = null;
  private rootNode: TreeNode | null = null;
  private fileChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private lang: Lang = "zh";
  private expandedPaths = new Set<string>();

  // HTML5 拖拽状态
  private dragSource: TreeNode | null = null;
  private dropZone: "before" | "after" | "inside" = "before";
  private dropHighlightEl: HTMLElement | null = null;

  // Manual Sorting 插件（kh4f）的外部排序缓存：folderPath -> 子项名称顺序
  private externalOrder: Record<string, string[]> = {};

  // 当前选中行（支持多选）
  private selectedIds = new Set<string>();
  private rangeAnchorId: string | null = null;

  // 撤销记录
  private undoOps: UndoOp[] | null = null;
  private undoStack: { label: string; ops: UndoOp[]; order: FolderOrderData }[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: Plugin, sortManager: SortManager) {
    super(leaf);
    this.plugin = plugin;
    this.sortManager = sortManager;
    const saved = localStorage.getItem("ftp-lang");
    if (saved === "zh" || saved === "en") this.lang = saved;
  }

  t(key: keyof typeof I18N["zh"]): string { return I18N[this.lang][key]; }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.t("title").replace(/^📚 /, ""); }
  getIcon(): string { return "layers"; }

  async onOpen(): Promise<void> {
    this.buildLayout();
    this.setupEventListeners();
    void this.refreshFromManualSorting();
    this.rebuild();
  }

  // ── 与 Manual Sorting 插件双向同步 ──

  /** 手动排序数据文件最近一次修改时间（用于检测原生侧拖拽） */
  private msDataMtime = 0;
  /** 本插件自己写入 Manual Sorting 后，在该时间点前忽略回读，避免自我触发 */
  private suppressExternalUntil = 0;

  private getMsDataPath(): string {
    return `${this.app.vault.configDir}/plugins/manual-sorting/data.json`;
  }

  private async captureMsMtime(): Promise<void> {
    try {
      const st = await this.app.vault.adapter.stat(this.getMsDataPath());
      if (st?.mtime) this.msDataMtime = st.mtime;
    } catch {
      /* 文件不存在时忽略 */
    }
  }

  /** 从 Manual Sorting 读取排序、合并进本地排序数据并重建（原生侧拖拽后同步） */
  private async refreshFromManualSorting(): Promise<void> {
    if (!this.getMsPlugin()) return;
    await this.loadExternalOrder();
    const merged = this.sortManager.snapshot();
    let changed = false;
    for (const [fp, list] of Object.entries(this.externalOrder)) {
      if (!list || !list.length) continue;
      const cur = merged[fp];
      if (!cur || cur.join("\u0001") !== list.join("\u0001")) {
        merged[fp] = list;
        changed = true;
      }
    }
    if (changed) await this.sortManager.restore(merged);
    await this.captureMsMtime();
    this.rebuild();
  }

  /** 轮询 Manual Sorting 数据文件，检测原生侧拖拽排序 */
  private async pollManualSorting(): Promise<void> {
    if (!this.getMsPlugin()) return;
    if (Date.now() < this.suppressExternalUntil) return;
    try {
      const st = await this.app.vault.adapter.stat(this.getMsDataPath());
      if (!st?.mtime || st.mtime === this.msDataMtime) return;
      this.msDataMtime = st.mtime;
      await this.refreshFromManualSorting();
    } catch {
      /* 忽略读取失败 */
    }
  }

  /** 取得 Manual Sorting 插件实例（通过其内存 settings 读写，避免与插件自身写盘冲突） */
  private getMsPlugin(): any {
    return (this.app as any).plugins?.plugins?.["manual-sorting"];
  }

  /** 读取 Manual Sorting 的排序（名称顺序），供渲染使用 */
  private async loadExternalOrder(): Promise<void> {
    const ms = this.getMsPlugin();
    const customOrder = ms?.settings?.customOrder;
    if (!customOrder) { this.externalOrder = {}; return; }
    try {
      const map: Record<string, string[]> = {};
      for (const key of Object.keys(customOrder)) {
        const folderPath = key === "/" ? "" : key;
        const children: string[] = Array.isArray(customOrder[key]?.children) ? customOrder[key].children : [];
        const names: string[] = [];
        const seen = new Set<string>();
        for (const c of children) {
          const n = c.split("/").pop()!.replace(/\.md$/, "");
          if (!seen.has(n)) { seen.add(n); names.push(n); }
        }
        map[folderPath] = names;
      }
      this.externalOrder = map;
    } catch {
      this.externalOrder = {};
    }
  }

  /** 把当前显示的排序写回 Manual Sorting（含原生文件浏览器刷新） */
  private async syncManualOrder(folderPaths: string[]): Promise<void> {
    const ms = this.getMsPlugin();
    const customOrder = ms?.settings?.customOrder;
    if (!customOrder || !folderPaths.length) return;
    try {
      for (const fp of folderPaths) {
        const node = fp === "" ? this.rootNode : this.findFolderNodeByPath(fp);
        if (!node) continue;
        const children: string[] = [];
        for (const c of node.children) {
          if (c.notePath) children.push(c.notePath);
          if (c.folderPath) children.push(c.folderPath);
        }
        customOrder[fp === "" ? "/" : fp] = { children, sortOrder: "custom" };
      }
      if (typeof ms.settings.sortOrder === "string") ms.settings.sortOrder = "custom";
      this.suppressExternalUntil = Date.now() + 3000;
      await ms.saveSettings?.();
      await this.captureMsMtime();
      try { ms.getFileExplorerView?.()?.sort?.(); } catch { /* 视图未挂载时忽略 */ }
    } catch (e) {
      console.warn("[FTP] 同步 Manual Sorting 失败:", e);
    }
  }

  private findFolderNodeByPath(path: string): TreeNode | null {
    const walk = (n: TreeNode | null): TreeNode | null => {
      if (!n) return null;
      if ((n.type === "folder" || n.type === "merged") && n.folderPath === path) return n;
      for (const c of n.children) {
        const f = walk(c);
        if (f) return f;
      }
      return null;
    };
    return walk(this.rootNode);
  }

  // ── 多选与撤销辅助 ──

  /** 当前选中的节点（按树中顺序） */
  private selectedNodes(): TreeNode[] {
    const out: TreeNode[] = [];
    const walk = (n: TreeNode | null) => {
      if (!n) return;
      if (this.selectedIds.has(n.id)) out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(this.rootNode);
    return out;
  }

  /** Shift 范围选择：按当前渲染顺序选中两个节点之间的所有行 */
  private selectRange(fromId: string, toId: string): void {
    if (!this.treeContainer) return;
    const wraps = Array.from(this.treeContainer.querySelectorAll("[data-node-id]")) as HTMLElement[];
    const ids = wraps.map((w) => w.dataset.nodeId!).filter(Boolean);
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    if (a === -1 || b === -1) return;
    const [s, e] = a < b ? [a, b] : [b, a];
    for (let i = s; i <= e; i++) this.selectedIds.add(ids[i]);
  }

  /** 所有文件夹路径（用于整体同步 Manual Sorting） */
  private allFolderPaths(): string[] {
    const out: string[] = [""];
    const walk = (n: TreeNode | null) => {
      if (!n) return;
      if ((n.type === "folder" || n.type === "merged") && !n.isRoot && n.folderPath) out.push(n.folderPath);
      for (const c of n.children) walk(c);
    };
    walk(this.rootNode);
    return out;
  }

  // 记录型文件操作（用于撤销）
  private async vRename(file: TAbstractFile, to: string): Promise<void> {
    const from = file.path;
    await this.app.vault.rename(file, to);
    this.undoOps?.push({ kind: "rename", from, to });
  }

  private async vCreate(path: string, data: string): Promise<void> {
    await this.app.vault.create(path, data);
    this.undoOps?.push({ kind: "create", path, isFolder: false });
  }

  private async vCreateFolder(path: string): Promise<void> {
    await this.app.vault.createFolder(path);
    this.undoOps?.push({ kind: "create", path, isFolder: true });
  }

  /** 删除文件：遵循用户在 Obsidian 设置中选择的删除方式 */
  private async trash(file: TAbstractFile): Promise<void> {
    const fm = (this.app as unknown as { fileManager?: { trashFile?: (f: TAbstractFile) => Promise<void> } }).fileManager;
    if (fm?.trashFile) {
      await fm.trashFile(file);
    } else {
      await this.app.vault.trash(file, true);
    }
  }

  private async vDeleteFile(file: TFile): Promise<void> {
    const path = file.path;
    const content = await this.app.vault.read(file);
    await this.trash(file);
    this.undoOps?.push({ kind: "delete", path, content });
  }

  /** 执行一个可撤销的操作 */
  private async runUndoable(label: string, fn: () => Promise<void>): Promise<void> {
    const ops: UndoOp[] = [];
    const order = this.sortManager.snapshot();
    const prev = this.undoOps;
    this.undoOps = ops;
    try {
      await fn();
    } finally {
      this.undoOps = prev;
    }
    this.undoStack.push({ label, ops, order });
    if (this.undoStack.length > 20) this.undoStack.shift();
  }

  /** 撤销上一步操作 */
  public async performUndo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) { new Notice(this.t("undoEmpty")); return; }
    try {
      for (const op of entry.ops.slice().reverse()) {
        if (op.kind === "rename") {
          const f = this.app.vault.getAbstractFileByPath(op.to);
          if (f) await this.app.vault.rename(f, op.from);
        } else if (op.kind === "create") {
          const f = this.app.vault.getAbstractFileByPath(op.path);
          if (f) {
            if (f instanceof TFolder && f.children.length > 0) continue;
            await this.trash(f);
          }
        } else if (op.kind === "delete") {
          if (!this.app.vault.getAbstractFileByPath(op.path)) {
            await this.app.vault.create(op.path, op.content);
          }
        }
      }
      await this.sortManager.restore(entry.order);
      this.rebuild();
      await this.syncManualOrder(this.allFolderPaths());
      new Notice(fmt(this.t("undone"), { label: entry.label }));
    } catch (err) {
      new Notice(`${this.t("undoFailed")}: ${(err as Error).message}`);
      this.rebuild();
    }
  }

  // ── 布局 ──
  private buildLayout(): void {
    const c = this.containerEl;
    c.empty();
    c.addClass("ftp-container");

    // Header
    const header = document.createElement("div");
    header.addClass("ftp-header");
    const title = document.createElement("div");
    title.textContent = this.t("title");
    title.addClass("ftp-title");
    header.appendChild(title);

    const btnRow = document.createElement("div");
    btnRow.addClass("ftp-btn-row");
    const makeBtn = (txt: string, cb: () => void) => {
      const b = document.createElement("button");
      b.textContent = txt;
      b.addClass("ftp-btn");
      b.addEventListener("click", cb);
      return b;
    };
    btnRow.appendChild(makeBtn(this.t("newNote"), () => this.createRootNote()));
    btnRow.appendChild(makeBtn(this.t("newFolder"), () => this.createRootFolder()));
    btnRow.appendChild(makeBtn(this.t("undo"), () => { void this.performUndo(); }));
    // 单一「展开 / 折叠」切换按钮
    const toggleLabel = this.isAllExpanded() ? this.t("collapseAll") : this.t("expandAll");
    btnRow.appendChild(makeBtn(toggleLabel, () => {
      if (this.isAllExpanded()) this.collapseAll(); else this.expandAll();
      // 重建头部以更新按钮文案，再渲染树
      this.buildLayout();
      this.rebuild();
    }));
    btnRow.appendChild(makeBtn(this.lang === "zh" ? "🌐 EN" : "🌐 中", () => {
      this.lang = this.lang === "zh" ? "en" : "zh";
      localStorage.setItem("ftp-lang", this.lang);
      this.buildLayout();
      this.rebuild();
    }));
    header.appendChild(btnRow);
    c.appendChild(header);

    this.treeContainer = document.createElement("div");
    this.treeContainer.addClass("ftp-tree");
    // 空白区域：右键菜单 + 拖拽到根目录
    this.treeContainer.addEventListener("contextmenu", (e) => this.onBlankContextMenu(e));
    this.treeContainer.addEventListener("dragover", (e) => this.onContainerDragOver(e));
    this.treeContainer.addEventListener("drop", (e) => this.onContainerDrop(e));
    c.appendChild(this.treeContainer);
  }

  private setupEventListeners(): void {
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRebuild()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuild()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRebuild()));

    // 回到窗口时重新读取原生文件浏览器的排序（用户在原生侧拖拽后同步过来）
    this.registerDomEvent(window, "focus", () => {
      void this.refreshFromManualSorting();
    });

    // 轮询 Manual Sorting 数据文件：原生侧拖拽排序不会触发文件事件，只能靠轮询检测
    this.registerInterval(window.setInterval(() => { void this.pollManualSorting(); }, 1200));
  }

  private scheduleRebuild(): void {
    if (this.fileChangeTimer) clearTimeout(this.fileChangeTimer);
    this.fileChangeTimer = setTimeout(() => this.rebuild(), 400);
  }

  // ── 树构建 ──
  private saveExpandState(): void {
    this.expandedPaths.clear();
    const walk = (n: TreeNode | null) => {
      if (!n) return;
      if (!n.collapsed && n.type !== "note") this.expandedPaths.add(n.id);
      for (const c of n.children) walk(c);
    };
    walk(this.rootNode);
  }

  private restoreExpandState(node: TreeNode): void {
    if (this.expandedPaths.has(node.id)) node.collapsed = false;
    else if (node.type !== "note") node.collapsed = true;
    for (const c of node.children) this.restoreExpandState(c);
  }

  private rebuild(): void {
    this.saveExpandState();

    const vault = this.app.vault;
    const buildChildren = (folderPath: string): TreeNode[] => {
      const folder = folderPath === "" ? vault.getRoot() : vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder)) return [];

      const notes = new Map<string, TFile>();
      const folders = new Map<string, TFolder>();
      for (const child of folder.children) {
        if (child instanceof TFolder) folders.set(child.name, child);
        else if (child instanceof TFile && child.extension === "md") notes.set(child.basename, child);
      }

      const nodes: TreeNode[] = [];
      const seen = new Set<string>();
      for (const [name, note] of notes) {
        seen.add(name);
        const f = folders.get(name);
        if (f) {
          nodes.push({ id: note.path, baseName: name, type: "merged", notePath: note.path, folderPath: f.path, children: buildChildren(f.path), collapsed: true, isRoot: false });
        } else {
          nodes.push({ id: note.path, baseName: name, type: "note", notePath: note.path, children: [], collapsed: true, isRoot: false });
        }
      }
      for (const [name, f] of folders) {
        if (!seen.has(name)) {
          const children = buildChildren(f.path);
          // 文件夹内的同名笔记（或兼容旧版 index.md）视为该文件夹自身的页面
          const pagePath = this.findFolderPagePath(f.path, name);
          if (pagePath) {
            nodes.push({
              id: pagePath, baseName: name, type: "merged",
              notePath: pagePath, folderPath: f.path,
              children: children.filter((c) => c.notePath !== pagePath),
              collapsed: true, isRoot: false,
            });
          } else {
            nodes.push({ id: f.path, baseName: name, type: "folder", folderPath: f.path, children, collapsed: true, isRoot: false });
          }
        }
      }

      // Sorting：优先本插件排序，其次 Manual Sorting 插件的排序
      const parentPath = folderPath === "" ? "" : folderPath;
      const customOrder = this.sortManager.getOrder(parentPath) ?? this.externalOrder[parentPath] ?? null;
      if (customOrder && customOrder.length > 0) {
        const orderMap = new Map(customOrder.map((n, i) => [n, i]));
        nodes.sort((a, b) => {
          const ai = orderMap.has(a.baseName) ? orderMap.get(a.baseName)! : 9999;
          const bi = orderMap.has(b.baseName) ? orderMap.get(b.baseName)! : 9999;
          return ai - bi || a.baseName.localeCompare(b.baseName);
        });
      } else {
        nodes.sort((a, b) => {
          const fa = a.type !== "note" ? -1 : 1;
          const fb = b.type !== "note" ? -1 : 1;
          return fa - fb || a.baseName.localeCompare(b.baseName, undefined, { numeric: true });
        });
      }
      return nodes;
    };

    const children = buildChildren("");
    this.rootNode = { id: "root", baseName: "/", type: "folder", children, collapsed: false, isRoot: true };
    this.restoreExpandState(this.rootNode);
    this.render();
  }

  private expandAll(): void {
    const walk = (n: TreeNode | null) => {
      if (!n) return;
      if (n.type !== "note") n.collapsed = false;
      for (const c of n.children) walk(c);
    };
    walk(this.rootNode);
  }

  private collapseAll(): void {
    const walk = (n: TreeNode | null) => {
      if (!n) return;
      if (n.type !== "note") n.collapsed = true;
      for (const c of n.children) walk(c);
    };
    walk(this.rootNode);
  }

  /** 是否所有可展开节点都已展开（用于切换按钮文案与行为） */
  private isAllExpanded(): boolean {
    let all = true;
    const walk = (n: TreeNode | null) => {
      if (!n) return;
      if (n.type !== "note" && n.children.length > 0 && n.collapsed) all = false;
      for (const c of n.children) walk(c);
    };
    walk(this.rootNode);
    return all;
  }

  private findNodeById(id: string, node: TreeNode | null): TreeNode | null {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
      const f = this.findNodeById(id, c);
      if (f) return f;
    }
    return null;
  }

  private findParent(target: TreeNode, node: TreeNode | null, parent: TreeNode | null = null): TreeNode | null {
    if (!node) return null;
    if (node === target) return parent;
    for (const c of node.children) {
      const found = this.findParent(target, c, node);
      if (found) return found;
    }
    return null;
  }

  private getParentFolderPath(node: TreeNode): string {
    const p = this.findParent(node, this.rootNode);
    if (!p || p.isRoot) return "";
    if (p.type === "folder" || p.type === "merged") return p.folderPath!;
    return "";
  }

  private isDescendant(ancestor: TreeNode, node: TreeNode): boolean {
    if (ancestor.children.includes(node)) return true;
    for (const c of ancestor.children) if (this.isDescendant(c, node)) return true;
    return false;
  }

  // ── 渲染 ──
  private render(): void {
    if (!this.treeContainer || !this.rootNode) return;
    const scrollTop = this.treeContainer.scrollTop;
    this.treeContainer.innerHTML = "";

    if (this.rootNode.children.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = this.t("noFiles");
      empty.addClass("ftp-empty");
      this.treeContainer.appendChild(empty);
      return;
    }

    for (const c of this.rootNode.children) this.renderNode(c, this.treeContainer, 0);
    this.treeContainer.scrollTop = scrollTop;
  }

  private renderNode(node: TreeNode, parentEl: HTMLElement, depth: number): void {
    const wrap = document.createElement("div");
    wrap.dataset.nodeId = node.id;

    const row = document.createElement("div");
    row.addClass("ftp-row");

    // Indent
    for (let i = 0; i < depth; i++) {
      const s = document.createElement("div");
      s.addClass("ftp-indent");
      row.appendChild(s);
    }

    // Chevron
    const chevron = document.createElement("div");
    if (node.type !== "note") {
      chevron.textContent = node.collapsed ? "▶" : "▼";
      chevron.addClass("ftp-chevron");
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        this.saveExpandState();
        node.collapsed = !node.collapsed;
        this.render();
      });
    } else {
      chevron.addClass("ftp-chevron-hidden");
    }
    row.appendChild(chevron);

    // Icon
    const icon = document.createElement("div");
    if (node.type === "merged" || node.type === "folder") icon.textContent = node.collapsed ? "📁" : "📂";
    else icon.textContent = "📝";
    icon.addClass("ftp-icon");
    row.appendChild(icon);

    // Title
    const title = document.createElement("div");
    title.textContent = node.baseName;
    title.addClass("ftp-label");
    row.appendChild(title);

    // 选中态（悬停态由 CSS 处理）
    if (this.selectedIds.has(node.id)) row.addClass("ftp-selected");

    // 单击：普通 / Ctrl(⌘) 多选 / Shift 范围选择
    row.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (this.selectedIds.has(node.id)) this.selectedIds.delete(node.id);
        else this.selectedIds.add(node.id);
        this.rangeAnchorId = node.id;
        this.render();
        return;
      }
      if (e.shiftKey && this.rangeAnchorId) {
        this.selectRange(this.rangeAnchorId, node.id);
        this.render();
        return;
      }

      // 普通点击：单选
      this.selectedIds.clear();
      this.selectedIds.add(node.id);
      this.rangeAnchorId = node.id;

      if (node.type === "merged" || node.type === "note") {
        if (node.notePath) {
          const f = this.app.vault.getAbstractFileByPath(node.notePath);
          if (f instanceof TFile) this.app.workspace.getLeaf().openFile(f);
        }
        this.render();
      } else if (node.type === "folder") {
        this.saveExpandState();
        node.collapsed = !node.collapsed;
        this.render();
      }
    });

    // Right-click context menu
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.selectedIds.has(node.id)) {
        this.selectedIds.clear();
        this.selectedIds.add(node.id);
        this.rangeAnchorId = node.id;
        this.render();
      }
      this.showContextMenu(node, e);
    });

    // ── HTML5 拖拽 ──
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      this.dragSource = node;
      // 若拖动的是未选中的行，则改为单选该行
      if (!this.selectedIds.has(node.id)) {
        this.selectedIds.clear();
        this.selectedIds.add(node.id);
        this.rangeAnchorId = node.id;
      }
      row.addClass("ftp-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", node.id);
      }
    });

    row.addEventListener("dragend", () => {
      row.removeClass("ftp-dragging");
      this.clearDropHighlight();
      this.dragSource = null;
    });

    row.addEventListener("dragover", (e) => {
      if (!this.dragSource || this.dragSource === node) return;
      // 不能拖进自己的子孙节点
      if (this.isDescendant(this.dragSource, node)) return;

      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const third = rect.height / 3;

      this.clearDropHighlight();

      if (y < third) {
        this.dropZone = "before";
        row.addClass("ftp-drop-before");
      } else if (y > rect.height - third) {
        this.dropZone = "after";
        row.addClass("ftp-drop-after");
      } else {
        this.dropZone = "inside";
        row.addClass("ftp-drop-inside");
      }
      this.dropHighlightEl = row;
    });

    row.addEventListener("dragleave", (e) => {
      // 只在真正离开该行时清理
      if (row.contains(e.relatedTarget as Node)) return;
      row.removeClass("ftp-drop-before", "ftp-drop-after", "ftp-drop-inside");
    });

    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const source = this.dragSource;
      const zone = this.dropZone;
      row.removeClass("ftp-drop-before", "ftp-drop-after", "ftp-drop-inside");
      this.clearDropHighlight();

      if (!source || source === node) {
        this.dragSource = null;
        return;
      }
      if (this.isDescendant(source, node)) {
        new Notice(this.t("cannotDropDescendant"));
        this.dragSource = null;
        return;
      }

      const self = this;
      const multi = this.selectedIds.size > 1 && this.selectedIds.has(source.id);
      (async () => {
        let affected: string[] = [];
        try {
          await self.runUndoable(zone === "inside" ? self.t("move") : self.t("reorder"), async () => {
            if (multi) {
              affected = await self.moveSelectionTo(node, zone);
            } else if (zone === "inside") {
              affected = await self.moveInside(source, node);
            } else {
              affected = await self.reorderSiblings(source, node, zone);
            }
          });
          if (multi) self.selectedIds.clear();
          self.rebuild();
          await self.syncManualOrder(affected.length ? affected : self.allFolderPaths());
        } catch (err) {
          new Notice(`${self.t("moveFailed")}: ${(err as Error).message}`);
          self.rebuild();
        }
      })();
      this.dragSource = null;
    });

    wrap.appendChild(row);

    // Children if expanded
    if (node.type !== "note" && !node.collapsed) {
      for (const c of node.children) this.renderNode(c, wrap, depth + 1);
    }

    parentEl.appendChild(wrap);
  }

  private clearDropHighlight(): void {
    if (this.dropHighlightEl) {
      this.dropHighlightEl.removeClass(
        "ftp-drop-before",
        "ftp-drop-after",
        "ftp-drop-inside",
        "ftp-drop-container"
      );
      this.dropHighlightEl = null;
    }
  }

  private async moveInside(source: TreeNode, target: TreeNode): Promise<string[]> {
    // 计算目标文件夹路径；若目标是普通笔记则先转成文件夹
    let destFolder: string;
    if (target.isRoot) {
      destFolder = "";
    } else if (target.type === "note") {
      destFolder = await this.convertNoteToFolder(target);
    } else {
      destFolder = target.folderPath!;
    }
    return await this.moveNodeIntoPath(source, destFolder);
  }

  /** 把节点移动（或改名为）到指定文件夹下 */
  private async moveNodeIntoPath(source: TreeNode, destFolder: string): Promise<string[]> {
    const vault = this.app.vault;
    const oldParent = this.getParentFolderPath(source);
    const selfContained = this.isSelfContainedPage(source);
    const noteDest = joinPath(destFolder, `${source.baseName}.md`);
    const folderDest = joinPath(destFolder, source.baseName);

    // 冲突检查：X/X.md 形式只需检查文件夹；其它情况检查笔记与文件夹
    if (source.type === "note") {
      if (vault.getAbstractFileByPath(noteDest)) {
        throw new Error(fmt(this.t("alreadyExists"), { name: source.baseName }));
      }
    } else if (selfContained) {
      if (vault.getAbstractFileByPath(folderDest)) {
        throw new Error(fmt(this.t("alreadyExists"), { name: source.baseName }));
      }
    } else if (vault.getAbstractFileByPath(noteDest) || vault.getAbstractFileByPath(folderDest)) {
      throw new Error(fmt(this.t("alreadyExists"), { name: source.baseName }));
    }

    // X/X.md 形式只移动文件夹（页面文件随文件夹一起走）
    if (source.type !== "folder" && !selfContained) {
      const f = vault.getAbstractFileByPath(source.notePath!);
      if (f) await this.vRename(f, noteDest);
    }
    if (source.type !== "note") {
      const f = vault.getAbstractFileByPath(source.folderPath!);
      if (f) await this.vRename(f as TFolder, folderDest);
    }

    await this.sortManager.removeFromOrder(oldParent, source.baseName);
    await this.sortManager.addToOrder(destFolder, source.baseName);
    return [oldParent, destFolder];
  }

  /** 批量移动当前选中的节点到目标行所在位置 */
  private async moveSelectionTo(target: TreeNode, zone: "before" | "after" | "inside"): Promise<string[]> {
    // 目标文件夹
    let destFolder: string;
    if (zone === "inside") {
      if (target.isRoot) destFolder = "";
      else if (target.type === "note") destFolder = await this.convertNoteToFolder(target);
      else destFolder = target.folderPath!;
    } else {
      const p = this.findParent(target, this.rootNode);
      destFolder = !p || p.isRoot ? "" : p.folderPath!;
    }

    const nodes = this.selectedNodes();
    // 过滤掉"祖先也被选中"的节点，避免重复移动
    const filtered = nodes.filter((n) => !nodes.some((o) => o !== n && this.isDescendant(o, n)));

    const affected = new Set<string>();
    const errors: string[] = [];
    let ok = 0;
    for (const n of filtered) {
      if (n.isRoot) continue;
      if (n.id === target.id) continue;
      if (zone === "inside" && this.isDescendant(n, target)) continue;
      try {
        const res = await this.moveNodeIntoPath(n, destFolder);
        res.forEach((p) => affected.add(p));
        ok++;
      } catch (err) {
        errors.push(`${n.baseName}: ${(err as Error).message}`);
      }
    }

    if (errors.length) {
      new Notice(fmt(this.t("batchPartial"), { ok: String(ok), fail: String(errors.length), msg: errors.slice(0, 3).join("；") }));
    } else if (ok > 0) {
      new Notice(fmt(this.t("batchDone"), { n: String(ok) }));
    }
    return Array.from(affected);
  }

  private async reorderSiblings(source: TreeNode, target: TreeNode, position: "before" | "after"): Promise<string[]> {
    const sourceParent = this.findParent(source, this.rootNode);
    const targetParent = this.findParent(target, this.rootNode);
    if (!sourceParent || !targetParent) return [];

    if (sourceParent !== targetParent) {
      // 先移动到目标父级，再在目标父级内排序
      const affected = await this.moveInside(source, targetParent);
      this.rebuild();
      const freshParent = targetParent.isRoot ? this.rootNode :
        this.findNodeById(targetParent.id, this.rootNode);
      if (!freshParent) return affected;
      const freshSource = freshParent.children.find((c) => c.baseName === source.baseName);
      const freshTarget = freshParent.children.find((c) => c.baseName === target.baseName);
      if (freshSource && freshTarget) {
        const more = await this.reorderWithinParent(freshParent, freshSource, freshTarget, position);
        return Array.from(new Set([...affected, ...more]));
      }
      return affected;
    } else {
      return await this.reorderWithinParent(sourceParent, source, target, position);
    }
  }

  private async reorderWithinParent(parent: TreeNode, source: TreeNode, target: TreeNode, position: "before" | "after"): Promise<string[]> {
    const parentPath = parent.isRoot ? "" : parent.folderPath!;

    // 以当前显示顺序为基准（已包含来自 Manual Sorting 的外部排序）
    const order = parent.children.map((c) => c.baseName);

    const srcIdx = order.indexOf(source.baseName);
    if (srcIdx !== -1) order.splice(srcIdx, 1);
    else order.push(source.baseName);

    let tgtIdx = order.indexOf(target.baseName);
    if (tgtIdx === -1) tgtIdx = order.length;
    order.splice(position === "before" ? tgtIdx : tgtIdx + 1, 0, source.baseName);

    await this.sortManager.setOrder(parentPath, order);
    return [parentPath];
  }

  // ── 空白区域操作 ──
  private onBlankContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest("[data-node-id]")) return;
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(this.t("newNote"))
      .setIcon("file-plus")
      .onClick(() => { void this.createRootNote(); }));
    menu.addItem((item) => item
      .setTitle(this.t("newFolder"))
      .setIcon("folder-plus")
      .onClick(() => { void this.createRootFolder(); }));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(this.t("undo"))
      .setIcon("undo-2")
      .onClick(() => { void this.performUndo(); }));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(this.t("expandAll"))
      .setIcon("chevrons-down-up")
      .onClick(() => { this.expandAll(); this.render(); }));
    menu.addItem((item) => item
      .setTitle(this.t("collapseAll"))
      .setIcon("chevrons-up-down")
      .onClick(() => { this.collapseAll(); this.render(); }));
    menu.showAtMouseEvent(e);
  }

  private onContainerDragOver(e: DragEvent): void {
    if (!this.dragSource) return;
    if ((e.target as HTMLElement).closest("[data-node-id]")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    this.clearDropHighlight();
    const tc = this.treeContainer!;
    tc.addClass("ftp-drop-container");
    this.dropHighlightEl = tc;
  }

  private onContainerDrop(e: DragEvent): void {
    const source = this.dragSource;
    if (!source) return;
    if ((e.target as HTMLElement).closest("[data-node-id]")) return;
    e.preventDefault();
    this.clearDropHighlight();
    this.dragSource = null;

    const rows = this.treeContainer!.querySelectorAll("[data-node-id] > div");
    const firstRow = rows.length ? (rows[0] as HTMLElement) : null;
    const atStart = !!firstRow && e.clientY < firstRow.getBoundingClientRect().top;
    void this.moveToRoot(source, atStart);
  }

  /** 把节点移动到根目录最前 / 最后 */
  private async moveToRoot(source: TreeNode, atStart: boolean): Promise<void> {
    try {
      if (!this.rootNode) return;
      const parent = this.findParent(source, this.rootNode);
      const affected: string[] = [];
      await this.runUndoable(this.t("move"), async () => {
        if (parent && !parent.isRoot) {
          affected.push(...await this.moveInside(source, this.rootNode));
        }
      });
      this.rebuild();
      const order = this.rootNode!.children.map((c) => c.baseName);
      const rest = order.filter((n) => n !== source.baseName);
      if (atStart) rest.unshift(source.baseName);
      else rest.push(source.baseName);
      await this.sortManager.setOrder("", rest);
      this.rebuild();
      await this.syncManualOrder(Array.from(new Set(["", ...affected])));
    } catch (err) {
      new Notice(`${this.t("moveFailed")}: ${(err as Error).message}`);
      this.rebuild();
    }
  }

  // ── 右键菜单 ──
  private showContextMenu(node: TreeNode, e: MouseEvent): void {
    const menu = new Menu();
    const multi = this.selectedIds.size > 1 && this.selectedIds.has(node.id);

    // 多选：批量操作
    if (multi) {
      const n = this.selectedIds.size;
      menu.addItem((item) => item
        .setTitle(fmt(this.t("batchMove"), { n: String(n) }))
        .setIcon("folder-input")
        .onClick(() => { void this.batchMoveSelected(); }));
      menu.addItem((item) => item
        .setTitle(fmt(this.t("batchDelete"), { n: String(n) }))
        .setIcon("trash")
        .onClick(() => { void this.batchDeleteSelected(); }));
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle(this.t("undo"))
        .setIcon("undo-2")
        .onClick(() => { void this.performUndo(); }));
      menu.showAtMouseEvent(e);
      return;
    }

    if (node.type !== "folder") {
      menu.addItem((item) => item
        .setTitle(this.t("openFile"))
        .setIcon("file-text")
        .onClick(() => {
          if (node.notePath) {
            const f = this.app.vault.getAbstractFileByPath(node.notePath);
            if (f instanceof TFile) this.app.workspace.getLeaf().openFile(f);
          }
        }));
    }

    menu.addItem((item) => item
      .setTitle(this.t("addChild"))
      .setIcon("plus")
      .onClick(() => { this.addChildToNode(node); }));

    menu.addItem((item) => item
      .setTitle(this.t("rename"))
      .setIcon("edit")
      .onClick(() => { this.renameNode(node); }));

    menu.addItem((item) => item
      .setTitle(this.t("delete"))
      .setIcon("trash")
      .onClick(() => { this.deleteNode(node); }));

    menu.showAtMouseEvent(e);
  }

  // ── 批量操作 ──
  private async batchDeleteSelected(): Promise<void> {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const confirmed = confirm(fmt(this.t("batchDeleteConfirm"), { n: String(nodes.length) }));
    if (!confirmed) return;

    const vault = this.app.vault;
    let ok = 0;
    const errors: string[] = [];
    for (const n of nodes) {
      try {
        if (n.type !== "folder" && n.notePath) {
          const f = vault.getAbstractFileByPath(n.notePath);
          if (f) await this.trash(f);
        }
        if (n.type !== "note" && n.folderPath) {
          const f = vault.getAbstractFileByPath(n.folderPath);
          if (f) await this.trash(f);
        }
        await this.sortManager.removeFromOrder(this.getParentFolderPath(n), n.baseName);
        ok++;
      } catch (err) {
        errors.push(`${n.baseName}: ${(err as Error).message}`);
      }
    }
    this.selectedIds.clear();
    this.rebuild();
    await this.syncManualOrder(this.allFolderPaths());
    if (errors.length) {
      new Notice(fmt(this.t("batchPartial"), { ok: String(ok), fail: String(errors.length), msg: errors.slice(0, 3).join("；") }));
    } else {
      new Notice(fmt(this.t("batchDone"), { n: String(ok) }));
    }
  }

  private async batchMoveSelected(): Promise<void> {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;

    const picker = new FolderPickerModal(
      this.app,
      this.t("batchMoveTitle"),
      this.allFolderPaths(),
      (destPath) => { void this.doBatchMove(nodes, destPath); }
    );
    picker.open();
  }

  private async doBatchMove(nodes: TreeNode[], destPath: string): Promise<void> {
    // 过滤掉"祖先也被选中"的节点，避免重复移动
    const filtered = nodes.filter((n) => !nodes.some((o) => o !== n && this.isDescendant(o, n)));
    let ok = 0;
    const errors: string[] = [];
    try {
      await this.runUndoable(this.t("move"), async () => {
        for (const n of filtered) {
          try {
            await this.moveNodeIntoPath(n, destPath);
            ok++;
          } catch (err) {
            errors.push(`${n.baseName}: ${(err as Error).message}`);
          }
        }
      });
    } catch (err) {
      new Notice(`${this.t("moveFailed")}: ${(err as Error).message}`);
    }
    this.selectedIds.clear();
    this.rebuild();
    await this.syncManualOrder(this.allFolderPaths());
    if (errors.length) {
      new Notice(fmt(this.t("batchPartial"), { ok: String(ok), fail: String(errors.length), msg: errors.slice(0, 3).join("；") }));
    } else {
      new Notice(fmt(this.t("batchDone"), { n: String(ok) }));
    }
  }

  // ── 节点操作 ──
  private inputPrompt(title: string, value = ""): Promise<string | null> {
    return new Promise((resolve) => {
      new InputModal(this.app, title, value, resolve).open();
    });
  }

  /** 节点页面文件是否就位于其自身文件夹内（即 X/X.md 或 X/index.md 形式） */
  private isSelfContainedPage(node: TreeNode): boolean {
    return !!(node.notePath && node.folderPath && node.notePath.startsWith(node.folderPath + "/"));
  }

  /** 查找文件夹自身的页面文件：优先 X/X.md，兼容旧的 X/index.md */
  private findFolderPagePath(folderPath: string, folderName: string): string | null {
    const candidates = [joinPath(folderPath, `${folderName}.md`), joinPath(folderPath, "index.md")];
    for (const p of candidates) {
      if (this.app.vault.getAbstractFileByPath(p) instanceof TFile) return p;
    }
    return null;
  }

  /** 把笔记转为同名文件夹：内容移入 X/X.md，删除原笔记，返回文件夹路径 */
  private async convertNoteToFolder(node: TreeNode): Promise<string> {
    const vault = this.app.vault;
    const note = vault.getAbstractFileByPath(node.notePath!);
    if (!(note instanceof TFile)) throw new Error(`找不到笔记：${node.notePath}`);

    const parentDir = note.parent?.path ?? "";
    const folderPath = joinPath(parentDir, node.baseName);
    const existing = vault.getAbstractFileByPath(folderPath);
    if (existing && !(existing instanceof TFolder)) {
      throw new Error(fmt(this.t("alreadyExists"), { name: node.baseName }));
    }
    if (!existing) await this.vCreateFolder(folderPath);

    const pagePath = joinPath(folderPath, `${node.baseName}.md`);
    if (vault.getAbstractFileByPath(pagePath) instanceof TFile) {
      throw new Error(fmt(this.t("alreadyExists"), { name: `${node.baseName}.md` }));
    }

    const content = await vault.read(note);
    await this.vCreate(pagePath, content);
    await this.vDeleteFile(note);
    return folderPath;
  }

  private async createRootNote(): Promise<void> {
    try {
      const input = await this.inputPrompt(this.t("promptNoteName"));
      const name = input?.trim();
      if (!name) return;
      const path = `${name}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) { new Notice(fmt(this.t("alreadyExists"), { name })); return; }
      await this.runUndoable(this.t("newNote").replace(/^➕ /, ""), async () => {
        await this.vCreate(path, "");
      });
      await this.sortManager.addToOrder("", name);
      this.rebuild();
      await this.syncManualOrder([""]);
    } catch (err) {
      new Notice(`${this.t("createFailed")}: ${(err as Error).message}`);
    }
  }

  private async createRootFolder(): Promise<void> {
    try {
      const input = await this.inputPrompt(this.t("promptFolderName"));
      const name = input?.trim();
      if (!name) return;
      if (this.app.vault.getAbstractFileByPath(name)) { new Notice(fmt(this.t("alreadyExists"), { name })); return; }
      await this.runUndoable(this.t("newFolder").replace(/^📁 /, ""), async () => {
        await this.vCreateFolder(name);
      });
      await this.sortManager.addToOrder("", name);
      this.rebuild();
      await this.syncManualOrder([""]);
    } catch (err) {
      new Notice(`${this.t("createFailed")}: ${(err as Error).message}`);
    }
  }

  private async addChildToNode(node: TreeNode): Promise<void> {
    try {
      const input = await this.inputPrompt(fmt(this.t("promptNewChild"), { name: node.baseName }));
      const name = input?.trim();
      if (!name) return;

      // 预先计算父文件夹路径（note 会被转成同名文件夹）
      const vault = this.app.vault;
      let parentFolderPath: string;
      if (node.type === "note") {
        const note = vault.getAbstractFileByPath(node.notePath!);
        const parentDir = note instanceof TFile ? (note.parent?.path ?? "") : "";
        parentFolderPath = joinPath(parentDir, node.baseName);
      } else {
        parentFolderPath = node.folderPath!;
      }

      const targetPath = joinPath(parentFolderPath, `${name}.md`);
      if (vault.getAbstractFileByPath(targetPath)) { new Notice(fmt(this.t("alreadyExists"), { name })); return; }

      await this.runUndoable(this.t("addChild"), async () => {
        if (node.type === "note") {
          await this.convertNoteToFolder(node);
        }
        await this.vCreate(targetPath, "");
      });
      await this.sortManager.addToOrder(parentFolderPath, name);
      this.rebuild();

      // 自动展开父节点，方便看到新建的子页面
      const fresh = this.findFolderNodeByPath(parentFolderPath);
      if (fresh) {
        this.expandedPaths.add(fresh.id);
        fresh.collapsed = false;
        this.render();
      }
      await this.syncManualOrder([parentFolderPath]);
    } catch (err) {
      new Notice(`${this.t("createFailed")}: ${(err as Error).message}`);
    }
  }

  private async renameNode(node: TreeNode): Promise<void> {
    try {
      const input = await this.inputPrompt(this.t("promptRename"), node.baseName);
      const newName = input?.trim();
      if (!newName || newName === node.baseName) return;

      const vault = this.app.vault;
      const parentPath = this.getParentFolderPath(node);
      const newNotePath = joinPath(parentPath, `${newName}.md`);
      const newFolderPath = joinPath(parentPath, newName);

      await this.runUndoable(this.t("rename"), async () => {
        // X/X.md 形式只重命名文件夹（页面文件随文件夹走）
        if (node.type !== "folder" && !this.isSelfContainedPage(node)) {
          const f = vault.getAbstractFileByPath(node.notePath!);
          if (f) await this.vRename(f, newNotePath);
        }
        if (node.type !== "note") {
          const f = vault.getAbstractFileByPath(node.folderPath!);
          if (f) {
            await this.vRename(f, newFolderPath);
            await this.sortManager.renameFolderKey(node.folderPath!, newFolderPath);

            // 页面文件若为「同名笔记」形式，跟随文件夹改名（index.md 保持不变）
            if (this.isSelfContainedPage(node)) {
              const rel = node.notePath!.slice(node.folderPath!.length + 1);
              if (rel === `${node.baseName}.md`) {
                const pageFile = vault.getAbstractFileByPath(joinPath(newFolderPath, rel));
                if (pageFile instanceof TFile) {
                  await this.vRename(pageFile, joinPath(newFolderPath, `${newName}.md`));
                }
              }
            }
          }
        }
      });
      await this.sortManager.renameInOrder(parentPath, node.baseName, newName);

      // 迁移展开状态（节点路径已变化）
      const prefixMap: [string, string][] = [];
      if (node.notePath) {
        let renamedNotePath = newNotePath;
        if (this.isSelfContainedPage(node)) {
          const rel = node.notePath.slice(node.folderPath!.length + 1);
          const newRel = rel === `${node.baseName}.md` ? `${newName}.md` : rel;
          renamedNotePath = joinPath(newFolderPath, newRel);
        }
        prefixMap.push([node.notePath, renamedNotePath]);
      }
      if (node.folderPath) prefixMap.push([node.folderPath, newFolderPath]);
      const nextExpanded = new Set<string>();
      this.expandedPaths.forEach((p) => {
        let np = p;
        for (const [oldP, newP] of prefixMap) {
          if (p === oldP || p.startsWith(oldP + "/")) {
            np = newP + p.slice(oldP.length);
            break;
          }
        }
        nextExpanded.add(np);
      });
      this.expandedPaths = nextExpanded;

      this.rebuild();
      await this.syncManualOrder([parentPath]);
    } catch (err) {
      new Notice(`${this.t("renameFailed")}: ${(err as Error).message}`);
    }
  }

  private async deleteNode(node: TreeNode): Promise<void> {
    try {
      const confirmed = confirm(fmt(this.t("confirmDelete"), { name: node.baseName }));
      if (!confirmed) return;

      const vault = this.app.vault;
      if (node.type !== "folder") {
        const f = vault.getAbstractFileByPath(node.notePath!);
        if (f) await this.trash(f);
      }
      if (node.type !== "note") {
        const f = vault.getAbstractFileByPath(node.folderPath!);
        if (f) await this.trash(f);
      }
      const parentPath = this.getParentFolderPath(node);
      await this.sortManager.removeFromOrder(parentPath, node.baseName);
      this.rebuild();
      await this.syncManualOrder([parentPath]);
    } catch (err) {
      new Notice(`${this.t("deleteFailed")}: ${(err as Error).message}`);
    }
  }
}

// ── 输入弹窗（替代 Electron 不支持的 prompt()） ──
class InputModal extends Modal {
  private title: string;
  private value: string;
  private resolve: (v: string | null) => void;
  private done = false;

  constructor(app: App, title: string, value: string, resolve: (v: string | null) => void) {
    super(app);
    this.title = title;
    this.value = value;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title, attr: { style: "margin-top:0;" } });

    const input = new TextComponent(contentEl);
    input.setValue(this.value);
    input.inputEl.addClass("ftp-modal-input");
    input.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.finish(input.getValue());
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.finish(null);
      }
    });

    const btnRow = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;" } });
    const cancelBtn = btnRow.createEl("button", { text: "取消 / Cancel" });
    cancelBtn.addEventListener("click", () => this.finish(null));
    const okBtn = btnRow.createEl("button", { text: "确定 / OK", cls: "mod-cta" });
    okBtn.addEventListener("click", () => this.finish(input.getValue()));

    window.setTimeout(() => {
      input.inputEl.focus();
      input.inputEl.select();
    }, 10);
  }

  private finish(v: string | null): void {
    if (this.done) return;
    this.done = true;
    this.resolve(v);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.resolve(null);
    }
  }
}

/** 目标文件夹选择弹窗（批量移动用） */
class FolderPickerModal extends Modal {
  private paths: string[];
  private onPick: (path: string) => void;
  private filter = "";

  constructor(app: App, private title: string, paths: string[], onPick: (path: string) => void) {
    super(app);
    this.paths = paths;
    this.onPick = onPick;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });

    const input = new TextComponent(contentEl);
    input.setPlaceholder("🔍");
    input.inputEl.addClass("ftp-picker-input");
    input.onChange((v) => {
      this.filter = v.trim().toLowerCase();
      this.renderList(listEl);
    });

    const listEl = contentEl.createDiv();
    listEl.addClass("ftp-picker-list");
    this.renderList(listEl);
    input.inputEl.focus();
  }

  private renderList(listEl: HTMLElement): void {
    listEl.empty();
    const items = this.paths.filter((p) => {
      const label = p === "" ? "/" : p;
      return !this.filter || label.toLowerCase().includes(this.filter);
    });
    if (!items.length) {
      const empty = listEl.createDiv();
      empty.textContent = this.filter ? "(无匹配)" : "(无)";
      empty.addClass("ftp-picker-empty");
      return;
    }
    for (const p of items) {
      const item = listEl.createDiv();
      item.textContent = p === "" ? "📁 /（根目录）" : `📁 ${p}`;
      item.addClass("ftp-picker-item");
      item.addEventListener("click", () => {
        this.close();
        this.onPick(p);
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
