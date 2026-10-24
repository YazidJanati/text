import { test, expect, type Page } from "@playwright/test";
const mod = process.platform === "darwin" ? "Meta" : "Control";
async function native(
  page: Page,
  initial: Record<string, string | null> = { "/notes/Untitled.md": "" },
) {
  await page.addInitScript(
    ({ initial }) => {
      const w = window as any;
      w.isTauri = true;
      w.testFiles = JSON.parse(
        sessionStorage.getItem("files") || JSON.stringify(initial),
      );
      w.calls = [];
      w.cancelExport = false;
      w.testProtected = JSON.parse(sessionStorage.getItem("protected") || "{}");
      w.unlocked = null;
      const persistProtected = () =>
        sessionStorage.setItem("protected", JSON.stringify(w.testProtected));
      const persist = () =>
        sessionStorage.setItem("files", JSON.stringify(w.testFiles));
      const unique = (parent: string, name: string, ext = "") => {
        let path = parent + "/" + name + ext,
          index = 1;
        while (
          path in w.testFiles ||
          (ext === ".md" && path.replace(/\.md$/, ".textlock") in w.testFiles)
        )
          path = parent + "/" + name + " " + ++index + ext;
        return path;
      };
      const callbacks = new Map(),
        listeners = new Map();
      let id = 0;
      w.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (cb: any) => {
          callbacks.set(++id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: any = {}) => {
          w.calls.push({ command, args });
          if (command === "plugin:event|listen") {
            listeners.set(args.event, args.handler);
            return args.handler;
          }
          if (command === "library") return { path: "/notes", name: "notes" };
          if (command === "latex_definitions") return w.testFiles["/notes/def.tex"] || "";
          if (command === "save_latex_definitions") {
            if ((w.testFiles["/notes/def.tex"] || "") !== args.expected)
              throw "def.tex changed elsewhere. Cancel and reopen LaTeX notation to load the latest file.";
            w.testFiles["/notes/def.tex"] = args.content;
            persist();
            return;
          }
          if (command === "list_folder")
            return Object.keys(w.testFiles)
              .filter(
                (p) =>
                  p.startsWith(args.path + "/") &&
                  !p.slice(args.path.length + 1).includes("/") &&
                  (w.testFiles[p] === null || /\.(md|markdown|textlock)$/i.test(p)),
              )
              .map((p) => ({
                path: p,
                name: p.split("/").at(-1),
                directory: w.testFiles[p] === null,
                protected: !!w.testProtected[p],
              }))
              .sort(
                (a, b) =>
                  Number(b.directory) - Number(a.directory) ||
                  a.name.localeCompare(b.name),
              );
          if (command === "entry_info") {
            if (!(args.path in w.testFiles)) throw "Missing item";
            return {
              path: args.path, name: args.path.split("/").at(-1),
              directory: w.testFiles[args.path] === null,
              protected: !!w.testProtected[args.path],
              size: new TextEncoder().encode(w.testFiles[args.path] || "").length,
              created: Date.UTC(2026, 8, 1, 10), modified: Date.UTC(2026, 9, 2, 11),
            };
          }
          if (command === "close_note") {
            w.unlocked = null;
            return;
          }
          if (command === "set_password") {
            if (w.testFiles[args.path] !== args.expected) throw "Note changed";
            const path = args.path.replace(/\.(md|markdown)$/i, ".textlock");
            if (path in w.testFiles) throw "That name already exists.";
            w.testProtected[path] = {
              content: args.expected,
              password: args.password,
            };
            delete w.testFiles[args.path];
            w.testFiles[path] = "encrypted";
            w.unlocked = path;
            persist();
            persistProtected();
            return { path, content: args.expected, protected: true };
          }
          if (command === "unlock_file") {
            const stored = w.testProtected[args.path];
            if (!stored || stored.password !== args.password)
              throw "Incorrect password, or this note has been damaged.";
            w.unlocked = args.path;
            return {
              path: args.path,
              content: stored.content,
              protected: true,
            };
          }
          if (command === "remove_password") {
            if (w.unlocked !== args.path) throw "Unlock first";
            const content = w.testProtected[args.path].content,
              path = args.path.replace(/\.textlock$/i, ".md");
            if (path in w.testFiles) throw "That name already exists.";
            delete w.testProtected[args.path];
            delete w.testFiles[args.path];
            w.testFiles[path] = content;
            w.unlocked = null;
            persist();
            persistProtected();
            return { path, content, protected: false };
          }
          if (command === "read_file") {
            if (w.testProtected[args.path]) throw "PASSWORD_REQUIRED";
            w.unlocked = null;
            if (typeof w.testFiles[args.path] !== "string")
              throw "Missing note";
            return { path: args.path, content: w.testFiles[args.path] };
          }
          if (command === "create_note") {
            const path = unique(args.parent, args.name || "Untitled", ".md");
            w.testFiles[path] = "";
            persist();
            return { path, content: "" };
          }
          if (command === "create_folder") {
            const path = unique(args.parent, args.name);
            w.testFiles[path] = null;
            persist();
            return path;
          }
          if (command === "save_file") {
            if (w.testProtected[args.path]) {
              if (w.unlocked !== args.path) throw "Note is closed";
              if (w.testProtected[args.path].content !== args.expected)
                throw "Note changed";
              w.testProtected[args.path].content = args.content;
              persistProtected();
              return {
                path: args.path,
                content: args.content,
                protected: true,
              };
            }
            if (w.holdSave)
              await new Promise((resolve) => {
                w.releaseSave = resolve;
              });
            if (w.testFiles[args.path] !== args.expected)
              throw "This file changed on disk. Export a copy to keep your edits.";
            w.testFiles[args.path] = args.content;
            persist();
            return { path: args.path, content: args.content };
          }
          if (command === "rename_entry" || command === "move_entry") {
            const target = command === "move_entry"
              ? args.parent + "/" + args.path.split("/").at(-1)
              : args.path.slice(0, args.path.lastIndexOf("/") + 1) +
              args.name +
              (w.testFiles[args.path] === null
                ? ""
                : w.testProtected[args.path]
                  ? ".textlock"
                  : ".md");
            if (target in w.testFiles) throw "That name already exists.";
            for (const p of Object.keys(w.testFiles))
              if (p === args.path || p.startsWith(args.path + "/")) {
                w.testFiles[target + p.slice(args.path.length)] =
                  w.testFiles[p];
                delete w.testFiles[p];
                if (w.testProtected[p]) {
                  w.testProtected[target + p.slice(args.path.length)] =
                    w.testProtected[p];
                  delete w.testProtected[p];
                }
                if (w.unlocked === p)
                  w.unlocked = target + p.slice(args.path.length);
              }
            persist();
            persistProtected();
            return target;
          }
          if (command === "trash_entry") {
            for (const p of Object.keys(w.testFiles))
              if (p === args.path || p.startsWith(args.path + "/"))
                delete w.testFiles[p];
            persist();
            return;
          }
          if (command === "import_file") {
            const path = unique(args.parent, "imported", ".md");
            w.testFiles[path] = "# Imported\n";
            persist();
            return { path, content: w.testFiles[path] };
          }
          if (command === "save_as")
            return w.cancelExport
              ? null
              : { path: "/export/note.md", content: args.content };
        },
      };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      w.fireTextSize = (change: number) => callbacks.get(listeners.get("text-size"))?.({
        event: "text-size", payload: change,
      });
      w.fireLatexNotation = () => callbacks.get(listeners.get("edit-latex-notation"))?.({
        event: "edit-latex-notation", payload: null,
      });
      w.fireShortcuts = () => callbacks.get(listeners.get("show-shortcuts"))?.({
        event: "show-shortcuts", payload: null,
      });
      w.fireCloseNote = () =>
        callbacks.get(listeners.get("close-note"))?.({
          event: "close-note",
          payload: null,
        });
      w.fireQuit = () =>
        callbacks.get(listeners.get("request-quit"))?.({
          event: "request-quit",
          payload: null,
        });
    },
    { initial },
  );
  await page.goto("/");
  await expect(page.locator("#document-name")).not.toBeEmpty();
}
async function regular(page: Page) {
  if (await page.locator("#vim-mode").isVisible())
    await page.keyboard.press(`${mod}+Alt+v`);
}
async function replace(page: Page, content: string) {
  await regular(page);
  await page.getByRole("textbox", { name: "Markdown editor" }).focus();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(content);
}
async function disk(page: Page, path = "/notes/Untitled.md") {
  return page.evaluate((path) => (window as any).testFiles[path], path);
}
async function ex(page: Page, command: string) {
  await page.keyboard.type(":" + command);
  await page.keyboard.press("Enter");
}

test("starts with a blank managed note, a file tree, and no filler", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await native(page);
  await expect(page.locator(".cm-content")).toHaveText("");
  await expect(page.locator("#document-name")).toHaveText("Untitled");
  await expect(page.locator("#vim-mode")).toHaveText("[normal]");
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Welcome");
  await expect(page.locator("#notice")).toBeHidden();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "tests/notes-dark.png" });
});

test("sidebar shortcut preserves content and focus, and remembers the layout", async ({
  page,
}) => {
  await native(page);
  await replace(page, "A thought");
  await page.keyboard.press(`${mod}+b`);
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("A thought");
  await page.keyboard.press(`${mod}+s`);
  await page.reload();
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator(".cm-content")).toHaveText("A thought");
  await page.keyboard.press(`${mod}+b`);
  await expect(page.locator("#sidebar")).toBeVisible();
});

test("autosaves Markdown and restores the note after a reload", async ({
  page,
}) => {
  await native(page);
  await replace(page, "# Kept\n\n**plain Markdown**\n");
  await expect(page.locator("#dirty")).toBeVisible();
  await expect.poll(() => disk(page)).toBe("# Kept\n\n**plain Markdown**\n");
  await expect(page.locator("#dirty")).toBeHidden();
  await page.reload();
  await expect(page.locator(".md-h1")).toHaveText("# Kept");
  expect(await disk(page)).toBe("# Kept\n\n**plain Markdown**\n");
});

test("switching notes flushes pending edits and creates distinct notes", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Save before switching");
  await page.keyboard.press(`${mod}+n`);
  await expect(page.locator("#document-name")).toHaveText("Untitled 2");
  expect(await disk(page)).toBe("Save before switching");
  await page.getByRole("button", { name: "Untitled", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("Save before switching");
});

test("creates folders and notes inside them; renaming keeps note contents", async ({
  page,
}) => {
  await native(page);
  await page.keyboard.press(`${mod}+Shift+n`);
  await page
    .getByRole("textbox", { name: "New folder", exact: true })
    .fill("physics");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "physics", exact: true }),
  ).toBeVisible();
  await page.keyboard.press(`${mod}+n`);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).testFiles["/notes/physics/Untitled.md"],
      ),
    )
    .toBe("");
  await replace(page, "A nested note");
  await page.keyboard.press("F2");
  await page
    .getByRole("textbox", { name: "Rename", exact: true })
    .fill("Mechanics");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.locator("#document-name")).toHaveText("Mechanics");
  expect(await disk(page, "/notes/physics/Mechanics.md")).toBe("A nested note");
  await page.reload();
  await expect(
    page
      .locator("#files")
      .getByRole("button", { name: "Mechanics", exact: true }),
  ).toBeVisible();
});

test("moving a note to trash leaves a usable blank note", async ({ page }) => {
  await native(page);
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator("#document-name")).toHaveText("Untitled");
  await expect(page.locator(".cm-content")).toHaveText("");
  await replace(page, "Still works");
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe("Still works");
});

test("inline and display math render, click reveals source, and Markdown stays intact", async ({
  page,
}) => {
  const source =
    "# Math\n\nEnergy $E=mc^2$.\n\n$$\n\\int_0^1 x^2\\,dx=\\frac{1}{3}\n$$\n\n";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await native(page);
  await replace(page, source);
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await expect(page.locator(".math-block .katex")).toHaveCount(1);
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe(source);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "tests/notes-math.png" });
  await page.locator(".math-block").click();
  await expect(page.locator(".math-block")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("\\int_0^1");
});

test("square brackets in math take precedence over Markdown links", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await native(page);
  await replace(page, "$E[X]$");
  await expect(page.locator(".math-inline")).toHaveCount(0);
  await expect(page.locator(".md-link")).toHaveCount(0);
  await page.keyboard.type(" ");
  await expect(page.locator('.math-inline[aria-label="E[X]"] .katex')).toHaveCount(1);
  await page.locator(".math-inline").click();
  await expect(page.locator(".math-inline")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("$E[X]$ ");
  await expect(page.locator(".md-link")).toHaveCount(0);

  const source = "$E[X]$ and $E[X^2]$ with [a link](https://example.com).\n\n$$\nE[X] = \\sum_{x \\in [0,1]} x p(x)\n$$\n\n[X]: https://example.com\n\n";
  await replace(page, source);
  await expect(page.locator(".math-inline .katex")).toHaveCount(2);
  await expect(page.locator(".math-block .katex")).toHaveCount(1);
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await expect(page.locator(".md-link")).toHaveText("a link");
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe(source);
  expect(errors).toEqual([]);
});

test("dollars inside real links, images, code and HTML remain literal", async ({ page }) => {
  const source = "[$x$](https://example.com)\n\n![alt $E[X]$](image.png)\n\n[label](https://example.com/$E[X]$)\n\n`$E[X]$`\n\n```tex\n$E[X]$\n```\n\n<span title=\"$E[X]$\">literal</span>\n\n";
  await native(page);
  await replace(page, source);
  await expect(page.locator(".katex")).toHaveCount(0);
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe(source);
});

test("code and escaped dollars are not math; document HTML never executes", async ({
  page,
}) => {
  await native(page);
  await replace(
    page,
    "`$code$`\n\n```tex\n$x^2$\n```\n\n\\$escaped$\n\n<script>window.bad=true</script>\n\n",
  );
  await expect(page.locator(".katex")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).bad)).toBeUndefined();
});

test("external changes keep both versions and block closing until resolved", async ({
  page,
}) => {
  await native(page);
  await replace(page, "My edit");
  await page.evaluate(() => {
    (window as any).testFiles["/notes/Untitled.md"] = "External edit";
  });
  await page.keyboard.press(`${mod}+s`);
  await expect(page.getByRole("alert")).toContainText("changed on disk");
  await expect(page.locator("#dirty")).toBeVisible();
  await page.evaluate(() => (window as any).fireQuit());
  await expect(page.locator("#unsaved")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("My edit");
  expect(await disk(page)).toBe("External edit");
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.filter((x: any) => x.command === "quit").length,
    ),
  ).toBe(0);
});

test("edits made while a save is in flight are saved in order", async ({
  page,
}) => {
  await native(page);
  await page.evaluate(() => {
    (window as any).holdSave = true;
  });
  await replace(page, "First");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).calls.some((x: any) => x.command === "save_file"),
      ),
    )
    .toBe(true);
  await page.keyboard.insertText(" second");
  await page.evaluate(() => {
    (window as any).holdSave = false;
    (window as any).releaseSave();
  });
  await expect.poll(() => disk(page)).toBe("First second");
  await expect(page.locator("#dirty")).toBeHidden();
});

test("CRLF and trailing spaces survive editing and saving", async ({
  page,
}) => {
  const original = "# Windows\r\n\r\nText  \r\n";
  await native(page, { "/notes/Untitled.md": original });
  await replace(page, original.replaceAll("\r\n", "\n") + "End\n");
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe(original + "End\r\n");
});

test("Vim insert, normal motions, deletion, undo, search and :w work", async ({
  page,
}) => {
  await native(page);
  await page.keyboard.type("i");
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
  await page.keyboard.insertText("alpha beta\ngamma");
  await page.keyboard.press("Escape");
  await expect(page.locator("#vim-mode")).toHaveText("[normal]");
  await page.keyboard.type("gg0dw");
  await expect(page.locator(".cm-line")).toHaveText(["beta", "gamma"]);
  await page.keyboard.type("u");
  await expect(page.locator(".cm-line")).toHaveText(["alpha beta", "gamma"]);
  await page.keyboard.type("/gamma");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await ex(page, "w");
  await expect.poll(() => disk(page)).toBe("alpha beta\ngamma");
  await expect(page.locator("#notice")).toBeHidden();
});

test("Vim visual mode and :wq save before quit", async ({ page }) => {
  await native(page);
  await page.keyboard.type("i");
  await page.keyboard.insertText("Keep this");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg0vll");
  await expect(page.locator("#vim-mode")).toContainText("visual");
  await page.keyboard.press("Escape");
  await ex(page, "wq");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls.filter((x: any) => x.command === "quit").length,
      ),
    )
    .toBe(1);
  expect(await disk(page)).toBe("Keep this");
});

test("Vim toggle persists, and bold uses a separate shortcut from the sidebar", async ({
  page,
}) => {
  await native(page);
  await replace(page, "word");
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+Shift+b`);
  await expect(page.locator(".cm-content")).toHaveText("**word**");
  await page.keyboard.press(`${mod}+s`);
  await page.reload();
  await expect(page.locator("#vim-mode")).toBeHidden();
});

test("import copies into the library and export does not change the managed note path", async ({
  page,
}) => {
  await native(page);
  await page.keyboard.press(`${mod}+o`);
  await expect(page.locator("#document-name")).toHaveText("imported");
  await page.keyboard.press(`${mod}+Shift+s`);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls.filter((x: any) => x.command === "save_as")
            .length,
      ),
    )
    .toBe(1);
  await expect(page.locator("#document-name")).toHaveText("imported");
});

test("browser preview keeps its own notes across reloads and can export Markdown", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#document-name")).toHaveText("Untitled");
  await replace(page, "# Browser note\n");
  await page.keyboard.press(`${mod}+s`);
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("Browser note");
  const download = page.waitForEvent("download");
  await page.keyboard.press(`${mod}+Shift+s`);
  expect((await download).suggestedFilename()).toBe("Untitled.md");
});

test("Enter renames a focused sidebar note, commits with Enter, and Escape returns to editing", async ({
  page,
}) => {
  await native(page);
  const row = page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true });
  await row.click();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await page
    .getByRole("textbox", { name: "Rename", exact: true })
    .fill("Renamed");
  await page.keyboard.press("Enter");
  const renamed = page
    .locator("#files")
    .getByRole("button", { name: "Renamed", exact: true });
  await expect(renamed).toBeFocused();
  await expect(page.locator("#document-name")).toHaveText("Renamed");
  expect(await disk(page, "/notes/Renamed.md")).toBe("");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toBeFocused();
});

test("arrow keys navigate folders and Enter renames a folder without moving its note", async ({
  page,
}) => {
  await native(page, {
    "/notes/Untitled.md": "",
    "/notes/work": null,
    "/notes/work/inside.md": "nested",
  });
  const folder = page
    .locator("#files")
    .getByRole("button", { name: "work", exact: true });
  await folder.focus();
  await page.keyboard.press("ArrowRight");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator("#files").getByRole("button", { name: "inside", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(folder).toBeFocused();
  await page.keyboard.press("Enter");
  await page
    .getByRole("textbox", { name: "Rename", exact: true })
    .fill("research");
  await page.keyboard.press("Enter");
  await expect(
    page
      .locator("#files")
      .getByRole("button", { name: "research", exact: true }),
  ).toBeFocused();
  expect(await disk(page, "/notes/research/inside.md")).toBe("nested");
});

test("Vim mode text is informational and the persistent toggle can enable Vim again", async ({
  page,
}) => {
  await native(page);
  await page.keyboard.type("i");
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
  await page.locator("#vim-mode").click();
  await expect(
    page.getByRole("button", { name: "Disable Vim", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
  await page.getByRole("button", { name: "Disable Vim", exact: true }).click();
  const enable = page.getByRole("button", { name: "Enable Vim", exact: true });
  await expect(enable).toBeVisible();
  await expect(enable).toHaveText("vim:off");
  await expect(page.locator("#vim-mode")).toBeHidden();
  await page.reload();
  await expect(enable).toBeVisible();
  await enable.click();
  await expect(
    page.getByRole("button", { name: "Disable Vim", exact: true }),
  ).toHaveText("vim:on");
  await expect(page.locator("#vim-mode")).toHaveText("[normal]");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toBeFocused();
});

async function protect(page: Page, password = "test-only password") {
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click({ button: "right" });
  await page.getByRole("button", { name: "Set password", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page
    .locator("#password-dialog")
    .getByRole("button", { name: "Set password", exact: true })
    .click();
  await expect(page.locator("#password-dialog")).toBeHidden();
}
test("Ctrl+W saves and closes the single note without making another note or quitting", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Keep on close");
  await page.keyboard.press("Control+w");
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#document-name")).toBeHidden();
  expect(await disk(page)).toBe("Keep on close");
  expect(
    await page.evaluate(() =>
      (window as any).calls.some((x: any) => x.command === "quit"),
    ),
  ).toBe(false);
  await page.reload();
  await expect(page.locator("#editor")).toBeHidden();
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click();
  await expect(page.locator(".cm-content")).toHaveText("Keep on close");
});
test("right click sets a password, close locks it, and wrong passwords never reveal contents", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Private thought");
  await protect(page);
  expect(await disk(page)).toBeUndefined();
  expect(await disk(page, "/notes/Untitled.textlock")).toBe("encrypted");
  await page.keyboard.press("Control+w");
  await expect(page.locator("#editor")).toBeHidden();
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click();
  await expect(page.locator("#password-dialog")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("#password-error")).toContainText(
    "Incorrect password",
  );
  await expect(page.locator(".cm-content")).toHaveText("");
  await page.getByLabel("Password", { exact: true }).fill("test-only password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("Private thought");
  await replace(page, "Saved while protected");
  await page.keyboard.press(`${mod}+s`);
  await page.keyboard.press("Control+w");
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click();
  await page.getByLabel("Password", { exact: true }).fill("test-only password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("Saved while protected");
});
test("password confirmation, cancellation, and removal keep the correct note", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Protected later");
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click({ button: "right" });
  await page.getByRole("button", { name: "Set password", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("one");
  await page.getByLabel("Confirm password", { exact: true }).fill("two");
  await page
    .locator("#password-dialog")
    .getByRole("button", { name: "Set password", exact: true })
    .click();
  await expect(page.locator("#password-error")).toContainText("do not match");
  await page
    .locator("#password-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(await disk(page)).toBe("Protected later");
  await protect(page);
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("button", { name: "Remove password", exact: true })
    .click();
  await expect.poll(() => disk(page)).toBe("Protected later");
  expect(await disk(page, "/notes/Untitled.textlock")).toBeUndefined();
  await page.keyboard.press("Control+w");
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click();
  await expect(page.locator("#password-dialog")).toBeHidden();
  await expect(page.locator(".cm-content")).toHaveText("Protected later");
});
test("application restart and switching notes do not remember an unlock", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Private");
  await protect(page);
  await page.reload();
  await expect(page.locator("#editor")).toBeHidden();
  await page
    .locator("#files")
    .getByRole("button", { name: "Untitled", exact: true })
    .click();
  await page.getByLabel("Password", { exact: true }).fill("test-only password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.keyboard.press(`${mod}+n`);
  await expect(page.locator("#document-name")).toHaveText("Untitled 2");
  await page
    .locator('#files .file-row[data-path="/notes/Untitled.textlock"]')
    .click();
  await expect(page.locator("#password-dialog")).toBeVisible();
});
test("native Close Note menu event closes the note and protected exports are explicit", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Private");
  await protect(page);
  await page.keyboard.press(`${mod}+Shift+s`);
  await expect(page.locator("#export-warning")).toBeVisible();
  await page
    .locator("#export-warning")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      (window as any).calls.some((x: any) => x.command === "save_as"),
    ),
  ).toBe(false);
  await page.evaluate(() => (window as any).fireCloseNote());
  await expect(page.locator("#editor")).toBeHidden();
});
test("closing a protected note clears editor undo and Vim registers", async ({
  page,
}) => {
  await native(page);
  await replace(page, "Secret in a register");
  await protect(page);
  await page.keyboard.press(`${mod}+Alt+v`);
  await page.keyboard.type("ggyy");
  await page.keyboard.press("Control+w");
  await page.keyboard.press(`${mod}+n`);
  await page.keyboard.type("p");
  await page.keyboard.type("u");
  await expect(page.locator(".cm-content")).not.toContainText("Secret");
});


const fileRow = (page: Page, path: string) => page.locator(`.file-row[data-path="${path}"]`);

test("drag a note into a collapsed folder and back to the root, preserving edits and restart path", async ({ page }) => {
  await native(page, { "/notes/Untitled.md": "", "/notes/work": null });
  await replace(page, "Pending before moving");
  await fileRow(page, "/notes/Untitled.md").dragTo(fileRow(page, "/notes/work"));
  await expect(fileRow(page, "/notes/work/Untitled.md")).toBeVisible();
  await expect(fileRow(page, "/notes/work")).toHaveAttribute("aria-expanded", "true");
  expect(await disk(page, "/notes/work/Untitled.md")).toBe("Pending before moving");
  expect(await disk(page)).toBeUndefined();
  await replace(page, "Edited after moving");
  await page.keyboard.press(`${mod}+s`);
  await page.reload();
  await expect(page.locator(".cm-content")).toHaveText("Edited after moving");
  await fileRow(page, "/notes/work/Untitled.md").dragTo(page.locator("#files"), {
    targetPosition: { x: 80, y: 250 },
  });
  await expect(fileRow(page, "/notes/Untitled.md")).toBeVisible();
  expect(await disk(page)).toBe("Edited after moving");
  await expect(page.locator(".drop-target")).toHaveCount(0);
});

test("moving a folder keeps the open descendant editable and follows it on restart", async ({ page }) => {
  await native(page, {
    "/notes/work": null, "/notes/work/active.md": "nested",
    "/notes/archive": null,
  });
  await replace(page, "Saved inside the moved folder");
  await fileRow(page, "/notes/work").dragTo(fileRow(page, "/notes/archive"));
  await expect(fileRow(page, "/notes/archive/work/active.md")).toBeVisible();
  await replace(page, "Still editable");
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page, "/notes/archive/work/active.md")).toBe("Still editable");
  expect(await disk(page, "/notes/work/active.md")).toBeUndefined();
  await page.reload();
  await expect(page.locator(".cm-content")).toHaveText("Still editable");
});

test("dragging a closed password note moves it without unlocking and keeps the password", async ({ page }) => {
  await native(page, { "/notes/Untitled.md": "secret", "/notes/work": null });
  await protect(page);
  await page.keyboard.press("Control+w");
  await fileRow(page, "/notes/Untitled.textlock").dragTo(fileRow(page, "/notes/work"));
  await expect(fileRow(page, "/notes/work/Untitled.textlock")).toBeVisible();
  await expect(page.locator("#password-dialog")).toBeHidden();
  await expect(page.locator("#editor")).toBeHidden();
  expect(await disk(page, "/notes/work/Untitled.textlock")).toBe("encrypted");
  await fileRow(page, "/notes/work/Untitled.textlock").click();
  await expect(page.locator("#password-dialog")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("test-only password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("secret");
  await replace(page, "Still protected after moving");
  await page.keyboard.press(`${mod}+s`);
  await page.keyboard.press("Control+w");
  await fileRow(page, "/notes/work/Untitled.textlock").click();
  await expect(page.locator("#password-dialog")).toBeVisible();
});

test("drop collisions preserve both notes and folders cannot be dropped into descendants", async ({ page }) => {
  await native(page, {
    "/notes/Untitled.md": "source", "/notes/work": null,
    "/notes/work/Untitled.md": "destination", "/notes/work/sub": null,
  });
  await fileRow(page, "/notes/Untitled.md").dragTo(fileRow(page, "/notes/work"));
  await expect(page.locator("#notice")).toContainText("already exists");
  expect(await disk(page)).toBe("source");
  expect(await disk(page, "/notes/work/Untitled.md")).toBe("destination");
  await fileRow(page, "/notes/work").click();
  await fileRow(page, "/notes/work").dragTo(fileRow(page, "/notes/work/sub"));
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "move_entry").length)).toBe(1);
  expect(await disk(page, "/notes/work")).toBeNull();
  await expect(page.locator(".drop-target")).toHaveCount(0);
});

test("a failed save prevents moving the current note", async ({ page }) => {
  await native(page, { "/notes/Untitled.md": "before", "/notes/work": null });
  await page.evaluate(() => { (window as any).testFiles["/notes/Untitled.md"] = "external"; });
  await replace(page, "my pending edits");
  await fileRow(page, "/notes/Untitled.md").dragTo(fileRow(page, "/notes/work"));
  await expect(page.locator("#notice")).toContainText("changed on disk");
  expect(await disk(page)).toBe("external");
  expect(await disk(page, "/notes/work/Untitled.md")).toBeUndefined();
  await expect(page.locator(".cm-content")).toHaveText("my pending edits");
});

test("browser preview also persists note moves", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("notes:preview-library")) localStorage.setItem("notes:preview-library", JSON.stringify({
      "/notes/Untitled.md": "preview", "/notes/work": null,
    }));
  });
  await page.goto("/");
  await fileRow(page, "/notes/Untitled.md").dragTo(fileRow(page, "/notes/work"));
  await expect(fileRow(page, "/notes/work/Untitled.md")).toBeVisible();
  await page.reload();
  await expect(page.locator(".cm-content")).toHaveText("preview");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("notes:preview-library")!)["/notes/work/Untitled.md"])).toBe("preview");
});


test("F1 opens the shortcut reference and Escape restores editing without changing Vim or content", async ({ page }) => {
  await native(page);
  await page.keyboard.type("iKeep this");
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Toggle sidebar");
  await expect(dialog).toContainText("Toggle Vim");
  await expect(dialog).toContainText("Enter / F2");
  await expect(dialog).toContainText(":mkdir Name");
  await page.evaluate(() => (window as any).fireCloseNote());
  await page.keyboard.press("Control+w");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Markdown editor" })).toBeFocused();
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
  await page.keyboard.type(" writing");
  await expect(page.locator(".cm-content")).toHaveText("Keep this writing");
});

test("native Help menu opens shortcuts and leaves a rename dialog alone", async ({ page }) => {
  await native(page);
  const row = fileRow(page, "/notes/Untitled.md");
  await row.focus();
  await page.evaluate(() => (window as any).fireShortcuts());
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.getByRole("button", { name: "Close shortcuts" }).click();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#name-dialog")).toBeVisible();
  await page.keyboard.press("F1");
  await page.evaluate(() => (window as any).fireShortcuts());
  await expect(page.locator("#shortcuts-dialog")).toBeHidden();
  await expect(page.locator("#name-dialog")).toBeVisible();
});


test("inline math renders after closing dollar and space without Enter, and clicking edits the source", async ({ page }) => {
  await native(page);
  await replace(page, "$E=mc^2$");
  await expect(page.locator(".math-inline")).toHaveCount(0);
  await page.keyboard.type(" ");
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await expect(page.locator(".cm-line")).toHaveCount(1);
  await page.keyboard.type("and $x^2$");
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await page.keyboard.type(" ");
  await expect(page.locator(".math-inline .katex")).toHaveCount(2);
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe("$E=mc^2$ and $x^2$ ");
  await page.locator(".math-inline").first().click();
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toContainText("$E=mc^2$");
  await page.keyboard.press("End");
  await expect(page.locator(".math-inline .katex")).toHaveCount(2);
});

test("inline math stays rendered on the following space in Vim normal mode", async ({ page }) => {
  await native(page);
  await page.keyboard.type("i$x^2$");
  await expect(page.locator(".math-inline")).toHaveCount(0);
  await page.keyboard.type(" ");
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#vim-mode")).toHaveText("[normal]");
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await page.keyboard.press("h");
  await expect(page.locator(".math-inline")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("$x^2$");
});


async function getInfo(page: Page, path: string) {
  await fileRow(page, path).click({ button: "right" });
  await page.getByRole("button", { name: "Get Info", exact: true }).click();
  return page.getByRole("dialog", { name: "Get Info", exact: true });
}

test("Get Info reports disk metadata for another note without switching the editor", async ({ page }) => {
  await native(page, { "/notes/Untitled.md": "keep editing", "/notes/other.md": "é" });
  await fileRow(page, "/notes/Untitled.md").click();
  await expect(page.locator("#document-name")).toHaveText("Untitled");
  const dialog = await getInfo(page, "/notes/other.md");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#info-name")).toHaveText("other.md");
  await expect(dialog.locator("dt", { hasText: "Location" }).locator("+ dd")).toHaveText("/notes/other.md");
  await expect(dialog.locator("dt", { hasText: "Size" }).locator("+ dd")).toHaveText("2 bytes");
  await expect(dialog.locator("dt", { hasText: "Created" }).locator("+ dd")).not.toHaveText("Unavailable");
  await expect(dialog.locator("dt", { hasText: "Modified" }).locator("+ dd")).not.toHaveText("Unavailable");
  await expect(dialog.locator("dt", { hasText: "Password" }).locator("+ dd")).toHaveText("None");
  await expect(page.locator("#document-name")).toHaveText("Untitled");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(fileRow(page, "/notes/other.md")).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("keep editing");
});

test("Get Info inspects a locked note without asking for or remembering a password", async ({ page }) => {
  await native(page);
  await replace(page, "Secret content");
  await protect(page);
  await page.keyboard.press("Control+w");
  const dialog = await getInfo(page, "/notes/Untitled.textlock");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("dt", { hasText: "Password" }).locator("+ dd")).toHaveText("Protected");
  await expect(dialog).toContainText("Encrypted note");
  await expect(dialog).not.toContainText("Secret content");
  await expect(page.locator("#password-dialog")).toBeHidden();
  await expect(page.locator("#editor")).toBeHidden();
  await page.getByRole("button", { name: "Close info" }).click();
  await fileRow(page, "/notes/Untitled.textlock").click();
  await expect(page.locator("#password-dialog")).toBeVisible();
});

test("browser Get Info identifies preview storage and does not invent filesystem dates", async ({ page }) => {
  await page.goto("/");
  const dialog = await getInfo(page, "/notes/Untitled.md");
  await expect(dialog).toContainText("Browser storage: /notes/Untitled.md");
  await expect(dialog.locator("dt", { hasText: "Created" }).locator("+ dd")).toHaveText("Unavailable");
  await expect(dialog.locator("dt", { hasText: "Modified" }).locator("+ dd")).toHaveText("Unavailable");
});

test("text zoom scales prose, headings, code and equations while leaving the app unchanged", async ({ page }) => {
  await native(page);
  const source = "# Heading\n\n$x^2$ \n\n```\ncode\n```\n\n";
  await replace(page, source);
  const sizes = () => page.evaluate(() => {
    const font = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
    return { editor: font(".cm-scroller"), heading: font(".md-h1"), code: font(".md-code-line"), math: font(".katex"),
      sidebar: font("#sidebar"), header: font("#document-name"), width: document.querySelector("#sidebar")!.getBoundingClientRect().width, viewport: innerWidth };
  });
  const before = await sizes();
  await page.keyboard.press(`${mod}+=`);
  const after = await sizes();
  expect(after.editor).toBe(14);
  for (const key of ["heading", "code", "math"] as const) expect(after[key] / before[key]).toBeCloseTo(14 / 13, 3);
  for (const key of ["sidebar", "header", "width", "viewport"] as const) expect(after[key]).toBe(before[key]);
  await expect(page.locator("#notice")).toBeHidden();
  await page.keyboard.press(`${mod}+s`);
  expect(await disk(page)).toBe(source);
  await page.reload();
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "14px");
  await page.keyboard.press(`${mod}+-`);
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "13px");
  await page.keyboard.press(`${mod}+=`);
  await page.keyboard.press(`${mod}+0`);
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "13px");
});

test("View text-size actions work in Vim and stay out of dialogs", async ({ page }) => {
  await native(page);
  await page.keyboard.type("i");
  await page.evaluate(() => (window as any).fireTextSize(1));
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "14px");
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
  await page.keyboard.press(`${mod}+=`);
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "15px");
  await page.keyboard.press("F1");
  await page.evaluate(() => (window as any).fireTextSize(1));
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "15px");
  await expect(page.locator("#shortcuts-dialog")).toContainText("Text size");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).fireTextSize(0));
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "13px");
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
});

test("Vim block cursor scales immediately with text zoom on an empty line", async ({ page }) => {
  await native(page);
  const cursor = page.locator(".cm-fat-cursor");
  await expect(cursor).toHaveCount(1);
  const before = await cursor.boundingBox();
  expect(before).not.toBeNull();
  for (let i = 0; i < 8; i++) await page.keyboard.press(`${mod}+=`);
  await expect(page.locator(".cm-scroller")).toHaveCSS("font-size", "21px");
  await expect(cursor).toHaveCSS("font-size", "21px");
  await expect.poll(async () => (await cursor.boundingBox())!.height).toBeGreaterThan(before!.height * 1.4);
  expect((await cursor.boundingBox())!.width).toBeGreaterThan(before!.width * 1.4);
  await expect(page.locator("#vim-mode")).toHaveText("[normal]");
  await expect(page.locator(".cm-content")).toHaveText("");
  await page.keyboard.press(`${mod}+0`);
  await expect(cursor).toHaveCSS("font-size", "13px");
  await expect.poll(async () => (await cursor.boundingBox())!.height).toBeCloseTo(before!.height, 0);
  await page.keyboard.press(`${mod}+=`);
  await page.keyboard.press(`${mod}+n`);
  await expect(page.locator("#document-name")).toHaveText("Untitled 2");
  await expect(cursor).toHaveCSS("font-size", "14px");
});

test("insert cursor resizes without moving the caret or changing text", async ({ page }) => {
  await native(page, { "/notes/Untitled.md": "abc" });
  await page.keyboard.type("i");
  const cursor = page.locator(".cm-cursorLayer:not(.cm-vimCursorLayer) .cm-cursor").first();
  await expect(cursor).toHaveCount(1);
  const before = await cursor.boundingBox();
  for (let i = 0; i < 8; i++) await page.keyboard.press(`${mod}+=`);
  await expect.poll(async () => (await cursor.boundingBox())!.height).toBeGreaterThan(before!.height * 1.4);
  await page.keyboard.type("X");
  await expect(page.locator(".cm-content")).toHaveText("Xabc");
  await expect(page.locator("#vim-mode")).toHaveText("[insert]");
  await page.keyboard.press(`${mod}+Alt+v`);
  await page.keyboard.press(`${mod}+0`);
  await expect.poll(async () => (await cursor.boundingBox())!.height).toBeCloseTo(before!.height, 0);
  await page.keyboard.type("Y");
  await expect(page.locator(".cm-content")).toHaveText("XYabc");
});


test("updates report current version and recover from check errors", async ({ page }) => {
  await native(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
      if (command === "plugin:updater|check") {
        if (w.failUpdateCheck) return Promise.reject("Network unavailable");
        return Promise.resolve(null);
      }
      return original(command, args);
    };
  });
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(page.locator("#update-status")).toHaveText("You’re up to date.");
  await page.locator("#update-close").click();
  await page.evaluate(() => { (window as any).failUpdateCheck = true; });
  await page.locator("#check-updates").click();
  await expect(page.locator("#update-status")).toContainText("Network unavailable");
  await expect(page.locator("#update-close")).toBeEnabled();
});

async function availableUpdate(page: Page, failSave = false) {
  await native(page);
  await page.evaluate(({ failSave }) => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
      if (command === "plugin:updater|check") return Promise.resolve({
        rid: 42, version: "0.1.8", currentVersion: "0.1.7", body: "<script>untrusted</script>",
      });
      if (command === "save_file" && failSave) return Promise.reject("Disk unavailable");
      return original(command, args);
    };
  }, { failSave });
}

test("update installs only on request after saving and then restarts", async ({ page }) => {
  await availableUpdate(page);
  await replace(page, "Saved before update");
  await page.locator("#check-updates").click();
  await expect(page.locator("#update-status")).toContainText("0.1.8");
  await expect(page.locator("#update-notes")).toHaveText("<script>untrusted</script>");
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.command === "plugin:updater|download_and_install"))).toBe(false);
  await page.locator("#update-install").click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.some((c: any) => c.command === "restart_after_update"))).toBe(true);
  const commands = await page.evaluate(() => (window as any).calls.map((c: any) => c.command));
  expect(commands.indexOf("save_file")).toBeLessThan(commands.indexOf("plugin:updater|download_and_install"));
  expect(commands.indexOf("plugin:updater|download_and_install")).toBeLessThan(commands.indexOf("restart_after_update"));
});

test("update does not install if saving the current note fails", async ({ page }) => {
  await availableUpdate(page, true);
  await replace(page, "Keep my unsaved note");
  await page.locator("#check-updates").click();
  await page.locator("#update-install").click();
  await expect(page.locator("#update-status")).toContainText("Couldn’t save your note");
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.command === "plugin:updater|download_and_install" || c.command === "restart_after_update"))).toBe(false);
});

test("browser preview hides desktop updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#check-updates")).toBeHidden();
});


test("def.tex provides shared inline, display and argument macros across notes", async ({ page }) => {
  const preamble = String.raw`% Shared notation
\newcommand{\custom}{A}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}`;
  const content = "Inline $\\custom$ and $\\norm{x}$.\n\n$$\n\\custom\n$$\n\nEnd";
  await native(page, {
    "/notes/First.md": content,
    "/notes/Other.md": content,
    "/notes/def.tex": preamble,
  });
  await expect(page.locator(".math-inline .katex")).toHaveCount(2);
  await expect(page.locator(".math-block .katex")).toHaveCount(1);
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await expect(page.locator(".math-inline .katex-html").first()).toHaveText("A");
  await expect(page.locator("#files")).not.toContainText("def.tex");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(page.locator(".math-inline .katex-html").first()).toHaveText("A");
  expect(await page.evaluate(() => (window as any).testFiles["/notes/Other.md"])).toBe(content);
  await page.keyboard.press("F1");
  await expect(page.locator("#shortcuts-dialog")).not.toContainText("def.tex");
});

test("def.tex reloads on focus, keeps valid definitions on error and clears on removal", async ({ page }) => {
  await native(page, {
    "/notes/First.md": "Inline $\\custom$ and ordinary $x^2$.\n\nEnd",
    "/notes/def.tex": String.raw`\def\custom{A}`,
  });
  const rendered = page.locator(".math-inline .katex-html").first();
  await expect(rendered).toHaveText("A");
  await page.evaluate(() => {
    (window as any).testFiles["/notes/def.tex"] = String.raw`\def\custom{B}`;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(rendered).toHaveText("B");
  await page.evaluate(() => {
    (window as any).testFiles["/notes/def.tex"] = String.raw`\newcommand{\broken}{`;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator("#notice")).toContainText("Couldn’t load def.tex");
  await expect(rendered).toHaveText("B");
  await page.evaluate(() => {
    delete (window as any).testFiles["/notes/def.tex"];
    window.dispatchEvent(new Event("focus"));
  });
  await expect(rendered).toHaveText(String.raw`\custom`);
  await expect(page.locator(".math-inline .katex-html").nth(1)).toContainText("x");
  await expect(page.locator("#notice")).toBeHidden();
});

test("invalid initial def.tex does not prevent ordinary math or opening notes", async ({ page }) => {
  await native(page, {
    "/notes/First.md": "Ordinary $x^2$.\n\nEnd",
    "/notes/def.tex": String.raw`\usepackage{amsmath}`,
  });
  await expect(page.locator("#notice")).toContainText("Couldn’t load def.tex");
  await expect(page.locator(".math-inline .katex")).toHaveCount(1);
  await expect(page.locator(".katex-error")).toHaveCount(0);
});


async function openLatexNotation(page: Page) {
  await page.evaluate(() => (window as any).fireLatexNotation());
  await expect(page.locator("#latex-notation-source")).toBeEnabled();
}

test("LaTeX notation menu creates def.tex and refreshes notes immediately", async ({ page }) => {
  const note = "Use $\\custom$ here.\n\nEnd";
  await native(page, { "/notes/First.md": note });
  await openLatexNotation(page);
  const source = page.getByRole("textbox", { name: "Definitions", exact: true });
  await expect(source).toHaveValue("");
  await expect(source).toHaveAttribute("placeholder", /newcommand/);
  const definitions = String.raw`\newcommand{\custom}{A}`;
  await source.fill(definitions);
  await source.press(`${mod}+s`);
  await expect(page.locator("#latex-notation-dialog")).not.toBeVisible();
  await expect(page.locator(".math-inline .katex-html")).toHaveText("A");
  expect(await page.evaluate(() => (window as any).testFiles["/notes/def.tex"])).toBe(definitions);
  expect(await page.evaluate(() => (window as any).testFiles["/notes/First.md"])).toBe(note);
  await openLatexNotation(page);
  await expect(source).toHaveValue(definitions);
  await source.fill("");
  await page.locator("#latex-notation-save").click();
  await expect(page.locator(".math-inline .katex-html")).toHaveText(String.raw`\custom`);
});

test("LaTeX notation editor rejects invalid definitions and Cancel creates no file", async ({ page }) => {
  await native(page);
  await openLatexNotation(page);
  await page.locator("#latex-notation-source").fill(String.raw`\newcommand{\broken}{`);
  await page.locator("#latex-notation-save").click();
  await expect(page.locator("#latex-notation-error")).toBeVisible();
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.command === "save_latex_definitions"))).toBe(false);
  await page.locator("#latex-notation-cancel").click();
  expect(await page.evaluate(() => (window as any).testFiles["/notes/def.tex"])).toBeUndefined();
  await openLatexNotation(page);
  await expect(page.locator("#latex-notation-source")).toHaveValue("");
});

test("LaTeX notation editor preserves an externally changed def.tex", async ({ page }) => {
  await native(page, {
    "/notes/First.md": "Ordinary $x^2$.\n\nEnd",
    "/notes/def.tex": String.raw`\def\custom{A}`,
  });
  await openLatexNotation(page);
  await page.locator("#latex-notation-source").fill(String.raw`\def\custom{B}`);
  await page.evaluate(() => { (window as any).testFiles["/notes/def.tex"] = String.raw`\def\custom{C}`; });
  await page.locator("#latex-notation-save").click();
  await expect(page.locator("#latex-notation-error")).toContainText("changed elsewhere");
  expect(await page.evaluate(() => (window as any).testFiles["/notes/def.tex"])).toBe(String.raw`\def\custom{C}`);
  await page.locator("#latex-notation-cancel").click();
  await openLatexNotation(page);
  await expect(page.locator("#latex-notation-source")).toHaveValue(String.raw`\def\custom{C}`);
});


test("F1 Help opens the LaTeX notation editor directly", async ({ page }) => {
  await native(page);
  await page.keyboard.press("F1");
  await expect(page.locator("#shortcuts-dialog")).toBeVisible();
  await page.getByRole("button", { name: "LaTeX notation…", exact: true }).click();
  await expect(page.locator("#shortcuts-dialog")).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "Definitions", exact: true })).toBeEnabled();
  await expect(page.locator("#latex-notation-dialog")).toBeVisible();
});
