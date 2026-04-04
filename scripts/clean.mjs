import fs from "fs";
import path from "path";

const rootDir = process.cwd();

for (const relativePath of ["build", "dist"]) {
  fs.rmSync(path.join(rootDir, relativePath), { recursive: true, force: true });
}
