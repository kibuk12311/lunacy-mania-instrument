// JSON Lines that every reader splits the same way.
// JSON.stringify leaves U+2028, U+2029 and U+0085 raw (they are legal inside JSON strings), and Python's
// str.splitlines() also breaks at those (and at \v, \f and \x1c-\x1e, which JSON.stringify already escapes), so a chart
// name with one of them split one index line in two in v1.5. jsonLine() writes every such character as a \uXXXX escape:
// the line then holds no line break for any reader, and JSON.parse gives back the very same value.
const BREAKERS = /[\u{000b}\u{000c}\u{001c}-\u{001e}\u{0085}\u{2028}\u{2029}]/gu;

// Every character Python's str.splitlines() splits at.
export const SPLITLINES_BREAKS = ["\n", "\r", "\u{000b}", "\u{000c}", "\u{001c}", "\u{001d}", "\u{001e}", "\u{0085}", "\u{2028}", "\u{2029}"];

export const jsonLine = (value) => JSON.stringify(value).replace(BREAKERS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Lines of a JSONL text: split at "\n" only (a stray "\r" before it is dropped), blank lines skipped, a line that is
// not JSON counted in `bad` instead of throwing.
export function parseJsonl(text) {
    const rows = [];
    let bad = 0;
    for (const raw of String(text).split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { bad += 1; }
    }
    return { rows, bad };
}
