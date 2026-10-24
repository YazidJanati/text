# App installation and rebuilds

The user requires a single installed copy of this app. Never duplicate the app.

- The only permanent, launchable app is `/Applications/text.app`. The source repository is `/Applications/text`; these are different paths.
- Always update `/Applications/text.app` in place. Never leave additional `.app` copies, aliases, or symlinks in chat outputs, Documents, Desktop, Downloads, or old task folders. Do not deliver another app archive unless the user explicitly requests an archive.
- A build may temporarily generate `src-tauri/target/release/bundle/macos/text.app`. Treat it only as staging: verify and install the new build, then remove the staging app bundle. Never launch the staging copy.
- Before replacing the installed app, identify any running copies by their executable paths. Quit them through the app's normal save-aware Quit command. Do not force-kill the app or discard unsaved edits. If saving is blocked, resolve it before proceeding.
- Keep the existing installed app usable until the replacement build is ready. Apply the local ad-hoc signature when needed, verify the installed bundle with `codesign --verify --deep --strict`, and launch only `/Applications/text.app`.
- Verify that exactly one instance is running from `/Applications/text.app/Contents/MacOS/text`. If the task changes visible behavior, inspect the installed app to confirm the behavior appears there before saying it is ready.
- Remove any temporary app copies created during the task after the installed app is verified. Do not create a second copy as a workaround for launch, signing, or update problems.
- App cleanup must never remove the user's notes, encrypted notes, private-folder password file, preferences, or other application data. Those live outside the app bundle.
- Do not bump the version, create a tag, or publish a release unless the user explicitly requests it. A local rebuild does not require a new release.
