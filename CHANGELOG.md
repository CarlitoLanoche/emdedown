# Changelog

All notable changes to Emdedown are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-15

First public release.

### Added

#### Reading

- GitHub-style Markdown rendering: tables, task lists, footnotes, definition lists, emoji, `==highlight==`, sub- and superscript,
  callouts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), YAML front matter shown as a details card, `[[wiki links]]`.
- Syntax highlighting for 35+ languages with a copy button, KaTeX math (`$…$`, `$$…$$`) and Mermaid diagrams, all offline.
  Math and diagrams render as they scroll into view, so large documents open quickly.
- Live reload: changes made by other programs appear straight away; unsaved work is never overwritten without asking.
- Click an image to enlarge it; linked `.svg` files open in the same in-app viewer.

#### Editing

- Read / Split / Edit modes (Ctrl+E) with a live preview and synced scrolling that follows the pane you are using.
- Formatting buttons in the toolbar, right-click formatting in the editor and shortcuts (Ctrl+B/I/K, Ctrl+1–3, list and quote shortcuts).
  Heading and list buttons replace an existing marker, and remove it when chosen again.
- Paste or drop an image into the editor: it is saved to an `images` folder next to the document and linked at the spot where it was pasted.
- Insert image, Insert table and Insert table of contents commands.
- Tick task checkboxes in the preview; the file is updated (and saved when it had no other unsaved changes).
- Optional autosave, spellcheck, line numbers and line wrapping. Resizable split (10–90 %) with preset sizes on right-click.

#### Navigation

- Tabs with drag to reorder, a right-click menu (close others, close to the right, close saved, copy path, show in Explorer…),
  reopen closed tab (Ctrl+Shift+T) and a scroll bar when they don't all fit.
- Files sidebar for a folder, document outline with the current section highlighted, reading progress bar.
- Full-text search across a folder (Ctrl+Shift+F), quick file switcher (Ctrl+P), go to heading (Ctrl+R), find in page (Ctrl+F).
- Command palette (Ctrl+Shift+P) grouped into sections, with recently used commands.
- Start page with recent files (remove one entry or clear the list), back navigation between documents (Alt+←).

#### Look

- 6 themes — GitHub, Sepia, Solarized, Nord, Dracula and Paper — each with a light and a dark version.
  Appearance: Light, Dark or Follow Windows; the moon button (Ctrl+Shift+L) switches between the two versions.
- Custom CSS themes from `%LOCALAPPDATA%\Emdedown\themes`.
- Font, text size, page width and line spacing settings; focus mode (F11); dark title bar in dark themes.
- A built-in user guide: "Open the guide" on the start page and in the command list.

#### Export

- Export as PDF, Word (.docx) and self-contained HTML; copy as rich text; print. Printing and PDF use the light version of the theme.
- Present as slides (F5): a slide starts at every `#`/`##` heading and every `---`, and a slide with too much on it continues
  on the next one (long tables and lists are split, tables repeat their header).

#### Safety and data safety

- Scripts in documents never run; raw HTML is sanitized (no forms, styles, embedded pages or controls that imitate the app).
- Links never launch programs: only documents, images and media open in their default app; anything else is shown in Explorer.
- Network paths in documents (`\\server\share`, `//server/…`) are blocked, so opening a document cannot make Windows contact
  another machine. Files you open yourself from a network share still work.
- No telemetry and no network use, except images a document links to on the web.
- Saves keep the file's encoding (UTF-8, UTF-8 with BOM, UTF-16, ANSI) and line endings, and replace the file atomically:
  a failed save leaves the original untouched.
- Save conflicts are detected: if the file changed on disk since it was read, you choose Overwrite, Reload from disk or Cancel.
- Unsaved text is kept as a draft and comes back after a crash; at Windows shutdown or sign-out it is written to disk and
  restored on the next start.
- Text typed while a save is running is never marked as saved by mistake. Closing, quitting, installing and uninstalling ask about
  unsaved changes first.
- Autosave pauses for a file that was deleted or moved instead of recreating it.

#### Install

- One self-contained `Emdedown.exe`; run it portably or install it for the current user without admin rights.
- Start menu entry, optional desktop shortcut, `.md`/`.markdown`/`.mdx` and other Markdown types registered, entry in
  Windows Settings → Apps.
- "Open .md files with Emdedown" sets the default directly when possible, otherwise guides you through Windows Settings.
- Uninstall from Windows Settings or from inside the app removes the program, its registration and its data; documents are never touched.
- A second launch hands its files to the window that is already open.
- Low resource use: GPU rendering off by default (can be turned on in Settings), reduced memory while minimized.

[1.0.0]: ../../releases/tag/v1.0.0
