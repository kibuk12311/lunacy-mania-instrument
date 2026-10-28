// The few things osu-web does that the extension builds on (extension/DESIGN.md §2), for the smoke test's fake pages:
// a click on a difficulty in the picker moves the --active class and calls history.replaceState with #mania/<id>
// (no hashchange, no popstate); window.fakeTurboVisit(path) does a Turbo-like visit: turbo:before-cache, the new
// page's <body> swapped in, pushState, turbo:load. It sits in <head>, so it survives the body swap like Turbo's.
(() => {
    const ACTIVE = "beatmapset-beatmap-picker__beatmap--active";
    const ANCHOR = "a.beatmapset-beatmap-picker__beatmap";

    function markActive(id) {
        const anchors = [...document.querySelectorAll(ANCHOR)];
        const wanted = anchors.find((a) => a.href.endsWith(`/${id}`)) ?? anchors[0];
        for (const a of anchors) a.classList.toggle(ACTIVE, a === wanted);
        const name = document.querySelector(".beatmapset-header__diff-name");
        if (name && wanted) name.textContent = wanted.dataset.version ?? "";
    }

    function fromHash() {
        const m = /^#[a-z]+\/(\d+)/.exec(location.hash);
        markActive(m ? m[1] : null);
    }

    document.addEventListener("click", (event) => {
        const anchor = event.target.closest?.(ANCHOR);
        if (!anchor) return;
        event.preventDefault();
        const hash = new URL(anchor.href).hash;
        history.replaceState(history.state, "", `${location.pathname}${hash}`);
        markActive(hash.split("/").pop());
    });

    window.fakeTurboVisit = async (path) => {
        document.dispatchEvent(new Event("turbo:before-cache"));
        const html = await (await fetch(path, { credentials: "same-origin" })).text();
        const next = new DOMParser().parseFromString(html, "text/html");
        document.body.replaceWith(document.adoptNode(next.body));
        document.title = next.title;
        history.pushState({ turbo: true }, "", path);
        fromHash();
        document.dispatchEvent(new Event("turbo:load"));
        return true;
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fromHash);
    else fromHash();
})();
