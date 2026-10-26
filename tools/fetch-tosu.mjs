// Downloads the pinned tosu release into vendor/tosu/ and verifies its sha256, plus tosu's LICENSE (LGPL-3.0) from the
// same tag, which ships next to tosu.exe in the build. A vendor/tosu that already holds this version only gets the LICENSE.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const VERSION = "v4.26.3";
const URL = `https://github.com/tosuapp/tosu/releases/download/${VERSION}/tosu-windows-${VERSION}.zip`;
const SHA256 = "700063da6377c5f69985e09b0d30d575d27653519d7a3b1154bc11f1f9bd5752";
const LICENSE_URL = `https://raw.githubusercontent.com/tosuapp/tosu/${VERSION}/LICENSE`;
const LICENSE_SHA256 = "cc1ea9718b312d17c286c953768912c0136299f5328b87c2d4be1fac6cc7c4b4";
const target = path.resolve("vendor/tosu");

async function download(url, sha256) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const body = Buffer.from(await res.arrayBuffer());
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== sha256) throw new Error(`sha256 mismatch: ${digest} ${url}`);
    return body;
}

const versionFile = path.join(target, "VERSION");
const have = existsSync(versionFile) && readFileSync(versionFile, "utf8").trim() === VERSION && existsSync(path.join(target, "tosu.exe"));
mkdirSync(target, { recursive: true });
if (!have) {
    const zip = await download(URL, SHA256);
    const zipPath = path.join(target, `tosu-${VERSION}.zip`);
    writeFileSync(zipPath, zip);
    // Windows' own bsdtar (System32) extracts zip archives; GNU tar from Git Bash would treat "C:" as a host.
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zipPath, "-C", target]);
    writeFileSync(versionFile, VERSION + "\n");
    if (!existsSync(path.join(target, "tosu.exe"))) throw new Error("tosu.exe not found after extraction");
}
writeFileSync(path.join(target, "LICENSE"), await download(LICENSE_URL, LICENSE_SHA256));
console.log(`tosu ${VERSION}${have ? " (already there)" : ""} + LICENSE → ${target}`);
