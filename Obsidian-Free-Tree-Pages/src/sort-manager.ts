import { Plugin } from "obsidian";

export interface FolderOrderData {
  // key: folder path (empty string for root), value: ordered list of child base names
  [folderPath: string]: string[];
}

export class SortManager {
  private plugin: Plugin;
  private data: FolderOrderData = {};

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  async load(): Promise<void> {
    const loaded = await this.plugin.loadData();
    this.data = loaded?.order ?? {};
  }

  async save(): Promise<void> {
    await this.plugin.saveData({ order: this.data });
  }

  /**
   * Get the ordered list of child base names for a folder.
   * Falls back to null if no custom order exists (caller should use default sort).
   */
  getOrder(folderPath: string): string[] | null {
    return this.data[folderPath] ?? null;
  }

  /**
   * Set the custom order for a folder.
   * @param folderPath - The folder path (empty string for root)
   * @param order - Ordered array of child base names (e.g. ["MyNote", "Subfolder", "AnotherNote"])
   */
  async setOrder(folderPath: string, order: string[]): Promise<void> {
    this.data[folderPath] = order;
    await this.save();
  }

  /**
   * Add an item to the order list for its parent folder.
   * If no custom order exists yet, creates one with the item appended.
   */
  async addToOrder(parentFolderPath: string, baseName: string): Promise<void> {
    let list = this.data[parentFolderPath] ?? [];
    if (!list.includes(baseName)) {
      list.push(baseName);
      this.data[parentFolderPath] = list;
      await this.save();
    }
  }

  /**
   * Remove an item from all order lists (used when file/folder is deleted or renamed).
   */
  async removeFromOrder(parentFolderPath: string, baseName: string): Promise<void> {
    const list = this.data[parentFolderPath];
    if (list) {
      this.data[parentFolderPath] = list.filter((n) => n !== baseName);
      await this.save();
    }
  }

  /**
   * Update a base name after rename.
   */
  async renameInOrder(parentFolderPath: string, oldBaseName: string, newBaseName: string): Promise<void> {
    const list = this.data[parentFolderPath];
    if (list) {
      const idx = list.indexOf(oldBaseName);
      if (idx !== -1) {
        list[idx] = newBaseName;
        await this.save();
      }
    }
  }

  /**
   * Snapshot the whole order data (for undo).
   */
  snapshot(): FolderOrderData {
    const copy: FolderOrderData = {};
    for (const [k, v] of Object.entries(this.data)) copy[k] = [...v];
    return copy;
  }

  /**
   * Restore order data from a snapshot (for undo).
   */
  async restore(snapshot: FolderOrderData): Promise<void> {
    this.data = {};
    for (const [k, v] of Object.entries(snapshot)) this.data[k] = [...v];
    await this.save();
  }

  /**
   * Reset custom order for a specific folder.
   */
  async resetOrder(folderPath: string): Promise<void> {
    delete this.data[folderPath];
    await this.save();
  }

  /**
   * Migrate order keys when a folder is renamed/moved.
   */
  async renameFolderKey(oldPath: string, newPath: string): Promise<void> {
    const next: FolderOrderData = {};
    let changed = false;
    for (const [key, value] of Object.entries(this.data)) {
      let newKey = key;
      if (key === oldPath) newKey = newPath;
      else if (key.startsWith(oldPath + "/")) newKey = newPath + key.slice(oldPath.length);
      next[newKey] = value;
      if (newKey !== key) changed = true;
    }
    if (changed) {
      this.data = next;
      await this.save();
    }
  }
}
