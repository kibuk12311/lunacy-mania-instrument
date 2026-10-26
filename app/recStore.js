// The picks tab's files in userData: favourites.json (up to 500 maps) and picks.json (the journal of picked maps,
// up to 1000). Each is one jsonStore, so writes go one after another; a broken file reads as empty. Only main writes them.
import path from "node:path";
import { createJsonStore } from "./jsonStore.js";
import { parseFavourites, addFavourite, removeFavourite, withMd5, parsePicks, addPick } from "../src/recommend/favourites.js";

export function createRecStore({ dir, fs = undefined, now = Date.now }) {
    // made on first use, so creating the store (when the tab registers) touches nothing
    let fav = null;
    let picks = null;
    const options = (name, normalize) => ({ file: path.join(String(dir), name), normalize, fallback: null, ...(fs ? { fs } : {}) });
    const favStore = () => (fav ??= createJsonStore(options("favourites.json", parseFavourites)));
    const pickStore = () => (picks ??= createJsonStore(options("picks.json", parsePicks)));
    const items = (doc) => doc.items;

    return {
        favourites: {
            list: async () => items(await favStore().get()),
            add: async (card) => items(await favStore().update((doc) => addFavourite(doc, card, now()))),
            remove: async (beatmapId) => items(await favStore().update((doc) => removeFavourite(doc, beatmapId))),
            // md5s: Map beatmapId → md5
            setMd5: async (md5s) => items(await favStore().update((doc) => withMd5(doc, md5s))),
        },
        picks: {
            list: async () => items(await pickStore().get()),
            add: async (entry) => items(await pickStore().update((doc) => addPick(doc, entry))),
        },
    };
}
