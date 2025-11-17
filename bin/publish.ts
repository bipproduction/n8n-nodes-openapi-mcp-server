import { execSync } from "child_process";

execSync("git add -A", { stdio: 'inherit' })
execSync("git commit -m 'publish'", { stdio: 'inherit' })
execSync("git push", { stdio: 'inherit' })
execSync("cd dist && npm publish", { stdio: 'inherit' })