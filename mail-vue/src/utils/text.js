export function getTextWidth(text, font = '14px sans-serif') {
    // Set the Canvas resolution explicitly
    const canvas = document.createElement('canvas');
    canvas.width = 2000; // A sufficiently large canvas
    canvas.style.width = '1000px'; // Avoid the effects of CSS scaling
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    return ctx.measureText(text).width;
}