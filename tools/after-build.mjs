// electron-builder afterAllArtifactBuild hook: the packed exe has the protection package.json build.electronFuses asks for.
// This runs after the installer and the portable exe are built from win-unpacked, which is the first time the fuses are
// in the exe (they are flipped after afterPack), so the check cannot live in tools/after-pack.mjs. A build that failed it
// exits with an error: nothing built from it is to be published.
import path from "node:path";
import { existsSync } from "node:fs";
import { packedWrong } from "./fuses.mjs";

export default async function afterAllArtifactBuild(result) {
    const wanted = result.configuration?.electronFuses;
    if (!wanted) throw new Error("afterAllArtifactBuild: build.electronFuses is not set, the exe would ship with every fuse open");
    const dir = path.join(result.outDir, "win-unpacked");
    const exe = path.join(dir, `${result.configuration.productName}.exe`);
    if (!existsSync(exe)) throw new Error(`afterAllArtifactBuild: ${exe} is not there to check`);
    const wrong = await packedWrong(exe, path.join(dir, "resources", "app.asar"), wanted);
    if (wrong) throw new Error(`afterAllArtifactBuild: ${wrong}`);
    console.log(`  • afterAllArtifactBuild: fuses and asar integrity as wanted in ${path.basename(exe)}`);
    return [];
}
