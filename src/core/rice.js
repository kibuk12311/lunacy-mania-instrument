// 4K rice = four keys and at most 15% long notes (the RC threshold used by LeoBlack Mixed).
export const RICE_MAX_LN_RATIO = 0.15;

export function isRice({ keys, lnRatio }) {
    return keys === 4 && lnRatio <= RICE_MAX_LN_RATIO;
}
