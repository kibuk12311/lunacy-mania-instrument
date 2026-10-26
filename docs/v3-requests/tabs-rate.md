# Requests from stream tabs-rate (R)

## 1. `tests/view.test.js` (owner: tabs-analysis, A) — accept `<area>.html.*` keys in index.html

**Why.** The tabs-v2 plan, §1.3, says a tab's `data-i18n` keys in `index.html` live in the tab's own message file as
`<area>.html.*` (`html.js` is closed to the streams). The rate tab now marks its new markup with `rate.html.*`
(12 keys, all in `src/i18n/messages/rate.js`), and the marathon stream does the same (`marathon.html.*`). The test
"index.html: every marked key exists and its Russian text is the one in the markup" only accepts `html.*`, so it
fails on the first such key (today `marathon.html.auto`, then `rate.html.presets`).

**Change** (only inside that test):

```js
// was: assert.ok(key.startsWith("html.") && keys.has(key), `${name}="${key}" has no message`);
assert.ok(/^(html|[a-z]+\.html)\./.test(key) && keys.has(key), `${name}="${key}" has no message`);
```

and the last assertion compares the `html.*` keys only (each tab's own `<area>.html.*` keys are already checked
for use by `tests/i18n-tabs.test.js`):

```js
// was: assert.deepEqual(used.sort(), [...keys].filter((k) => k.startsWith("html.")).sort());
assert.deepEqual(used.filter((k) => k.startsWith("html.")).sort(), [...keys].filter((k) => k.startsWith("html.")).sort());
```

Checked with a copy of the test logic carrying these two changes: every key in the current `index.html` exists and
its Russian text equals the markup (the rate tab's 12 keys and every other tab's), 0 problems.
