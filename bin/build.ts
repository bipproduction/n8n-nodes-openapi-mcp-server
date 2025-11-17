
import { execSync } from "node:child_process";
import { readdir, rm, mkdir, cp } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

const SRC = "src";
const DIST = "dist";

const ASSET_EXT = [
    ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".json", ".html", ".css", ".txt", ".ico", ".md"
];

// Recursively scan directory tree
async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walk(full));
        } else {
            files.push(full);
        }
    }

    return files;
}

async function build() {
    console.log("🧹 Cleaning dist/...");

    await rm(DIST, { recursive: true, force: true });
    await mkdir(DIST, { recursive: true });

    console.log("🔍 Scanning src/...");

    const allFiles = await walk(SRC);

    const tsFiles = allFiles.filter(f =>
        f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js")
    );

    const assets = allFiles.filter(f =>
        ASSET_EXT.some(ext => f.toLowerCase().endsWith(ext))
    );

    console.log("⚡ Building & Minifying TypeScript...");

    for (const file of tsFiles) {
        const rel = relative(SRC, file);
        const outDir = join(DIST, dirname(rel));

        await mkdir(outDir, { recursive: true });

        await Bun.build({
            entrypoints: [file],
            outdir: outDir,
            splitting: false,
            minify: true,       // ← minify otomatis
            sourcemap: "external",
            target: "browser"
        });

        console.log("  ✔ Built:", rel);
    }

    console.log("📁 Copying assets...");

    for (const file of assets) {
        const rel = relative(SRC, file);
        const dest = join(DIST, rel);

        await mkdir(dirname(dest), { recursive: true });
        await cp(file, dest);

        console.log("  ✔ Copied:", rel);
    }

    console.log("🎉 Build complete!");
}

execSync("git add -A", { stdio: 'inherit' })
execSync("git commit -m 'build'", { stdio: 'inherit' })
build()

