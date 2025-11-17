import { execSync } from "child_process";

execSync("cd dist && npm publish", { stdio: 'inherit' })