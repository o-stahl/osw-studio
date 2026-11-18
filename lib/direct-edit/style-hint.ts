/**
 * How the agent is told of `style`: for one element the user has selected, with that element filled
 * in. The system prompt and the MCP `bash` description do not teach the command, so an agent meets
 * it here (the selected-element message, `canvas_selection`), in `/overrides.css`'s header, or by
 * asking for `style --help`. A project nobody edits by hand never gets an overrides file from it.
 */

/** Below this width a selection reads as being about small screens, and `--width` is offered. */
const NARROW_PICK = 1000;

/** Characters a shell reads as part of one word when they stand unquoted. */
const PLAIN_WORD = /^[\p{L}\p{N}\p{M}._~@+/:-]+$/u;

/** `text` as one shell word: as it is, or in single quotes where the shell would split or read it. */
const shellWord = (text: string) => (PLAIN_WORD.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

/**
 * @param element the element as `style` takes it: its marker (`@h7x2m4qp`) or its position
 *   (`/index.html:42:5`), quoted in the command where its file name has a space or a character
 *   the shell reads.
 * @param pickedAt the width it was selected at, when known.
 */
export function styleHint(element: string, pickedAt?: number | null): string {
  const width = pickedAt && pickedAt < NARROW_PICK ? pickedAt : null;
  return `To restyle only this element: style ${shellWord(element)} font-size=36px color=#111 (your own properties and values). ` // i18n-ignore: addressed to the agent
    + (width ? `Add --width ${width} when the change is for screens that narrow and narrower. ` : '') // i18n-ignore: addressed to the agent
    + 'To restyle every element like it, edit the stylesheet instead.'; // i18n-ignore: addressed to the agent
}
