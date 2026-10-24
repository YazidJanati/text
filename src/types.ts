export interface DocumentFile {
  path: string;
  content: string;
  protected?: boolean;
}
export interface Entry {
  name: string;
  path: string;
  directory: boolean;
  protected?: boolean;
}
export interface Workspace {
  path: string;
  name: string;
}
export interface EntryInfo extends Entry {
  size: number;
  created: number | null;
  modified: number | null;
}
export interface Storage {
  privateStatus(): Promise<{ path: string; configured: boolean }>;
  unlockPrivate(password: string, setup: boolean): Promise<void>;
  lockPrivate(): Promise<void>;
  moveToPrivate(path: string, expected: string): Promise<DocumentFile>;
  info(path: string): Promise<EntryInfo>;
  library(): Promise<Workspace>;
  latexDefinitions(): Promise<string>;
  saveLatexDefinitions(content: string, expected: string): Promise<void>;
  listFolder(path: string): Promise<Entry[]>;
  readFile(path: string): Promise<DocumentFile>;
  unlockFile(path: string, password: string): Promise<DocumentFile>;
  setPassword(
    path: string,
    password: string,
    expected: string,
  ): Promise<DocumentFile>;
  removePassword(path: string): Promise<DocumentFile>;
  closeNote(): Promise<void>;
  saveFile(
    path: string,
    content: string,
    expected: string,
  ): Promise<DocumentFile>;
  createNote(parent: string, name?: string): Promise<DocumentFile>;
  createFolder(parent: string, name: string): Promise<string>;
  rename(path: string, name: string): Promise<string>;
  move(path: string, parent: string): Promise<string>;
  trash(path: string): Promise<void>;
  importFile(parent: string): Promise<DocumentFile | null>;
  exportFile(content: string, suggested: string): Promise<boolean>;
}
