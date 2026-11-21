import { Plugin } from "obsidian";
import { SortManager } from "./sort-manager";
import { TreeView, VIEW_TYPE } from "./tree-view";

export default class FreeTreePagesPlugin extends Plugin {
  private sortManager!: SortManager;

  async onload(): Promise<void> {
    this.sortManager = new SortManager(this);
    await this.sortManager.load();

    this.registerView(VIEW_TYPE, (leaf) => new TreeView(leaf, this, this.sortManager));

    this.addRibbonIcon("layers", "FreeTreePages", () => this.activateView());

    this.addCommand({
      id: "open",
      name: "Open page tree",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "undo-last-action",
      name: "Undo last action",
      callback: () => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        const view = leaf?.view;
        if (view instanceof TreeView) void view.performUndo();
      },
    });
  }

  onunload(): void {
    // Nothing to clean up: views and events are unregistered by Obsidian.
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({ type: VIEW_TYPE, active: true });
        leaf = rightLeaf;
      } else {
        const leftLeaf = workspace.getLeftLeaf(false);
        if (leftLeaf) {
          await leftLeaf.setViewState({ type: VIEW_TYPE, active: true });
          leaf = leftLeaf;
        }
      }
    }

    if (leaf) void workspace.revealLeaf(leaf);
  }
}
