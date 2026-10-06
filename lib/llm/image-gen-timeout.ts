/** Upper bound on one image generation call to the provider. `IMAGE_GEN_TIMEOUT_MS` overrides it. */
export function imageGenTimeoutMs(): number {
  return Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 240_000;
}

/**
 * How long a server-side run waits for the browser to answer an image request: the browser's own
 * call to `/api/generate-image` plus time to claim the request and post the image back. Shorter, and
 * a slow image would be reported to the agent as no browser answering while it was still coming.
 */
export function imageDelegationTimeoutMs(): number {
  return imageGenTimeoutMs() + 30_000;
}
