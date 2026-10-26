// Metadata of an .osu set in place (mapgen v3): title, artist, creator, source, tags, the preview point and the
// background line. Every other line stays byte for byte; applying the same metadata twice changes nothing.

export const GENERATED_TAG = "lunacy-mania generated";
// what maps made before the rename carry instead: still read as ours, written back as GENERATED_TAG
export const OLD_GENERATED_TAGS = ["dan-analyzer generated"];

const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const HEADER = /^\s*\[([^\]]+)\]\s*$/;
const BACKGROUND = /^0,0,"[^"]*"/;
const EVENTS_COMMENT = "//Background and Video events";
// where a missing section goes: before the first of these that the file has
const SECTION_ORDER = ["General", "Editor", "Metadata", "Difficulty", "Events", "TimingPoints", "Colours", "HitObjects"];

function split(text) {
    return { lines: String(text).split(/\r?\n/), eol: String(text).includes("\r\n") ? "\r\n" : "\n" };
}

// [start, end): the header line and the lines up to the next header
function sectionOf(lines, name) {
    const start = lines.findIndex((l) => HEADER.exec(l)?.[1] === name);
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !HEADER.test(lines[end])) end += 1;
    return { start, end };
}

function ensureSection(lines, name) {
    const found = sectionOf(lines, name);
    if (found) return found;
    const later = SECTION_ORDER.slice(SECTION_ORDER.indexOf(name) + 1).map((n) => sectionOf(lines, n)).find(Boolean);
    const at = later ? later.start : lines.length;
    lines.splice(at, 0, `[${name}]`, "");
    return { start: at, end: at + 1 };
}

const keyOf = (line) => (line.includes(":") ? line.slice(0, line.indexOf(":")).trim() : null);
const valueOf = (line) => line.slice(line.indexOf(":") + 1).trim();
// General writes "Key: value", Metadata and the rest "Key:value" (as osu! itself does)
const separator = (name) => (name === "General" || name === "Editor" ? ": " : ":");

function setIn(lines, name, key, value) {
    const s = ensureSection(lines, name);
    const line = `${key}${separator(name)}${clean(value)}`;
    for (let i = s.start + 1; i < s.end; i += 1) {
        if (keyOf(lines[i]) === key) {
            lines[i] = line;
            return;
        }
    }
    let at = s.end;
    while (at > s.start + 1 && lines[at - 1].trim() === "") at -= 1;
    lines.splice(at, 0, line);
}

function getIn(lines, name, key) {
    const s = sectionOf(lines, name);
    if (!s) return "";
    for (let i = s.start + 1; i < s.end; i += 1) if (keyOf(lines[i]) === key) return valueOf(lines[i]);
    return "";
}

// "lunacy-mania generated" first, then the user's words without repeating it (or the tag of an older version)
function tagsLine(tags) {
    let text = clean(tags);
    for (const tag of [GENERATED_TAG, ...OLD_GENERATED_TAGS]) text = text.split(tag).join(" ");
    const words = text.split(/\s+/).filter(Boolean);
    return [GENERATED_TAG, ...words].join(" ");
}

function setBackground(lines, file) {
    const s = ensureSection(lines, "Events");
    for (let i = s.end - 1; i > s.start; i -= 1) if (BACKGROUND.test(lines[i])) lines.splice(i, 1);
    if (file === null) return;
    const name = clean(file).replace(/"/g, "");
    const events = sectionOf(lines, "Events");
    let at = events.start + 1;
    for (let i = events.start + 1; i < events.end; i += 1) {
        if (lines[i].trim() === EVENTS_COMMENT) {
            at = i + 1;
            break;
        }
    }
    lines.splice(at, 0, `0,0,"${name}",0,0`);
}

// title / artist / creator: empty keeps the map's own; source / tags: empty clears; undefined leaves any field alone.
// background: a file name in the set, null for none. previewMs: ms, or null/undefined to keep the map's own.
export function applyMeta(osuText, { title, artist, creator, source, tags, previewMs, background } = {}) {
    const { lines, eol } = split(osuText);
    if (clean(title)) {
        setIn(lines, "Metadata", "Title", title);
        setIn(lines, "Metadata", "TitleUnicode", title);
    }
    if (clean(artist)) {
        setIn(lines, "Metadata", "Artist", artist);
        setIn(lines, "Metadata", "ArtistUnicode", artist);
    }
    if (clean(creator)) setIn(lines, "Metadata", "Creator", creator);
    if (source !== undefined && source !== null) setIn(lines, "Metadata", "Source", source);
    if (tags !== undefined && tags !== null) setIn(lines, "Metadata", "Tags", tagsLine(tags));
    if (Number.isFinite(previewMs)) setIn(lines, "General", "PreviewTime", String(Math.max(0, Math.round(previewMs))));
    if (background !== undefined) setBackground(lines, background);
    return lines.join(eol);
}

export function setField(osuText, section, key, value) {
    const { lines, eol } = split(osuText);
    setIn(lines, section, key, value);
    return lines.join(eol);
}

export const setVersion = (osuText, version) => setField(osuText, "Metadata", "Version", version);

// adds one word to Tags unless it is there already
export function addTag(osuText, tag) {
    const { lines } = split(osuText);
    const words = getIn(lines, "Metadata", "Tags").split(/\s+/).filter(Boolean);
    if (words.includes(tag)) return osuText;
    return setField(osuText, "Metadata", "Tags", [...words, tag].join(" "));
}

export function readMeta(osuText) {
    const { lines } = split(osuText);
    const events = sectionOf(lines, "Events");
    const bgLine = events ? lines.slice(events.start + 1, events.end).find((l) => BACKGROUND.test(l)) : null;
    const preview = Number(getIn(lines, "General", "PreviewTime"));
    return {
        title: getIn(lines, "Metadata", "Title"),
        titleUnicode: getIn(lines, "Metadata", "TitleUnicode"),
        artist: getIn(lines, "Metadata", "Artist"),
        artistUnicode: getIn(lines, "Metadata", "ArtistUnicode"),
        creator: getIn(lines, "Metadata", "Creator"),
        version: getIn(lines, "Metadata", "Version"),
        source: getIn(lines, "Metadata", "Source"),
        tags: getIn(lines, "Metadata", "Tags"),
        beatmapId: getIn(lines, "Metadata", "BeatmapID"),
        beatmapSetId: getIn(lines, "Metadata", "BeatmapSetID"),
        audioFilename: getIn(lines, "General", "AudioFilename"),
        previewMs: Number.isFinite(preview) && getIn(lines, "General", "PreviewTime") !== "" ? preview : null,
        background: bgLine ? /^0,0,"([^"]*)"/.exec(bgLine)[1] : null,
    };
}
