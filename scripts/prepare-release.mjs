import crypto from "crypto";
import fs from "fs";
import path from "path";

const rootDir = process.cwd();
const buildDir = path.join(rootDir, "build");
const releaseDir = path.join(rootDir, "build", "release");
const manifestPath = path.join(rootDir, "manifest.json");
const stylesPath = path.join(rootDir, "styles.css");
const builtMainPath = path.join(buildDir, "main.js");

if (!fs.existsSync(builtMainPath)) {
  throw new Error("Built plugin bundle not found at build/main.js. Run `npm run build` first.");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = manifest.version;

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

fs.copyFileSync(manifestPath, path.join(releaseDir, "manifest.json"));
fs.copyFileSync(stylesPath, path.join(releaseDir, "styles.css"));
fs.copyFileSync(builtMainPath, path.join(releaseDir, "main.js"));

const checksums = [
  "manifest.json",
  "styles.css",
  "main.js",
].map((fileName) => {
  const filePath = path.join(releaseDir, fileName);
  const buffer = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return `${hash}  ${fileName}`;
}).join("\n");

fs.writeFileSync(path.join(releaseDir, `checksums-${version}.txt`), `${checksums}\n`);

console.log(`Release assets prepared in ${releaseDir}`);
