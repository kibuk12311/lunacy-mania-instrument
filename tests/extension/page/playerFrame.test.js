import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlayerFrame, playerParams, playerUrl, extensionOrigin } from "../../../extension/content/playerFrame.js";
import { PLAYER_SOURCE } from "../../../extension/shared/protocol.js";
import { makeDocument, makeWindow, FakeEvent } from "./helpers/dom.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const runtime = { getURL: (p) => `${ORIGIN}/${p}` };

function setup() {
    const doc = makeDocument("<div class='page'><button id='b'>x</button></div>");
    const win = makeWindow(doc, { url: "https://osu.ppy.sh/beatmapsets/1#mania/2" });
    let closed = 0;
    const player = createPlayerFrame({ doc, win, runtime, onClose: () => closed++ });
    return { doc, win, player, closed: () => closed };
}

const message = (win, source, origin, data) => win.dispatchEvent(new FakeEvent("message", { source, origin, data }));

test("params in the hash, in the documented order and form", () => {
    const p = playerParams({ setId: 1, beatmapId: 2, src: "full", rate: 1, lang: "ru", checksum: "ab", login: false, previewWarn: true });
    assert.equal(p, "set=1&map=2&src=full&rate=1.0&lang=ru&checksum=ab&login=0&previewWarn=1");
    const q = new URLSearchParams(playerParams({ setId: 1, beatmapId: 2, rate: 0.85 }));
    assert.equal(q.get("src"), "preview");
    assert.equal(q.get("rate"), "0.85");
    assert.equal(q.get("lang"), "en");
    assert.equal(q.get("checksum"), "");
    assert.equal(q.get("login"), "");
    assert.equal(q.get("previewWarn"), "0");
    assert.equal(new URLSearchParams(playerParams({ login: true })).get("login"), "1");
    assert.equal(new URLSearchParams(playerParams({ src: "evil" })).get("src"), "preview");
    assert.equal(playerUrl(`${ORIGIN}/player/player.html`, { setId: 3 }).split("#")[0], `${ORIGIN}/player/player.html`);
    assert.equal(extensionOrigin(runtime), ORIGIN);
    assert.equal(extensionOrigin({ getURL: (p) => `moz-extension://1234-5678/${p}` }), "moz-extension://1234-5678");
});

test("open: one fixed full-viewport iframe, scroll lock, focus on load", () => {
    const { doc, player } = setup();
    doc.documentElement.style.overflow = "auto";
    doc.getElementById("b").focus();
    const frame = player.open({ setId: 1, beatmapId: 2, src: "preview", rate: 1.2, lang: "en", checksum: "c", login: null, previewWarn: false });
    assert.equal(doc.querySelectorAll("iframe[data-lm-player]").length, 1);
    assert.equal(frame.getAttribute("allow"), "autoplay");
    const [base, hash] = frame.getAttribute("src").split("#");
    assert.equal(base, `${ORIGIN}/player/player.html`);
    assert.equal(new URLSearchParams(hash).get("rate"), "1.2");
    assert.equal(frame.style.position, "fixed");
    assert.equal(frame.style.zIndex, "2147483646");
    assert.equal(frame.style.width, "100vw");
    assert.equal(doc.documentElement.style.overflow, "hidden");
    frame.dispatchEvent(new FakeEvent("load"));
    assert.equal(doc.activeElement, frame);
    assert.equal(frame.contentWindow.focused, 1);
    // a second open replaces the first: one player at a time
    const second = player.open({ setId: 1, beatmapId: 3 });
    assert.equal(doc.querySelectorAll("iframe[data-lm-player]").length, 1);
    assert.notEqual(second, frame);
    assert.equal(doc.documentElement.style.overflow, "hidden");
    player.close();
    assert.equal(doc.documentElement.style.overflow, "auto", "the page's overflow comes back");
    assert.equal(doc.activeElement, doc.getElementById("b"), "focus returns");
});

test("close message is taken only from the iframe's window and the extension's origin", () => {
    const { win, player, doc, closed } = setup();
    const frame = player.open({ setId: 1, beatmapId: 2 });
    const close = { source: PLAYER_SOURCE, type: "close" };
    message(win, {}, ORIGIN, close); // another window
    message(win, frame.contentWindow, "https://osu.ppy.sh", close); // the page's own origin
    message(win, frame.contentWindow, "chrome-extension://otherextensionid", close);
    message(win, frame.contentWindow, ORIGIN, { source: "someone-else", type: "close" });
    message(win, frame.contentWindow, ORIGIN, { source: PLAYER_SOURCE, type: "other" });
    message(win, frame.contentWindow, ORIGIN, "close");
    message(win, null, ORIGIN, close);
    assert.equal(player.isOpen(), true);
    assert.equal(closed(), 0);
    message(win, frame.contentWindow, ORIGIN, close);
    assert.equal(player.isOpen(), false);
    assert.equal(closed(), 1);
    assert.equal(doc.querySelector("iframe"), null);
    // after closing, nothing is listened to any more
    message(win, frame.contentWindow, ORIGIN, close);
    assert.equal(closed(), 1);
});

test("Esc in the page closes it; other keys do not", () => {
    const { doc, player } = setup();
    player.open({ setId: 1, beatmapId: 2 });
    doc.body.dispatchEvent(new FakeEvent("keydown", { key: "a", bubbles: true }));
    assert.equal(player.isOpen(), true);
    const esc = new FakeEvent("keydown", { key: "Escape", bubbles: true });
    doc.body.dispatchEvent(esc);
    assert.equal(player.isOpen(), false);
    assert.equal(esc.defaultPrevented, true);
    assert.equal(player.close(), false, "closing twice is harmless");
});
