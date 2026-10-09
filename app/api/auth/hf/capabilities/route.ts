import { NextResponse } from 'next/server';

export async function GET() {
  // HF Spaces embeds the app in a cross-site iframe where browsers drop the SameSite=Lax
  // login/refresh cookies the Codex flow depends on, so the sign-in can't complete there.
  // Local, desktop, and self-hosted instances are top-level and work normally.
  const isHFSpaces = !!process.env.SPACE_HOST;
  return NextResponse.json({
    oauthAvailable: !!process.env.OAUTH_CLIENT_ID,
    // OAuth client IDs are public by design — they're visible in the auth URL
    clientId: process.env.OAUTH_CLIENT_ID || null,
    scopes: process.env.OAUTH_SCOPES || 'openid profile inference-api contribute-repos',
    codexAvailable: !isHFSpaces,
    // The Space's page on huggingface.co, where a provider sign-in from the embedded app returns.
    spaceId: isHFSpaces && /^[\w.-]+\/[\w.-]+$/.test(process.env.SPACE_ID ?? '') ? process.env.SPACE_ID : null,
  });
}
