// Where the app keeps the files it makes, inside Documents. The app was renamed twice; whoever already has the folder
// of an older version keeps their maps there (the oldest first), everyone else gets the folder of the current name.
import path from "node:path";

export const DOCS_FOLDER = "Lunacy mania";
export const OLD_DOCS_FOLDERS = ["Анализатор данов", "Sneezey's dan calculator"];

// documents: the Documents path; exists(dir) → boolean (fs.existsSync in the app)
export function pickDocsDir(documents, exists) {
    for (const name of OLD_DOCS_FOLDERS) {
        const dir = path.join(documents, name);
        if (exists(dir)) return dir;
    }
    return path.join(documents, DOCS_FOLDER);
}
