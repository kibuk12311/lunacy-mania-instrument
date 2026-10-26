# Requests from stream tabs-marathon (M)

## 1. `tests/view.test.js` (owner: tabs-analysis, A): accept `<area>.html.*` keys in index.html

This is the same change as request 1 in `tabs-rate.md`, and it is needed for the same reason. The marathon section of
`index.html` marks its new markup with 16 `marathon.html.*` keys (all in `src/i18n/messages/marathon.js`, per §1.3 of
the tabs-v2 plan). The test "index.html: every marked key exists and its Russian text is the one in the markup" accepts
only `html.*`, so it fails on these keys. It currently stops earlier, on `recommend.html.planSize`.

I made both edits from `tabs-rate.md` to a copy of the test logic and ran it on the current `index.html`. All 16
`marathon.*` keys (`data-i18n` and `data-i18n-title`) exist, and each Russian text matches the markup exactly. There
were 0 problems. No other change is needed for the marathon stream.
