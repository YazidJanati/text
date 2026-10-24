mod protection;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;
struct ExitApproved(AtomicBool);
#[tauri::command]
fn quit(app: tauri::AppHandle, approved: State<'_, ExitApproved>) {
    approved.0.store(true, Ordering::SeqCst);
    app.exit(0);
}
#[tauri::command]
fn restart_after_update(app: tauri::AppHandle, approved: State<'_, ExitApproved>) {
    approved.0.store(true, Ordering::SeqCst);
    app.restart();
}
const MAX_BYTES: u64 = 8 * 1024 * 1024;
type AppResult<T> = Result<T, String>;
struct Session {
    content: Zeroizing<String>,
    disk: Zeroizing<Vec<u8>>,
    secret: Option<protection::Secret>,
}
#[derive(Default)]
struct Files {
    root: Option<PathBuf>,
    opened: HashMap<PathBuf, Session>,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            content: Zeroizing::new(String::new()),
            disk: Zeroizing::new(Vec::new()),
            secret: None,
        }
    }
}
#[derive(Serialize)]
struct Document {
    path: String,
    content: String,
    protected: bool,
}
#[derive(Serialize)]
struct Workspace {
    path: String,
    name: String,
}
#[derive(Serialize)]
struct Entry {
    path: String,
    name: String,
    directory: bool,
    protected: bool,
}
#[derive(Serialize)]
struct EntryInfo {
    path: String,
    name: String,
    directory: bool,
    protected: bool,
    size: u64,
    created: Option<f64>,
    modified: Option<f64>,
}
fn timestamp(time: std::io::Result<std::time::SystemTime>) -> Option<f64> {
    time.ok()
        .map(|time| match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        })
}
fn inspect_entry(files: &Files, path: &str) -> AppResult<EntryInfo> {
    let path = library_path(files, path)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(EntryInfo {
        name: path
            .file_name()
            .ok_or("Missing name.")?
            .to_string_lossy()
            .into_owned(),
        path: display(&path),
        directory: metadata.is_dir(),
        protected: metadata.is_file() && protected(&path),
        size: metadata.len(),
        created: timestamp(metadata.created()),
        modified: timestamp(metadata.modified()),
    })
}
#[tauri::command]
fn entry_info(path: String, state: State<'_, Mutex<Files>>) -> AppResult<EntryInfo> {
    let files = state.lock().map_err(|error| error.to_string())?;
    inspect_entry(&files, &path)
}
fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|x| x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}
fn read_markdown(path: &Path) -> AppResult<String> {
    if !markdown(path) {
        return Err("Choose a .md or .markdown file.".into());
    }
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("This path is not a file.".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("This file is larger than the 8 MB editing limit.".into());
    }
    fs::read_to_string(path).map_err(|e| format!("Could not read this UTF-8 Markdown file: {e}"))
}
fn allowed(files: &Files, path: &Path) -> bool {
    files.opened.contains_key(path)
        || files
            .root
            .as_ref()
            .map(|root| path.starts_with(root))
            .unwrap_or(false)
}
fn protected(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|x| x.eq_ignore_ascii_case("textlock"))
        .unwrap_or(false)
}
fn note(path: &Path) -> bool {
    markdown(path) || protected(path)
}
fn read_disk(path: &Path) -> AppResult<Vec<u8>> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES + 256 {
        return Err("This note exceeds the 8 MB limit or is not a file.".into());
    }
    fs::read(path).map_err(|e| e.to_string())
}
fn document(
    files: &mut Files,
    path: PathBuf,
    content: Zeroizing<String>,
    disk: Vec<u8>,
    secret: Option<protection::Secret>,
) -> Document {
    let result = Document {
        path: display(&path),
        content: content.to_string(),
        protected: secret.is_some(),
    };
    // A single editor has one session. Switching drops the previous unlock key.
    files.opened.clear();
    files.opened.insert(
        path,
        Session {
            content,
            disk: Zeroizing::new(disk),
            secret,
        },
    );
    result
}
fn load(files: &mut Files, path: PathBuf) -> AppResult<Document> {
    if protected(&path) {
        return Err("PASSWORD_REQUIRED".into());
    }
    let content = Zeroizing::new(read_markdown(&path)?);
    let disk = content.as_bytes().to_vec();
    Ok(document(files, path, content, disk, None))
}
fn atomic_bytes(path: &Path, content: &[u8], create_new: bool) -> AppResult<()> {
    let parent = path.parent().ok_or("This path has no parent folder.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(metadata) = fs::metadata(path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| e.to_string())?;
    }
    temporary.write_all(content).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    if create_new {
        temporary
            .persist_noclobber(path)
            .map_err(|e| e.to_string())?;
    } else {
        temporary.persist(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn atomic_write(path: &Path, content: &str) -> AppResult<()> {
    if content.len() as u64 > MAX_BYTES {
        return Err("This note exceeds the 8 MB limit.".into());
    }
    atomic_bytes(path, content.as_bytes(), false)
}
fn save_checked(
    files: &mut Files,
    path: &Path,
    content: String,
    expected: String,
) -> AppResult<Document> {
    let content = Zeroizing::new(content);
    let expected = Zeroizing::new(expected);
    let path = path.canonicalize().map_err(|e| {
        format!("The file is no longer available: {e}. Export a copy to keep your work.")
    })?;
    if !allowed(files, &path) {
        return Err("Open this note before saving.".into());
    }
    let session = files
        .opened
        .get_mut(&path)
        .ok_or("This note is closed. Reopen it before saving.")?;
    if session.content.as_str() != expected.as_str() {
        return Err("This note has no matching editing session.".into());
    }
    if read_disk(&path)?.as_slice() != session.disk.as_slice() {
        return Err("This file changed on disk. Export a copy to keep your edits.".into());
    }
    if content.len() as u64 > MAX_BYTES {
        return Err("This note exceeds the 8 MB limit.".into());
    }
    let disk = match &session.secret {
        Some(secret) => protection::seal(&content, secret)?,
        None => content.as_bytes().to_vec(),
    };
    atomic_bytes(&path, &disk, false)?;
    session.disk = Zeroizing::new(disk);
    session.content = content;
    Ok(Document {
        path: display(&path),
        content: session.content.to_string(),
        protected: session.secret.is_some(),
    })
}
fn unlock_note(files: &mut Files, path: &Path, password: &str) -> AppResult<Document> {
    let path = library_path(files, &display(path))?;
    if !protected(&path) {
        return load(files, path);
    }
    let disk = read_disk(&path)?;
    let (content, secret) = protection::unlock(&disk, password)?;
    if content.len() as u64 > MAX_BYTES {
        return Err("This note exceeds the 8 MB limit.".into());
    }
    Ok(document(files, path, content, disk, Some(secret)))
}
fn protect_note(
    files: &mut Files,
    path: &Path,
    password: &str,
    expected: &str,
) -> AppResult<Document> {
    let path = library_path(files, &display(path))?;
    if protected(&path) {
        return Err("This note already has a password.".into());
    }
    let session = files.opened.get(&path).ok_or("Open this note first.")?;
    if session.content.as_str() != expected
        || read_disk(&path)?.as_slice() != session.disk.as_slice()
    {
        return Err("This note changed. Reopen it before setting a password.".into());
    }
    let target = path.with_extension("textlock");
    if target.exists() {
        return Err("A protected note with this name already exists.".into());
    }
    let (disk, secret) = protection::protect(&session.content, password)?;
    atomic_bytes(&target, &disk, true)?;
    if read_disk(&path)?.as_slice() != session.disk.as_slice() {
        let _ = fs::remove_file(&target);
        return Err(
            "This note changed during the operation. The original note was retained.".into(),
        );
    }
    if let Err(error) = fs::remove_file(&path) {
        let _ = fs::remove_file(&target);
        return Err(format!(
            "The original note could not be removed; no password was set: {error}"
        ));
    }
    let content = Zeroizing::new(session.content.to_string());
    Ok(document(files, target, content, disk, Some(secret)))
}
fn unprotect_note(files: &mut Files, path: &Path) -> AppResult<Document> {
    let path = library_path(files, &display(path))?;
    let session = files.opened.get(&path).ok_or("Unlock this note first.")?;
    if !protected(&path) || session.secret.is_none() {
        return Err("Unlock this protected note first.".into());
    }
    if read_disk(&path)?.as_slice() != session.disk.as_slice() {
        return Err("This note changed on disk. Close and unlock it again.".into());
    }
    let target = path.with_extension("md");
    if target.exists() {
        return Err("A plain Markdown note with this name already exists.".into());
    }
    let content = Zeroizing::new(session.content.to_string());
    let disk = content.as_bytes().to_vec();
    atomic_bytes(&target, &disk, true)?;
    if read_disk(&path)?.as_slice() != session.disk.as_slice() {
        let _ = fs::remove_file(&target);
        return Err(
            "This note changed during the operation. The original note was retained.".into(),
        );
    }
    if let Err(error) = fs::remove_file(&path) {
        let _ = fs::remove_file(&target);
        return Err(error.to_string());
    }
    Ok(document(files, target, content, disk, None))
}
#[tauri::command]
async fn unlock_file(
    path: String,
    password: String,
    state: State<'_, Mutex<Files>>,
) -> AppResult<Document> {
    let password = Zeroizing::new(password);
    let mut files = state.lock().map_err(|e| e.to_string())?;
    unlock_note(&mut files, Path::new(&path), &password)
}
#[tauri::command]
async fn set_password(
    path: String,
    password: String,
    expected: String,
    state: State<'_, Mutex<Files>>,
) -> AppResult<Document> {
    let password = Zeroizing::new(password);
    let expected = Zeroizing::new(expected);
    let mut files = state.lock().map_err(|e| e.to_string())?;
    protect_note(&mut files, Path::new(&path), &password, &expected)
}
#[tauri::command]
fn remove_password(path: String, state: State<'_, Mutex<Files>>) -> AppResult<Document> {
    let mut files = state.lock().map_err(|e| e.to_string())?;
    unprotect_note(&mut files, Path::new(&path))
}
#[tauri::command]
fn close_note(state: State<'_, Mutex<Files>>) -> AppResult<()> {
    state.lock().map_err(|e| e.to_string())?.opened.clear();
    Ok(())
}
#[tauri::command]
fn list_folder(path: String, state: State<'_, Mutex<Files>>) -> AppResult<Vec<Entry>> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let files = state.lock().map_err(|e| e.to_string())?;
    let root = files.root.as_ref().ok_or("Open a folder first.")?;
    if !path.starts_with(root) {
        return Err("This folder is outside the open workspace.".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || ["node_modules", "target"].contains(&name.as_str()) {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() || (!kind.is_dir() && !note(&entry.path())) {
            continue;
        }
        entries.push(Entry {
            name,
            path: display(&entry.path()),
            directory: kind.is_dir(),
            protected: !kind.is_dir() && protected(&entry.path()),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
#[tauri::command]
fn read_file(path: String, state: State<'_, Mutex<Files>>) -> AppResult<Document> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut files = state.lock().map_err(|e| e.to_string())?;
    if !allowed(&files, &path) {
        return Err("Open this file or its folder first.".into());
    }
    load(&mut files, path)
}
#[tauri::command]
fn save_file(
    path: String,
    content: String,
    expected: String,
    state: State<'_, Mutex<Files>>,
) -> AppResult<Document> {
    let mut files = state.lock().map_err(|e| e.to_string())?;
    save_checked(&mut files, Path::new(&path), content, expected)
}
#[tauri::command]
async fn save_as(
    content: String,
    suggested: String,
    app: tauri::AppHandle,
    _state: State<'_, Mutex<Files>>,
) -> AppResult<Option<Document>> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(&suggested)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let mut path = selected.into_path().map_err(|e| e.to_string())?;
    if path.extension().is_none() {
        path.set_extension("md");
    }
    if !markdown(&path) {
        return Err("Save with a .md or .markdown extension.".into());
    }
    if path.exists() {
        path = path.canonicalize().map_err(|e| e.to_string())?;
    }
    atomic_write(&path, &content)?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    Ok(Some(Document {
        path: display(&path),
        content,
        protected: false,
    }))
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ExitApproved(AtomicBool::new(false)))
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("library");
            fs::create_dir_all(&root)?;
            app.manage(Mutex::new(Files {
                root: Some(root.canonicalize()?),
                opened: HashMap::new(),
            }));
            let menu = native_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "close-note" => {
                let _ = app.emit("close-note", ());
            }
            "shortcuts" => {
                let _ = app.emit("show-shortcuts", ());
            }
            "text-larger" => {
                let _ = app.emit("text-size", 1);
            }
            "text-smaller" => {
                let _ = app.emit("text-size", -1);
            }
            "text-reset" => {
                let _ = app.emit("text-size", 0);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            unlock_file,
            set_password,
            remove_password,
            close_note,
            library,
            create_note,
            create_folder,
            rename_entry,
            move_entry,
            trash_entry,
            import_file,
            quit,
            restart_after_update,
            list_folder,
            entry_info,
            read_file,
            save_file,
            save_as
        ])
        .build(tauri::generate_context!())
        .expect("Could not start text")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<ExitApproved>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("request-quit", ());
                }
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_preserves_markdown_and_rejects_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "# One\r\n").unwrap();
        let path = path.canonicalize().unwrap();
        let mut files = Files::default();
        load(&mut files, path.clone()).unwrap();
        save_checked(&mut files, &path, "# Two\n".into(), "# One\r\n".into()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Two\n");
        fs::write(&path, "external").unwrap();
        assert!(save_checked(&mut files, &path, "my edits".into(), "# Two\n".into()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    }
    #[test]
    fn rejects_unopened_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "original").unwrap();
        assert!(save_checked(
            &mut Files::default(),
            &path,
            "changed".into(),
            "original".into()
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }
}

fn root_path(files: &Files) -> AppResult<PathBuf> {
    files
        .root
        .clone()
        .ok_or_else(|| "The library is not ready.".into())
}
fn library_path(files: &Files, path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = root_path(files)?;
    if !path.starts_with(&root) {
        return Err("This item is outside your notes library.".into());
    }
    Ok(path)
}
fn valid_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("Choose a name without slashes or special characters.".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        return Err("Choose a different name.".into());
    }
    Ok(name.into())
}
fn unique_path(parent: &Path, name: &str, extension: &str) -> PathBuf {
    let mut path = parent.join(format!("{name}{extension}"));
    let mut n = 1;
    while path.exists() || (extension == ".md" && path.with_extension("textlock").exists()) {
        n += 1;
        path = parent.join(format!("{name} {n}{extension}"));
    }
    path
}
fn create_managed(
    files: &mut Files,
    parent: &str,
    name: &str,
    content: String,
) -> AppResult<Document> {
    let parent = library_path(files, parent)?;
    if !parent.is_dir() {
        return Err("Choose a folder.".into());
    }
    let stem = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".markdown"))
        .unwrap_or(name);
    let name = valid_name(stem)?;
    let path = unique_path(&parent, &name, ".md");
    atomic_write(&path, &content)?;
    load(files, path.canonicalize().map_err(|e| e.to_string())?)
}
#[tauri::command]
fn library(state: State<'_, Mutex<Files>>) -> AppResult<Workspace> {
    let files = state.lock().map_err(|e| e.to_string())?;
    Ok(Workspace {
        path: display(&root_path(&files)?),
        name: "text".into(),
    })
}
#[tauri::command]
fn create_note(
    parent: String,
    name: String,
    state: State<'_, Mutex<Files>>,
) -> AppResult<Document> {
    let mut files = state.lock().map_err(|e| e.to_string())?;
    create_managed(&mut files, &parent, &name, String::new())
}
#[tauri::command]
fn create_folder(
    parent: String,
    name: String,
    state: State<'_, Mutex<Files>>,
) -> AppResult<String> {
    let files = state.lock().map_err(|e| e.to_string())?;
    let parent = library_path(&files, &parent)?;
    if !parent.is_dir() {
        return Err("Choose a folder.".into());
    }
    let target = unique_path(&parent, &valid_name(&name)?, "");
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(display(&target))
}
#[tauri::command]
fn rename_entry(path: String, name: String, state: State<'_, Mutex<Files>>) -> AppResult<String> {
    let mut files = state.lock().map_err(|e| e.to_string())?;
    let path = library_path(&files, &path)?;
    if path == root_path(&files)? {
        return Err("The library itself cannot be renamed.".into());
    }
    let is_directory = path.is_dir();
    let mut name = valid_name(&name)?;
    if !is_directory {
        if protected(&path) {
            if !protected(Path::new(&name)) {
                name.push_str(".textlock");
            }
        } else if !markdown(Path::new(&name)) {
            name.push_str(".md");
        }
    }
    let target = path.parent().ok_or("Missing parent folder.")?.join(name);
    if target == path {
        return Ok(display(&path));
    }
    if target.exists() {
        return Err("That name already exists.".into());
    }
    fs::rename(&path, &target).map_err(|e| e.to_string())?;
    remap_opened(&mut files, &path, &target);
    Ok(display(&target))
}
fn remap_opened(files: &mut Files, path: &Path, target: &Path) {
    let old: Vec<_> = files
        .opened
        .keys()
        .filter(|p| p.starts_with(&path))
        .cloned()
        .collect();
    for key in old {
        if let Some(value) = files.opened.remove(&key) {
            files.opened.insert(
                target.join(key.strip_prefix(path).expect("matched path prefix")),
                value,
            );
        }
    }
}
fn move_managed(files: &mut Files, source: &str, parent: &str) -> AppResult<String> {
    let path = library_path(files, source)?;
    let parent = library_path(files, parent)?;
    if path == root_path(files)? {
        return Err("The library itself cannot be moved.".into());
    }
    if !parent.is_dir() {
        return Err("Choose a folder.".into());
    }
    if parent.starts_with(&path) {
        return Err("A folder cannot be moved into itself.".into());
    }
    let target = parent.join(path.file_name().ok_or("Missing name.")?);
    if target == path {
        return Ok(display(&path));
    }
    // Also reject dangling symlinks, which must never be replaced by a drop.
    if fs::symlink_metadata(&target).is_ok() {
        return Err("That name already exists in this folder.".into());
    }
    fs::rename(&path, &target).map_err(|e| e.to_string())?;
    remap_opened(files, &path, &target);
    Ok(display(&target))
}
#[tauri::command]
fn move_entry(path: String, parent: String, state: State<'_, Mutex<Files>>) -> AppResult<String> {
    let mut files = state.lock().map_err(|e| e.to_string())?;
    move_managed(&mut files, &path, &parent)
}
#[tauri::command]
fn trash_entry(path: String, state: State<'_, Mutex<Files>>) -> AppResult<()> {
    let mut files = state.lock().map_err(|e| e.to_string())?;
    let path = library_path(&files, &path)?;
    let root = root_path(&files)?;
    if path == root {
        return Err("The library itself cannot be removed.".into());
    }
    let trash = root
        .parent()
        .ok_or("Missing library parent.")?
        .join("trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let name = path.file_name().ok_or("Missing name.")?.to_string_lossy();
    let target = unique_path(&trash, &name, "");
    fs::rename(&path, target).map_err(|e| e.to_string())?;
    files.opened.retain(|key, _| !key.starts_with(&path));
    Ok(())
}
#[tauri::command]
async fn import_file(
    parent: String,
    app: tauri::AppHandle,
    state: State<'_, Mutex<Files>>,
) -> AppResult<Option<Document>> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|e| e.to_string())?;
    let content = read_markdown(&path)?;
    let name = path
        .file_name()
        .ok_or("Missing file name.")?
        .to_string_lossy();
    let mut files = state.lock().map_err(|e| e.to_string())?;
    create_managed(&mut files, &parent, &name, content).map(Some)
}

#[cfg(test)]
mod library_tests {
    use super::*;
    #[test]
    fn info_reads_filesystem_metadata_without_opening_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("Unicode.md");
        fs::write(&path, "é").unwrap();
        let files = Files {
            root: Some(root.clone()),
            ..Files::default()
        };
        let info = inspect_entry(&files, &display(&path)).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(info.path, display(&path));
        assert_eq!(info.name, "Unicode.md");
        assert_eq!(info.size, 2);
        assert_eq!(info.created, timestamp(metadata.created()));
        assert_eq!(info.modified, timestamp(metadata.modified()));
        assert!(!info.directory);
        assert!(!info.protected);
        assert!(files.opened.is_empty());
        assert!(inspect_entry(&files, &display(&root)).unwrap().directory);
        assert!(inspect_entry(&files, &display(&root.join("missing.md"))).is_err());
        let outside = tempfile::tempdir().unwrap();
        assert!(inspect_entry(&files, &display(outside.path())).is_err());
    }
    #[test]
    fn info_for_a_locked_note_does_not_unlock_or_change_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let mut files = Files {
            root: Some(root.clone()),
            ..Files::default()
        };
        let plain =
            create_managed(&mut files, &display(&root), "Private", "Secret".into()).unwrap();
        let secured =
            protect_note(&mut files, Path::new(&plain.path), "password", "Secret").unwrap();
        files.opened.clear();
        let before = fs::read(&secured.path).unwrap();
        let info = inspect_entry(&files, &secured.path).unwrap();
        assert!(info.protected);
        assert_eq!(info.size, before.len() as u64);
        assert_eq!(fs::read(&secured.path).unwrap(), before);
        assert!(files.opened.is_empty());
    }
    #[test]
    fn moving_an_open_note_keeps_saving_at_its_new_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let destination = root.join("work");
        fs::create_dir(&destination).unwrap();
        let mut files = Files {
            root: Some(root.clone()),
            ..Files::default()
        };
        let doc = create_managed(&mut files, &display(&root), "Thought", "before".into()).unwrap();
        let moved = move_managed(&mut files, &doc.path, &display(&destination)).unwrap();
        assert!(!Path::new(&doc.path).exists());
        assert!(!files.opened.contains_key(Path::new(&doc.path)));
        save_checked(&mut files, Path::new(&moved), "after".into(), doc.content).unwrap();
        assert_eq!(fs::read_to_string(&moved).unwrap(), "after");
        let back = move_managed(&mut files, &moved, &display(&root)).unwrap();
        assert_eq!(back, doc.path);
        assert_eq!(fs::read_to_string(back).unwrap(), "after");
    }
    #[test]
    fn moves_reject_collisions_cycles_and_paths_outside_the_library() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let folder = root.join("work");
        let sub = folder.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let mut files = Files {
            root: Some(root.clone()),
            ..Files::default()
        };
        let doc = create_managed(&mut files, &display(&root), "Note", "source".into()).unwrap();
        fs::write(folder.join("Note.md"), "destination").unwrap();
        assert!(move_managed(&mut files, &doc.path, &display(&folder)).is_err());
        assert_eq!(fs::read_to_string(&doc.path).unwrap(), "source");
        assert_eq!(
            fs::read_to_string(folder.join("Note.md")).unwrap(),
            "destination"
        );
        assert!(move_managed(&mut files, &display(&folder), &display(&sub)).is_err());
        assert!(move_managed(&mut files, &display(&folder), &display(&folder)).is_err());
        assert!(move_managed(&mut files, &display(&root), &display(&sub)).is_err());
        assert!(move_managed(&mut files, &doc.path, &display(outside.path())).is_err());
        assert!(move_managed(&mut files, &doc.path, &doc.path).is_err());
        assert_eq!(
            move_managed(&mut files, &doc.path, &display(&root)).unwrap(),
            doc.path
        );
    }
    #[cfg(unix)]
    #[test]
    fn moves_reject_external_symlink_destinations() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let link = root.join("escape");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let mut files = Files {
            root: Some(root.clone()),
            ..Files::default()
        };
        let doc = create_managed(&mut files, &display(&root), "Note", "source".into()).unwrap();
        assert!(move_managed(&mut files, &doc.path, &display(&link)).is_err());
        assert!(Path::new(&doc.path).exists());
    }
    #[test]
    fn managed_notes_have_unique_names_and_stay_plain_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let mut files = Files {
            root: Some(root.clone()),
            opened: HashMap::new(),
        };
        let source = "# Math\n\n$E=mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$\n";
        let first = create_managed(&mut files, &display(&root), "Physics", source.into()).unwrap();
        let second = create_managed(&mut files, &display(&root), "Physics", String::new()).unwrap();
        assert!(first.path.ends_with("Physics.md"));
        assert!(second.path.ends_with("Physics 2.md"));
        assert_eq!(fs::read_to_string(&first.path).unwrap(), source);
        assert_eq!(files.opened.len(), 1);
    }
    #[test]
    fn library_rejects_paths_outside_its_root_and_invalid_names() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut files = Files {
            root: Some(dir.path().canonicalize().unwrap()),
            opened: HashMap::new(),
        };
        assert!(create_managed(
            &mut files,
            &display(outside.path()),
            "Outside",
            String::new()
        )
        .is_err());
        for name in [
            "../escape",
            "a/b",
            "a\\b",
            ".hidden",
            "",
            "NUL",
            "con.txt",
            "note:",
        ] {
            assert!(valid_name(name).is_err(), "{name}");
        }
        assert!(valid_name("A real note").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn library_rejects_symlinks_that_escape_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        let files = Files {
            root: Some(dir.path().canonicalize().unwrap()),
            opened: HashMap::new(),
        };
        assert!(library_path(&files, &display(&dir.path().join("escape"))).is_err());
    }
}

fn native_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "text",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&MenuItem::with_id(
                    app,
                    "close-note",
                    "Close Note",
                    true,
                    Some("CmdOrCtrl+W"),
                )?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "text-larger",
                        "Increase Text Size",
                        true,
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(
                        app,
                        "text-smaller",
                        "Decrease Text Size",
                        true,
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(app, "text-reset", "Reset Text Size", true, None::<&str>)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Help",
                true,
                &[&MenuItem::with_id(
                    app,
                    "shortcuts",
                    "Keyboard Shortcuts",
                    true,
                    Some("F1"),
                )?],
            )?,
        ],
    )
}
#[cfg(test)]
mod protection_lifecycle_tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Files, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let mut files = Files {
            root: Some(root.clone()),
            opened: HashMap::new(),
        };
        let doc =
            create_managed(&mut files, &display(&root), "Private", "# Secret\n".into()).unwrap();
        (dir, files, PathBuf::from(doc.path))
    }
    #[test]
    fn protect_close_unlock_save_remove_round_trip() {
        let (_dir, mut files, plain) = setup();
        let secured = protect_note(&mut files, &plain, "my password", "# Secret\n").unwrap();
        let path = PathBuf::from(&secured.path);
        assert!(secured.protected);
        assert!(!plain.exists());
        assert!(path.exists());
        files.opened.clear();
        assert!(matches!(load(&mut files,path.clone()),Err(error) if error=="PASSWORD_REQUIRED"));
        assert!(save_checked(&mut files, &path, "bypass".into(), "# Secret\n".into()).is_err());
        assert!(unlock_note(&mut files, &path, "wrong").is_err());
        assert!(files.opened.is_empty());
        let unlocked = unlock_note(&mut files, &path, "my password").unwrap();
        assert_eq!(unlocked.content, "# Secret\n");
        save_checked(&mut files, &path, "# Edited\n".into(), unlocked.content).unwrap();
        let disk = fs::read(&path).unwrap();
        assert!(disk.starts_with(protection::MAGIC));
        assert!(!disk.windows(6).any(|w| w == b"Edited"));
        files.opened.clear();
        assert_eq!(
            unlock_note(&mut files, &path, "my password")
                .unwrap()
                .content,
            "# Edited\n"
        );
        let restored = unprotect_note(&mut files, &path).unwrap();
        assert!(!restored.protected);
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(restored.path).unwrap(), "# Edited\n");
    }
    #[test]
    fn external_edit_and_name_collision_never_destroy_a_note() {
        let (_dir, mut files, plain) = setup();
        let protected_path = plain.with_extension("textlock");
        fs::write(&protected_path, "occupied").unwrap();
        assert!(protect_note(&mut files, &plain, "password", "# Secret\n").is_err());
        assert_eq!(fs::read_to_string(&plain).unwrap(), "# Secret\n");
        fs::remove_file(&protected_path).unwrap();
        let doc = protect_note(&mut files, &plain, "password", "# Secret\n").unwrap();
        fs::write(&doc.path, "external").unwrap();
        assert!(save_checked(&mut files, Path::new(&doc.path), "new".into(), doc.content).is_err());
        assert_eq!(fs::read_to_string(doc.path).unwrap(), "external");
    }
    #[test]
    fn moving_a_folder_preserves_encryption_and_the_open_unlock_session() {
        let (_dir, mut files, plain) = setup();
        let root = root_path(&files).unwrap();
        let folder = root.join("work");
        let archive = root.join("archive");
        fs::create_dir(&folder).unwrap();
        fs::create_dir(&archive).unwrap();
        let secured = protect_note(&mut files, &plain, "password", "# Secret\n").unwrap();
        let original = fs::read(&secured.path).unwrap();
        let inside = move_managed(&mut files, &secured.path, &display(&folder)).unwrap();
        move_managed(&mut files, &display(&folder), &display(&archive)).unwrap();
        let moved = archive.join("work").join("Private.textlock");
        assert!(!Path::new(&inside).exists());
        assert_eq!(fs::read(&moved).unwrap(), original);
        save_checked(&mut files, &moved, "Edited secret".into(), secured.content).unwrap();
        files.opened.clear();
        assert!(load(&mut files, moved.clone()).is_err());
        assert!(unlock_note(&mut files, &moved, "wrong").is_err());
        assert_eq!(
            unlock_note(&mut files, &moved, "password").unwrap().content,
            "Edited secret"
        );
        files.opened.clear();
        let closed_move = move_managed(&mut files, &display(&moved), &display(&root)).unwrap();
        assert!(files.opened.is_empty());
        assert!(load(&mut files, PathBuf::from(&closed_move)).is_err());
        assert_eq!(
            unlock_note(&mut files, Path::new(&closed_move), "password")
                .unwrap()
                .content,
            "Edited secret"
        );
    }
    #[test]
    fn switching_to_another_note_drops_the_unlock_session() {
        let (_dir, mut files, plain) = setup();
        let doc = protect_note(&mut files, &plain, "password", "# Secret\n").unwrap();
        let root = display(&root_path(&files).unwrap());
        create_managed(&mut files, &root, "Other", String::new()).unwrap();
        assert!(!files.opened.contains_key(Path::new(&doc.path)));
        assert!(unprotect_note(&mut files, Path::new(&doc.path)).is_err());
    }
}
