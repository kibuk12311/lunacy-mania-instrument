// A picture of the user's for the skin, made ready here where the browser reads any PNG / JPG / WebP: two PNGs,
// @1x and @2x (twice its size), transparency kept. A file named "…@2x.png" is the @2x and the @1x is half of it;
// any other is the @1x and the @2x is drawn twice as big. The @2x is kept within MAX_SIDE.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SIDE = 4096;
export const ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

// The sizes of the two PNGs for a picture of w × h: { one: [w, h], two: [w, h] } (the @2x within MAX_SIDE).
export function pairSizes(width, height, hd) {
    let w2 = hd ? width : width * 2;
    let h2 = hd ? height : height * 2;
    const k = Math.min(1, MAX_SIDE / Math.max(w2, h2));
    w2 = Math.max(2, Math.round(w2 * k));
    h2 = Math.max(2, Math.round(h2 * k));
    return { one: [Math.max(1, Math.round(w2 / 2)), Math.max(1, Math.round(h2 / 2))], two: [w2, h2] };
}

async function drawPng(bitmap, w, h) {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: "image/png" })
        : await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
}

// file (a File) → { png1x, png2x, width, height } | throws Error with a code: "type" | "size" | "read"
export async function pictureToPngs(file) {
    const fail = (code) => Object.assign(new Error(code), { code });
    if (!file || !/\.(png|jpe?g|webp)$/i.test(String(file.name ?? "")) && !/^image\/(png|jpeg|webp)$/.test(String(file.type ?? ""))) throw fail("type");
    if (file.size > MAX_FILE_BYTES) throw fail("size");
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw fail("read");
    }
    const hd = /@2x\.\w+$/i.test(String(file.name ?? ""));
    const { one, two } = pairSizes(bitmap.width, bitmap.height, hd);
    const png2x = await drawPng(bitmap, two[0], two[1]);
    const png1x = await drawPng(bitmap, one[0], one[1]);
    bitmap.close?.();
    return { png1x, png2x, width: one[0], height: one[1] };
}
