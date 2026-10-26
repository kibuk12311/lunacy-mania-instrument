// osu! skin.ini read and written line by line, so whatever is not edited comes back byte for byte: comments, odd
// spacing, a UTF-8 BOM, CRLF or LF (each line keeps its own), sections and key counts the editor never touches.
// Format (osu! wiki, Skinning/skin.ini): "[Section]" headers, "Key: value" lines, "//" comments; keys are matched
// without regard to case; one [Mania] section per key count, told apart by its "Keys:" line.
// Pure (no node modules), so the Skin tab's renderer edits with it too.

const HEADER = /^\s*\[([^\]]*)\]\s*$/;
// a value ends where a "//" comment starts (as osu! lazer reads it); the comment stays when the value is set
const PAIR = /^(\s*)([^:\s/][^:]*?)(\s*:\s*)(.*?)(\s*(?:\/\/.*)?)$/;
const COMMENT = /^\s*\/\//;

// text → { bom, lines: [{ text, eol }] }; the last line's eol is "" when the file does not end with a newline.
export function parseSkinIni(input) {
    let text = String(input ?? "");
    const bom = text.startsWith("﻿");
    if (bom) text = text.slice(1);
    const lines = [];
    const re = /\r\n|\n|\r/g;
    let at = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        lines.push({ text: text.slice(at, m.index), eol: m[0] });
        at = m.index + m[0].length;
    }
    if (at < text.length || !lines.length) lines.push({ text: text.slice(at), eol: "" });
    return { bom, lines };
}

export const writeSkinIni = (doc) => (doc.bom ? "﻿" : "") + doc.lines.map((l) => l.text + l.eol).join("");

// The newline most lines use (CRLF for a new file: what osu! writes).
export function eolOf(doc) {
    let crlf = 0;
    let lf = 0;
    for (const l of doc.lines) {
        if (l.eol === "\r\n") crlf += 1;
        else if (l.eol) lf += 1;
    }
    return lf > crlf ? "\n" : "\r\n";
}

// One line read: { kind: "section", name } | { kind: "pair", key, value } | { kind: "other" }.
export function readLine(text) {
    if (COMMENT.test(text)) return { kind: "other" };
    const header = HEADER.exec(text);
    if (header) return { kind: "section", name: header[1].trim() };
    const pair = PAIR.exec(text);
    if (pair) return { kind: "pair", key: pair[2].trim(), value: pair[4] };
    return { kind: "other" };
}

// [{ name, head, start, end }]: head is the header line's index (−1 for the lines before any header), lines
// [start, end) belong to it.
export function sectionsOf(doc) {
    const out = [{ name: "", head: -1, start: 0, end: doc.lines.length }];
    doc.lines.forEach((line, i) => {
        const r = readLine(line.text);
        if (r.kind !== "section") return;
        out.at(-1).end = i;
        out.push({ name: r.name, head: i, start: i + 1, end: doc.lines.length });
    });
    return out;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The index of the first line holding key in a section, or −1.
function findKey(doc, section, key) {
    for (let i = section.start; i < section.end; i += 1) {
        const r = readLine(doc.lines[i].text);
        if (r.kind === "pair" && same(r.key, key)) return i;
    }
    return -1;
}

// The [Mania] sections with their key count: [{ ...section, keys }] (keys NaN without a readable "Keys:").
export function maniaSections(doc) {
    return sectionsOf(doc).filter((s) => same(s.name, "Mania")).map((s) => {
        const i = findKey(doc, s, "Keys");
        return { ...s, keys: i < 0 ? NaN : Number.parseInt(readLine(doc.lines[i].text).value, 10) };
    });
}

// Which section a reference names: "General", "Colours", … or { mania: 4 }. The first one when there are several
// (osu! reads the first [Mania] for a key count).
export function findSection(doc, ref) {
    if (ref && typeof ref === "object") return maniaSections(doc).find((s) => s.keys === ref.mania) ?? null;
    return sectionsOf(doc).find((s) => s.head >= 0 && same(s.name, ref)) ?? null;
}

// The value of key in a section (as written, trimmed), or null.
export function getValue(doc, ref, key) {
    const section = findSection(doc, ref);
    if (!section) return null;
    const i = findKey(doc, section, key);
    return i < 0 ? null : readLine(doc.lines[i].text).value.trim();
}

// Every "Key: value" of a section, first occurrence of each key wins: Map(lowercase key → { key, value }).
export function pairsOf(doc, ref) {
    const section = findSection(doc, ref);
    const out = new Map();
    if (!section) return out;
    for (let i = section.start; i < section.end; i += 1) {
        const r = readLine(doc.lines[i].text);
        if (r.kind === "pair" && !out.has(r.key.toLowerCase())) out.set(r.key.toLowerCase(), { key: r.key, value: r.value.trim() });
    }
    return out;
}

// Makes the section if it is missing: [General] goes first, anything else at the end after a blank line.
// A new [Mania] gets "Keys: n" as its first line. → the section.
export function ensureSection(doc, ref) {
    const found = findSection(doc, ref);
    if (found) return found;
    const eol = eolOf(doc);
    const name = ref && typeof ref === "object" ? "Mania" : String(ref);
    const block = [{ text: `[${name}]`, eol }];
    if (ref && typeof ref === "object") block.push({ text: `Keys: ${ref.mania}`, eol });
    // an empty file: the section is all there is
    if (doc.lines.length === 1 && !doc.lines[0].text && !doc.lines[0].eol) doc.lines.length = 0;
    if (same(name, "General")) {
        const first = sectionsOf(doc).find((s) => s.head >= 0);
        const at = first ? first.head : doc.lines.length;
        doc.lines.splice(at, 0, ...block, ...(first ? [{ text: "", eol }] : []));
    } else {
        const last = doc.lines.at(-1);
        if (last && !last.eol) last.eol = eol;
        if (last?.text.trim()) doc.lines.push({ text: "", eol });
        doc.lines.push(...block);
    }
    return findSection(doc, ref);
}

// Sets key in a section (made if missing): the line it is on keeps its spacing and anything after the value is
// left alone; a new key goes after the section's last non-blank line. value null removes the key's lines.
export function setValue(doc, ref, key, value) {
    if (value === null || value === undefined) return removeKey(doc, ref, key);
    const section = ensureSection(doc, ref);
    const i = findKey(doc, section, key);
    const text = String(value).replace(/[\r\n]+/g, " ").trim();
    if (i >= 0) {
        const m = PAIR.exec(doc.lines[i].text);
        doc.lines[i].text = `${m[1]}${m[2]}${m[3]}${text}${m[5]}`;
        return doc;
    }
    let at = section.end;
    while (at > section.start && !doc.lines[at - 1].text.trim()) at -= 1;
    const eol = eolOf(doc);
    // a section that is the file's last one may end without a newline: give that line one before adding after it
    // (the new line then ends the file as that line did)
    const prev = doc.lines[at - 1];
    const prevEol = prev ? prev.eol : eol;
    if (prev && !prev.eol) prev.eol = eol;
    doc.lines.splice(at, 0, { text: `${key}: ${text}`, eol: at < doc.lines.length ? eol : prevEol });
    return doc;
}

export function removeKey(doc, ref, key) {
    const section = findSection(doc, ref);
    if (!section) return doc;
    for (let i = section.end - 1; i >= section.start; i -= 1) {
        const r = readLine(doc.lines[i].text);
        if (r.kind === "pair" && same(r.key, key)) doc.lines.splice(i, 1);
    }
    return doc;
}

// Several edits in one go on a copy of the text: patch { section ref string | "mania4": { key: value | null } }.
// → the new text. "mania<n>" names the [Mania] section of n keys.
export function patchSkinIni(text, patch) {
    const doc = parseSkinIni(text);
    for (const [where, pairs] of Object.entries(patch ?? {})) {
        const m = /^mania(\d+)$/i.exec(where);
        const ref = m ? { mania: Number(m[1]) } : where;
        for (const [key, value] of Object.entries(pairs ?? {})) setValue(doc, ref, key, value);
    }
    return writeSkinIni(doc);
}
