# FreeTreePages

> A **Wolai/Notion-style nested page tree** plugin for Obsidian — every note can hold child pages, order is freely draggable, and everything stays in sync with your real file system.

![version](https://img.shields.io/badge/version-1.1.1-blue)
![obsidian](https://img.shields.io/badge/obsidian-%E2%89%A51.5.0-purple)
![license](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🌳 Nested page tree | Sidebar tree view, expand/collapse all, just like Wolai/Notion |
| ➕ New child page | Right-click → "New child page" auto-converts the note into a folder (Inside-Folder) while keeping its content |
| 🔀 Manual sorting | Drag to reorder any note/folder; order is persisted |
| 📦 Batch operations | Ctrl/Command-click or Shift-click to multi-select, then batch move / batch delete |
| ↩️ Undo | Three ways: toolbar button, command palette, or right-click on empty area in the tree (v1.1.1) |
| 🔄 Two-way sync | All operations sync live to the Obsidian file system and Manual Sorting data |

---

## ⚠️ Required companion plugins

FreeTreePages **does not work standalone**. It relies on two existing community plugins:

| Plugin | Purpose |
|--------|---------|
| **[Folder Notes]** | Provides the Inside-Folder structure so a folder can have its own body note |
| **[Manual Sorting]** | Persists your custom sort order |

Both are open source and available in the Obsidian community plugin store.

---

## 📦 Installation

### Option A — From the Obsidian community store (recommended)

Search for **FreeTreePages** in Settings → Community plugins → Browse, then install and enable it together with **Folder Notes** and **Manual Sorting**.

### Option B — Manual install

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [Release](https://github.com/yilelena/Obsidian-Free-Tree-Pages/releases).
2. Place them in `YourVault/.obsidian/plugins/free-tree-pages/`.
3. Enable **FreeTreePages**, **Folder Notes** and **Manual Sorting** in Settings → Community plugins.

### Configure Folder Notes (important)

In Folder Notes settings:

- ✅ **Folder Notes location** → `Inside-Folder` (the folder note lives inside the folder as `X/X.md`)
- ✅ **Hide folder notes from the file explorer** → enabled (cleaner Wolai/Notion-like UI)
- ⬜ Auto-rename options → keep disabled to avoid conflicts with FreeTreePages rename logic

---

## 🛠️ Build from source

```bash
npm install
npm run build      # produces main.js
npm run dev        # watch mode
```

---

## 📝 Changelog

### 1.1.1
- 🆕 Right-click on empty area in the tree → "Undo last action"

### 1.1.0
- 🆕 Undo available via toolbar / command palette / empty-area right-click

### 1.0.0
- Initial release: nested page tree, drag-to-reorder, batch move & delete, undo stack (20 steps), sync with Folder Notes & Manual Sorting

---

## 📄 License

MIT © yilelena
