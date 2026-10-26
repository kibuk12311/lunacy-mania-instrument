// Undo / redo of the Skin tab: every state is the whole skin.ini text. Edits of one field that follow each other
// quickly (a slider being dragged) merge into one step.
export function createHistory(first = "", { limit = 200, mergeMs = 1200, now = () => Date.now() } = {}) {
    let states = [first];
    let pos = 0;
    let lastKey = null;
    let lastAt = 0;
    return {
        get current() { return states[pos]; },
        get canUndo() { return pos > 0; },
        get canRedo() { return pos < states.length - 1; },
        // mergeKey: what was edited ("ColumnWidth"); the same key again soon replaces the last step
        push(text, mergeKey = null) {
            if (text === states[pos]) return false;
            const t = now();
            const merge = mergeKey !== null && mergeKey === lastKey && t - lastAt < mergeMs && pos > 0 && pos === states.length - 1;
            states = states.slice(0, pos + 1);
            if (merge) states[pos] = text;
            else {
                states.push(text);
                if (states.length > limit) states.shift();
                pos = states.length - 1;
            }
            lastKey = mergeKey;
            lastAt = t;
            return true;
        },
        undo() {
            if (pos > 0) pos -= 1;
            lastKey = null;
            return states[pos];
        },
        redo() {
            if (pos < states.length - 1) pos += 1;
            lastKey = null;
            return states[pos];
        },
        reset(text) {
            states = [text];
            pos = 0;
            lastKey = null;
        },
    };
}
