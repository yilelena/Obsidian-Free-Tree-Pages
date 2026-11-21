import { Plugin } from "obsidian";
import { SortManager } from "./sort-manager";
import { TreeView, VIEW_TYPE } from "./tree-view";

export default class FreeTreePagesPlugin extends Plugin {
  private sortManager!: SortManager;

  async onload(): Promise<void> {
    console.log("Loading FreeTreePages plugin");

    this.sortManager = new SortManager(this);
    await this.sortManager.load();

    this.registerView(VIEW_TYPE, (leaf) => new TreeView(leaf, this, this.sortManager));

    this.addRibbonIcon("layers", "FreeTreePages", () => this.activateView());

    this.addCommand({
      id: "open-free-tree-pages",
      name: "Open FreeTreePages",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "undo-last-action",
      name: "Undo last FreeTreePages action",
      callback: () => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        const view = leaf?.view;
        if (view instanceof TreeView) void view.performUndo();
      },
    });
  }

  onunload(): void {
    console.log("Unloading FreeTreePages plugin");
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

    if (leaf) workspace.revealLeaf(leaf);
  }
}
