/**
 * Viewport units on an artboard.
 *
 * An artboard's frame is as tall as its page, so `100vh` there would be the whole page, and a hero
 * sized to the screen would grow with its own artboard. Canvas compiles stylesheets and style
 * attributes with `vh`, `svh`, `lvh` and `dvh` in terms of `--osw-vh`, which each artboard sets to 1%
 * of its device's height (`viewportRule`).
 */

// A number not glued to a name: `.h-100vh` and `--gap-10vh` are names, `-10vh` after a colon is a length.
const VH = /(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+))(?:s|l|d)?vh\b/g;

/** `css` with every viewport-height length as a multiple of `--osw-vh`. */
export function pinViewportUnits(css: string): string {
  return css.replace(VH, 'calc($1 * var(--osw-vh))');
}

const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const STYLE_ATTR = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi;

/** A page with the same done to its `<style>` blocks and `style` attributes. Text elsewhere is left alone. */
export function pinPageViewportUnits(html: string): string {
  return html
    .replace(STYLE_BLOCK, (_m, open: string, body: string, close: string) => open + pinViewportUnits(body) + close)
    .replace(STYLE_ATTR, (m, lead: string, _quoted: string, dq: string | undefined, sq: string | undefined) => {
      if (dq !== undefined) return `${lead}"${pinViewportUnits(dq)}"`;
      if (sq !== undefined) return `${lead}'${pinViewportUnits(sq)}'`;
      return m;
    });
}

/** The rule that says what `--osw-vh` is on an artboard of this device height. */
export function viewportRule(deviceHeight: number): string {
  return `:root{--osw-vh:${deviceHeight / 100}px}`;
}
