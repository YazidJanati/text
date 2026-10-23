# text

A small, dark Markdown desktop editor. Compact terminal typography (SF Mono where available, with Menlo/Consolas fallbacks), a file tree, Vim, and math. The editor uses 13 px text with no extra character spacing. No welcome page, dashboards, plugins, or settings screens.

The implementation is original. It does not use Typora code or proprietary assets.

## Run

Install [Node.js 22 LTS or newer](https://nodejs.org/), current stable [Rust](https://rustup.rs/), and the [Tauri prerequisites for your OS](https://v2.tauri.app/start/prerequisites/). On macOS, install the Xcode Command Line Tools with `xcode-select --install`. Windows needs the C++ Build Tools and WebView2; Linux needs the WebKitGTK development packages listed in the Tauri guide.

From this folder:

```sh
npm ci
npm run desktop
```

The first native build downloads Rust dependencies and takes longer. Subsequent starts reuse them.

## Build

```sh
npm run bundle
```

Build on the target operating system. Output is in `src-tauri/target/release/bundle/`. The source supports macOS, Windows, and Linux; this delivery was built and exercised on Apple Silicon macOS. The included CI workflow checks all three platforms when enabled in a repository.

For just a macOS application bundle:

```sh
npm run tauri -- build --bundles app
```

The provided Mac app is a local, ad-hoc signed build, not a notarized release. No global installation is required; open `text.app` or move it to Applications.

## Use

text opens to a blank note in its own library. It saves after 500 ms of inactivity, on focus loss, and before switching notes or quitting. Unprotected files remain ordinary UTF-8 `.md` files. Password-protected notes use encrypted `.textlock` files. The app does not require you to choose a storage folder or handle Save dialogs.

Create notes and folders with the two sidebar controls or shortcuts. New items go into the selected folder; click empty sidebar space to select the library root. Click a folder to expand it. Rename a focused sidebar item with Enter or F2. Arrow keys navigate the file tree; Left/Right collapse and expand folders, Delete moves an item to trash, and Escape returns to the editor. You can also rename through the document title, a double click, or the context menu. The context menu also moves a note or folder to the app's local trash, preserving its contents.

Vim is **on by default**. The header button explicitly shows `vim:on` or `vim:off`; click it to switch. The adjacent `[normal]` / `[insert]` / `[visual]` text only reports the editing mode. Press `i` to write, `Esc` for normal mode, `v` for visual mode, and `/` to search. Motions, operators, counts, registers, macros, and undo are supplied by the CodeMirror Vim adapter. It is an embedded Vim editing layer, not the Neovim runtime: there are no Vim plugins, shell commands, splits, or `.vimrc` loading.

Supported app commands:

```vim
:w              " save now
:q              " save and quit
:wq             " save and quit
:new            " new note
:new Physics    " new named note
:mkdir Research " new folder; select it for subsequent notes
```

The app autosaves, so `:q` also flushes pending edits. An external-change conflict blocks saving and quitting until you cancel, explicitly discard, or export a copy. The original disk version is preserved.

| Action                              | macOS     | Windows / Linux |
| ----------------------------------- | --------- | --------------- |
| Toggle sidebar                      | ⌘B        | Ctrl+B          |
| Toggle Vim                          | ⌘Option+V | Ctrl+Alt+V      |
| New note                            | ⌘N        | Ctrl+N          |
| New folder                          | ⌘Shift+N  | Ctrl+Shift+N    |
| Rename current note                 | F2        | F2              |
| Save now                            | ⌘S        | Ctrl+S          |
| Import a Markdown file              | ⌘O        | Ctrl+O          |
| Export a Markdown copy              | ⌘Shift+S  | Ctrl+Shift+S    |
| Find in regular editing mode        | ⌘F        | Ctrl+F          |
| Bold in regular editing mode        | ⌘Shift+B  | Ctrl+Shift+B    |
| Italic in regular editing mode      | ⌘I        | Ctrl+I          |
| Insert link in regular editing mode | ⌘K        | Ctrl+K          |

The sidebar shortcut has priority over Vim's Ctrl+B page motion. Sidebar visibility, Vim preference, and the last note are remembered. Notes inside collapsed folders open with their ancestors expanded.

Markdown markers are visible on the line containing the cursor and are rendered inline elsewhere. Headings, emphasis, lists, tasks, blockquotes, rules, code, and links are supported. Clicking a rendered equation reveals its source. Use `$E=mc^2$` for inline math and `$$` on separate lines for display math:

```markdown
$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
```

Math uses bundled KaTeX and fonts, works offline, and supports the [KaTeX syntax](https://katex.org/docs/supported). Tables, image references, and raw HTML remain editable Markdown source. Raw HTML is never executed, and remote images are not loaded. This is a focused editor, not a full Typora compatibility implementation.

## Passwords and closing notes

Password protection is optional and available in the desktop app. Right-click a note and choose **Set password**, then enter and confirm the password. New notes have no password. After unlocking a protected note, its context menu offers **Remove password**.

**Ctrl+W** saves and closes the current note, leaving a blank editor and the file tree. **⌘W** and File → Close Note do the same on macOS. No tabs are created. Click the note in the sidebar to reopen it; protected notes always ask for their password after closing, switching notes, or restarting the application. An explicitly closed note stays closed at startup. The app does not remember passwords. The app's Quit command and `:q` / `:wq` still exit the application.

Protected note contents are encrypted using [XChaCha20-Poly1305](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/) authenticated encryption, with a key derived using [Argon2id](https://docs.rs/argon2/0.5.3/argon2/) (64 MiB, three passes, one lane), a random 16-byte salt, and a fresh 24-byte nonce on every save. Unlock keys exist only in the current native session and are zeroized when that session closes. Closing also resets editor undo state and internal Vim registers/history for a protected note. The system clipboard is not changed.

There is no password recovery. The note's file name remains visible. Setting a password replaces the current plaintext note with an encrypted file; previous exports, backups, and filesystem snapshots are unaffected. Exporting a protected note creates a plain Markdown copy and requires an explicit confirmation. Protecting or removing a password refuses to overwrite a conflicting filename. Autosaves detect external changes for both plain and protected notes.

## Where notes live

The app creates its library automatically. It keeps the original storage identifier so existing notes survive the rename to text:

- macOS: `~/Library/Application Support/app.notes.editor/library/`
- Windows: `%APPDATA%\app.notes.editor\library\`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/app.notes.editor/library/`

The sibling `trash/` directory holds items removed in the app. To recover an item, move it from `trash/` into `library/`, then reopen text. The library can be backed up as a normal directory. Import creates a copy in the library; export creates a separate copy and keeps the managed note selected. The application has no cloud sync, telemetry, or runtime network dependency.

Notes are saved using a same-directory temporary file and replacement. The app checks that the disk content still matches what it opened before replacing it. This protects against ordinary external edits; it is not a multi-process file-locking system. Close text before moving or reorganizing the library externally. There is an 8 MB per-note limit.

## Browser preview

```sh
npm run dev
```

Open the printed local URL. Password protection requires the desktop app. The browser preview keeps a separate library in that browser's local storage; its export shortcut downloads Markdown. It does not access the desktop library. Native dialogs and app quitting require the desktop build. Browser storage has its own size limit, and clearing browser data removes preview notes.

## Verify

```sh
npm run build
npx playwright install chromium
npm test
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

The browser tests exercise the real editor and a controlled native bridge, including autosave ordering, math, Vim, library navigation, import/export, and external-change protection. Rust tests exercise file writes, content conflicts, unique naming, path boundaries, symlink handling, authenticated encryption, wrong-password/tamper rejection, and the protect/lock/unlock/save/remove lifecycle. Native dialogs and saving were also checked in the Mac app. Windows and Linux runtime checks remain for their respective hosts.

## Source

- `src/`: TypeScript interface, CodeMirror live rendering, KaTeX, Vim, and storage bridge.
- `src-tauri/`: Rust application, owned library, native dialogs, and guarded file operations.
- `tests/`: Playwright checks.

Tauri 2 uses the system webview. The UI uses vanilla TypeScript and Vite, without a UI framework. Dependency versions are locked in `package-lock.json` and `src-tauri/Cargo.lock`. Third-party notices are in `THIRD_PARTY_NOTICES.txt`.
