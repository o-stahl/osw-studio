/**
 * Whether the page is shown inside another page's frame (the HuggingFace Space). Locale cookies need
 * other attributes there, and sign-in has to use a popup, since sign-in pages refuse to be framed.
 */
export function isEmbedded(): boolean {
  try {
    return typeof window !== 'undefined' && window.top !== window.self;
  } catch {
    return true;
  }
}
