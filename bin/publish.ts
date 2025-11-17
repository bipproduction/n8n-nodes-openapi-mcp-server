import { execSync } from "child_process";

execSync("npm publish", { stdio: 'inherit' })