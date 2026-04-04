import fs from "fs";

const manifestPath = "manifest.json";
const packagePath = "package.json";
const versionsPath = "versions.json";

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));

packageJson.version = manifest.version;
versions[manifest.version] = manifest.minAppVersion;

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
