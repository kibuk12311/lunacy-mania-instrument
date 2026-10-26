// "For you" on the analysis card: the map against the player's mania-tracker skill (src/recommend/skill.js readSkill).
// The tiles and MinaCalc skillsets are the picks tab's (src/recommend/catalog.js, read only).
import { patternById } from "../recommend/catalog.js";
import { NAME_FAMILY } from "../gen/search.js";

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

// The card's main pattern (a LeoBlack cluster name) → the picks tab's pattern id: its family by the generator's own
// table (search.js NAME_FAMILY), whose names the picks tab uses too (stream, jumpstream, …, jack).
const PATTERN_OF = Object.fromEntries(Object.entries(NAME_FAMILY).map(([name, family]) => [name, family.toLowerCase()]));
// the tracker's skillset name → the key of the card's own MinaCalc values (result.msd)
const OUR_AXIS = {
    Stream: "stream", Jumpstream: "jumpstream", Handstream: "handstream", Stamina: "stamina",
    Chordjack: "chordjack", JackSpeed: "jackspeed", Technical: "technical",
};

const patternFor = (r) => patternById(r?.tech ? "tech" : Object.hasOwn(PATTERN_OF, r?.primary ?? "") ? PATTERN_OF[r.primary] : null);

// "speed" | "stamina" | "tech" | "jack" | null: tech when the card says so, else by the main pattern.
export const tileForResult = (r) => patternFor(r)?.tile ?? null;

// The MinaCalc skillset the map is compared on, { ours, tracker }; null for plain jacks, whose JackSpeed rating
// does not line up with the charts (the picks tab's msdFit:false), and for patterns without a tile.
export function msdAxisFor(r) {
    const pattern = patternFor(r);
    if (!pattern || pattern.msdFit === false || !OUR_AXIS[pattern.msd]) return null;
    return { ours: OUR_AXIS[pattern.msd], tracker: pattern.msd };
}

// How the map sits against the player's dan: the picks tab's goal windows, with an easy and a too-hard end.
export function bandFor(delta) {
    if (delta < -0.6) return "easy";
    if (delta < -0.1) return "comfort";
    if (delta <= 0.5) return "growth";
    if (delta <= 1.2) return "challenge";
    return "hard";
}

// { tile, source: "tile"|"overall", playerDan, delta, band, msd: { axis, map, player, delta } | null } or null when
// the result is not a rated map or the player has no dan at all. delta is to one decimal, as the card shows it.
export function fitForSkill(r, skill) {
    if (r?.kind !== "ok" || finite(r.numeric) === null || !skill) return null;
    const tile = tileForResult(r);
    const tileDan = tile ? finite(skill.tiles?.[tile]) : null;
    const playerDan = tileDan ?? finite(skill.overall);
    if (playerDan === null) return null;
    const delta = round(r.numeric - playerDan, 1);
    const axis = msdAxisFor(r);
    const map = axis ? finite(r.msd?.[axis.ours]) : null;
    const player = axis ? finite(skill.msd?.[axis.tracker]) : null;
    return {
        tile,
        source: tileDan !== null ? "tile" : "overall",
        playerDan,
        delta,
        band: bandFor(delta),
        msd: map !== null && player !== null ? { axis: axis.tracker, map, player, delta: round(map - player, 2) } : null,
    };
}

// The ladder rate whose dan is nearest the player's dan + 0.25 (a growth step); a tie goes to the rate nearer 1.0x.
export function growthRate(rows, playerDan) {
    if (finite(playerDan) === null) return null;
    const target = playerDan + 0.25;
    let best = null;
    for (const row of rows ?? []) {
        if (finite(row?.numeric) === null || finite(row?.rate) === null) continue;
        const gap = round(Math.abs(row.numeric - target), 6);
        const fromOne = round(Math.abs(row.rate - 1), 6);
        if (!best || gap < best.gap || (gap === best.gap && fromOne < best.fromOne)) best = { rate: row.rate, gap, fromOne };
    }
    return best?.rate ?? null;
}
