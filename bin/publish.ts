import { execSync } from "child_process";

execSync("cd dist && bun publish", { stdio: 'inherit' })