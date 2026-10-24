import { readFileSync, writeFileSync } from "node:fs";
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const version = read("package.json").version;
const config = read("src-tauri/tauri.conf.json");
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "([^"]+)"/m)?.[1];
if (config.version !== version || cargo !== version || process.env.GITHUB_REF_NAME !== `v${version}`)
  throw new Error("Tag, package.json, Cargo.toml and tauri.conf.json versions must match.");
if (!process.env.UPDATE_PUBLIC_KEY?.trim() || !process.env.SIGNING_KEY?.trim())
  throw new Error("Set TAURI_UPDATER_PUBLIC_KEY repository variable and TAURI_SIGNING_PRIVATE_KEY secret first.");
writeFileSync("src-tauri/tauri.release.conf.json", JSON.stringify({
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey: process.env.UPDATE_PUBLIC_KEY.trim() } },
}));
