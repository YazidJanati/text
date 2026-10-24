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

Open **Help → Keyboard Shortcuts** (or press **F1**, sometimes **Fn+F1** on laptops) for the in-app reference. Escape closes it and returns to where you were editing.

text opens to a blank note in its own library. It saves after 500 ms of inactivity, on focus loss, and before switching notes or quitting. Unprotected files remain ordinary UTF-8 `.md` files. Password-protected notes use encrypted `.textlock` files. The app does not require you to choose a storage folder or handle Save dialogs.

Create notes and folders with the two sidebar controls or shortcuts. New items go into the selected folder; click empty sidebar space to select the library root. Click a folder to expand it. Drag notes or folders onto a folder to move them. Drop into empty sidebar space (or the text heading) to move them back to the library root. The destination highlights while dragging, and opens after a successful drop. Existing names are never overwritten; protected notes keep their encryption. Rename a focused sidebar item with Enter or F2: its name becomes editable directly in the sidebar, without a dialog. Enter or clicking elsewhere commits; Escape cancels. Only the selected sidebar item is highlighted. Arrow keys navigate the file tree; Left/Right collapse and expand folders, Delete moves an item to trash, and Escape returns to the editor. You can also rename through the document title, a double click, or the context menu. The context menu also moves a note or folder to the app's local trash, preserving its contents.

Right-click a note or folder and choose **Get Info** for its full location, type, creation/modification dates, and (for notes) size and password status. These dates come from the current file’s filesystem metadata; unavailable timestamps are shown as unavailable. Info works for locked notes without opening their contents. The browser preview cannot provide filesystem dates.

Use **View → Increase / Decrease / Reset Text Size**, or **⌘/Ctrl + +**, **−**, and **0**, to resize only the editor text. Headings, code, and math scale with it; the sidebar and controls keep their size. Text size is remembered between sessions.

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

Markdown markers are visible on the line containing the cursor and are rendered inline elsewhere. Headings, emphasis, lists, tasks, blockquotes, rules, code, and links are supported. Inline equations render as soon as the closing `$` is followed by a space; you can keep writing on the same line. Clicking a rendered equation, selecting it, or moving the cursor inside reveals its source. Display equations stay editable while the cursor is in their block. Use `$E=mc^2$` for inline math and `$$` on separate lines for display math:

```markdown
$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
```

Math uses bundled KaTeX and fonts, works offline, and supports the [KaTeX syntax](https://katex.org/docs/supported). Tables, image references, and raw HTML remain editable Markdown source. Raw HTML is never executed, and remote images are not loaded. This is a focused editor, not a full Typora compatibility implementation.

### Shared LaTeX notation (`def.tex`)

To add your own LaTeX notation, create a UTF-8 text file named **`def.tex`** at the top level of the desktop notes library. On macOS this is `~/Library/Application Support/app.notes.editor/library/def.tex`. Or choose **Help → LaTeX notation…** to edit it inside the app: Save creates the file if needed, validates the definitions, and refreshes equations immediately. Cancel leaves it unchanged. The editor checks for external edits before saving.

```latex
\newcommand{\R}{\mathbb{R}}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}
```

These definitions apply to inline and display math in every note, including subfolders: `$\R$` and `$\norm{x}$`. They load at startup and reload when you return to the app after editing the file externally. Removing the file clears the definitions on the next reload. Invalid definitions show a notice and retain the last working definitions until fixed. The file is optional, limited to 64 KB, and hidden from the notes list. Use KaTeX-compatible commands such as `\newcommand`, `\renewcommand`, `\def`, and `\DeclareMathOperator`; full LaTeX packages, `\input`, and `\include` are not supported. Definitions are used only for rendering and are not inserted into saved/exported Markdown. Browser preview does not read this file.

## Passwords and closing notes

Password protection is optional and available in the desktop app. Right-click a note and choose **Set password**, then enter and confirm the password. New notes have no password. After unlocking a protected note, its context menu offers **Remove password**.

**Ctrl+W** saves and closes the current note, leaving a blank editor and the file tree. **⌘W** and File → Close Note do the same on macOS. No tabs are created. Click the note in the sidebar to reopen it; protected notes always ask for their password after closing, switching notes, or restarting the application. An explicitly closed note stays closed at startup. The app does not remember passwords. The app's Quit command and `:q` / `:wq` still exit the application.

Protected note contents are encrypted using [XChaCha20-Poly1305](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/) authenticated encryption, with a key derived using [Argon2id](https://docs.rs/argon2/0.5.3/argon2/) (64 MiB, three passes, one lane), a random 16-byte salt, and a fresh 24-byte nonce on every save. Unlock keys exist only in the current native session and are zeroized when that session closes. Closing also resets editor undo state and internal Vim registers/history for a protected note. The system clipboard is not changed.

The permanent **Private** folder in the sidebar has its own password. Click it to set a password on first use, then enter that password whenever it is locked. While locked, no private note titles, previews or note count are shown. New notes inside Private are encrypted with the folder key. To move an existing note, right-click it and choose **Move to Private**; notes with an existing password ask for that password before being encrypted with the folder key. The permanent folder cannot be renamed, moved or deleted. Private notes cannot be dragged into the public library or have their encryption removed; export an explicitly confirmed Markdown copy instead.

Opening a public note, closing a private note, switching to another app, or hiding the window immediately conceals private contents and dialogs, saves pending edits, then locks the folder and drops its native unlock keys. Returning does not reveal anything automatically. Click Private and enter its password to resume your last private note. Private titles and paths are not saved as startup pointers or used in the native window title. If saving fails, edits stay hidden in memory and are restored after authentication; quitting or updating cannot silently discard that draft. Browser preview does not offer Private.

There is no password recovery. Private filenames are concealed inside the app while locked; filenames on disk, older backups and filesystem snapshots are not concealed. Keep the Private folder's `.password` file with its encrypted notes when backing up the library. Ordinary protected notes outside Private still show their file names. Setting a password replaces the current plaintext note with an encrypted file; previous exports, backups, and filesystem snapshots are unaffected. Exporting a protected note creates a plain Markdown copy and requires an explicit confirmation. Protecting or removing a password refuses to overwrite a conflicting filename. Autosaves detect external changes for both plain and protected notes.

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

## In-app updates and releases

Desktop users can click **Updates**, then **Update and restart**. Checks happen only on request. The app saves the current note and blocks editing during installation; a save failure blocks the update. Downloads are verified with Tauri updater signatures. Browser preview hides this control.

Existing 0.1.7 installations do not contain an updater: users must manually install the first update-enabled release once. A source push alone does not update installed apps; publish a higher versioned release.

One-time repository setup (maintainer):

1. Generate a signing key outside the repository with `npm run tauri -- signer generate -w /secure/location/text-updater.key`. Back up the private key and its password securely; keep using this same key for future releases.
2. In GitHub repository Settings → Secrets and variables → Actions, add the private key contents as secret `TAURI_SIGNING_PRIVATE_KEY`, its password as secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the public `.pub` file contents as variable `TAURI_UPDATER_PUBLIC_KEY`. Never commit the private key. The checked-in configuration contains only the public verification key, so local builds can also check signed updates. Keep the GitHub variable and checked-in public key identical.
3. For each release, bump `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to the same new version (the first update-enabled release is 0.1.8) and regenerate both lockfiles (`npm install --package-lock-only` and `cargo check --manifest-path src-tauri/Cargo.toml`). Commit, push, and push the matching tag (for example `v0.1.8`).
4. The release workflow builds Apple Silicon/Intel macOS, Windows NSIS, and Linux AppImage/deb artifacts, signatures, and a combined `latest.json` in a **draft** GitHub release. After all matrix builds succeed, inspect and publish the draft. Sequential builds prevent concurrent updater-manifest edits. Keep the release public so installed apps can download without credentials.
5. For each subsequent release, increase the same versions and push the matching `vX.Y.Z` tag. Publish the completed draft to make it available via Updates. Linux in-app updates require the AppImage distribution; deb users use their installer/package manager.

Updater signatures are separate from operating-system signing. This workflow does not configure Apple Developer signing/notarization or Windows code signing; configure those before distributing builds that require them. Install the Mac app in a writable location such as Applications before updating.

Reference: https://v2.tauri.app/plugin/updater/

## Switch between notes in a folder

Press **Ctrl+Tab** (Control on Mac, not Command) to open the note switcher. It lists only notes alongside the current note, including password-protected notes; folders and their contents are excluded. With no note open, it uses the selected folder. The next note is highlighted initially. Press **Tab** to cycle forward, **Shift+Tab** to cycle backward, or use the arrow keys. Type a note name to filter the list (exact matches come first), then press **Enter** or click a result to open it. **Esc** cancels. Switching uses the normal save and password checks; locked notes are not unlocked just by listing them. Private note names are cleared from the picker immediately when Private locks.
