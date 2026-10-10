# Changelog

## Unreleased

### Security
- **API writes from another site's page are refused**: `isCrossOriginWrite` (`lib/web/origin-guard.ts`) runs first in `middleware.ts`, desktop included, and answers 403 to a POST, PUT, PATCH or DELETE under `/api/` whose `Origin` is not the app's own (`Host`, `X-Forwarded-Host`, `SPACE_HOST`, `NEXT_PUBLIC_APP_URL`, `ALLOWED_ORIGINS`). `CROSS_ORIGIN_ROUTES` exempts deployment functions, analytics collection, `/api/mcp`, its OAuth token, register and revoke endpoints and file URLs. Session-cookie routes accepted such writes, and the desktop API had no check at all.
- **Middleware runs for every `/api/` path**: the matcher skips static-file extensions on page paths only. A route ending in a value, such as `/api/w/{id}/sync/projects/x.js`, skipped middleware.

- **The preview host no longer reads the preview frame's window**: each document posts `preview:ready` and `preview:scroll` from `previewBridgeScript` (`lib/preview/preview-bridge.ts`), replacing the `window.__oswPreview` marker read and `readFrameScroll` (removed from `lib/preview/scroll-memory.ts`); a frame load with no ack within `ACK_TIMEOUT_MS` counts as an escape. The frame's message listeners ignore anything not sent by `window.parent`.

- **Screenshots of a preview are painted inside its frame**: `captureIframeScreenshot` (`lib/utils/screenshot.ts`) sends `preview:capture` with `CAPTURE_RUNTIME_JS` (`lib/preview/frame-capture.ts`); the frame's bridge runs it, loads modern-screenshot from `public/preview-capture/` (copied by `postinstall`), and posts an `ImageBitmap` back. modern-screenshot gets a shadow-root `sandbox` in place of the nested iframe it would create, which a sandboxed frame cannot read. The html2canvas fallback, `waitForResources` and `prepareScreenshotClone` are removed; the app no longer imports a painter. A same-origin published frame gets the bridge injected on first capture.
- **The editor preview and the project thumbnail frame run on an opaque origin**: `sandbox="allow-scripts allow-forms"` without `allow-same-origin` in `MultipagePreview`, `sandbox="allow-scripts"` in `captureProjectScreenshot`. Project code there could read `localStorage['osw-studio-settings']` (provider keys and tokens), every IndexedDB project, the parent document, and call `/api/w/` with the session. The frame is written `previewShellHtml` (`lib/preview/preview-shell.ts`), which asks for the page (`preview:shell-ready`), receives the HTML and its blobs (`preview:shell-content`, `collectShellAssets`), makes its own blob URLs in dependency order and writes the page with `document.open/write`; the host's blob URLs do not load on an opaque origin. `indexedDB` throws `SecurityError` in the preview.
- **A project's `localStorage`, `sessionStorage` and `document.cookie` in the preview are per project and last until the tab closes**: the bridge installs in-memory stand-ins (`STORAGE_SHIM_JS`, `lib/preview/preview-bridge.ts`) wherever the real ones throw, seeded from `window.__oswStorageSeed` that the shell sets, and reports each changed area as `preview:storage`. The host keeps them per project in memory (`lib/preview/preview-storage.ts`, `PREVIEW_STORAGE_LIMIT` 5 MB per area); they survive the preview reloading after an edit. Projects shared the app's own storage before.
- **Edge-function calls from the preview go through the host**: the interceptor in `virtual-server.ts` posts `preview:function-call` for fetch, XHR and form posts to a function; `runFunctionCall` (`lib/preview/function-proxy.ts`) accepts only `/api/deployments/{deploymentId}/functions/…` of the previewed deployment (`functionCallPath`) and answers `preview:function-response`. The function route stays closed to other origins.

- **The session cookie is `__Host-osw_session` wherever cookies are Secure**: `sessionCookieName`, `sessionCookieOptions` and `setSessionOnResponse` (`lib/auth/session.ts`) replace the `SESSION_COOKIE_NAME` constant and the copies of its attributes in login, register, handoff and middleware; `setSessionOnResponse` and `clearSessionCookie` also clear the old `osw_session`. A site on a sibling subdomain could set `osw_session` for the parent domain. Plain-HTTP installs (`SECURE_COOKIES=false`, development) keep `osw_session`. Signs everyone out once. The ChatGPT cookies follow the same rule (`codexCookieName`, `codexLoginCookieName` in `app/api/auth/codex/cookie.ts`, replacing `CODEX_COOKIE_NAME` and `CODEX_LOGIN_COOKIE_NAME`); writing them clears `osw_codex_rt` and `osw_codex_login`, so ChatGPT has to be reconnected once.
- **Edge-function responses carry `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`**: `withDocumentGuard` in `app/api/deployments/[id]/functions/[...path]/route.ts`, refusals included. A function answering `text/html`, opened as a page, ran with the studio's origin. Calls made with fetch are unaffected.

- **Published sites and review copies are served away from the studio's origin**: `lib/web/site-origin.ts` names three set-ups (`sitesMode`): `proxy` (`STATIC_PROXY`, each site on its slug subdomain or custom domain), `host` (`SITES_ORIGIN`, every site under `/deployments/{id}/` on one other origin) and `same-origin` (neither). Middleware answers only site paths on a site host (`isSiteHost`, `isSitePath`: the site, its review copy, its functions, analytics) and rewrites a request on the studio's own host (`isStudioHost`: the app host or loopback) for `/deployments/…` or `/review/{id}/…` to `/api/site-location/…`, which 308-redirects it to the site's origin (`siteOriginFor`: custom domain first, then slug subdomain or sites address); any other host is served as before; `/review/{id}/osw-api/` stays on the studio host for the review panel. The matcher no longer skips static extensions under `/deployments/` and `/review/`, where an `.svg` ran on the studio's origin. `requestHost` reads `Host`, never `X-Forwarded-Host`. Public URLs, sitemaps and analytics origins use `SITES_ORIGIN`; `isReviewOriginAllowed` also accepts the deployment's own site origin.
- **The generated Caddyfile serves sites only on their own hosts**: the main domain block no longer serves `/deployments/*`; each slug and custom-domain block (`siteBlock`, `lib/caddy/regenerate.ts`) passes its own functions, `/api/analytics/track`, `/api/analytics/interaction` and `/review/{id}` to the app. Those paths were rewritten into the static build and answered 404.
- **The desktop app serves published sites on a second port**: `startSiteProxy` (`desktop/electron/site-proxy.ts`) forwards it to the app server with the Host header unchanged, and sets `SITES_ORIGIN`. On desktop, middleware refuses any Host other than loopback, since the desktop API has no session.
- **Deployment thumbnails and heatmap pages are rendered from the build in a sandboxed frame**: `captureDeploymentPage` (`lib/utils/deployment-thumbnail.ts`, replacing `captureDeploymentScreenshot`) reads the page from `GET /api/deployment-pages/{id}?path=` (`requireDeploymentAccess` viewer, HTML only, inside the build), adds `<base href>` at its public URL and the preview bridge (`pageForCapture`), and loads it through `loadIntoShell`. Both loaded the published URL in an unsandboxed frame and read it, which fails once sites have their own origin. Site files carry `Access-Control-Allow-Origin: *` (next.config, the deployment route, the Caddy site block) so the capture can inline images and fonts. `tooltips.pageForScreenshot` is removed.
- **The deployments view warns when sites share the studio's origin**: `GET /api/w/{id}/hosting` returns `sitesMode`; `deployments.sameOriginWarning` names `SITES_ORIGIN`.

- **`docs/SECURITY_MODEL.md` describes what OSW Studio trusts and its boundaries**: listed in the docs viewer (`security-model`) and linked from `SECURITY.md`. `docs/SERVER_MODE.md` gains "Where Published Sites Are Served" and `SITES_ORIGIN`/`STATIC_PROXY` in its variable table; the VPS, publishing, custom-domain, self-hosted-domain, desktop and preview docs no longer describe sites at `/deployments/{id}/` on the studio's address as the only URL.

### Fixes
- **An OpenRouter 403 stops the task as a refused request, not a refused key**: `classifyProviderError` (`lib/llm/provider-errors.ts`) gives `blocked` for an OpenRouter 403 (moderation or guardrail) and for any provider's 403 worded as content moderation; only 401 and other 403s are `auth`. `blocked` is in `TERMINAL_CATEGORIES`, so the stopped card offers another model rather than a plain Continue, and shows the provider's message under Details (`SHOW_DETAILS`, also for `auth_expired`). It read as "OpenRouter did not accept the key", and Continue resent the same refused request.
- **A model that failed is not suggested again straight away**: every stop that is about the model is recorded, not only "Free models" rotations: in the orchestrator for a browser run, and in the store's `api_stopped` handler for a server run (`outcomeForStop`, `lib/llm/suggestions/observed.ts`). A `refused` outcome is kept for a day in localStorage `osw-model-refused` and counts as cooling down. The stopped card's next suggestion offered back the model the person had just left.
- **A server run on "Free models" stays on one free model until it fails**: `startServerGeneration` sends `freeModelCandidates` (the browser's free ranking, minus models cooling down) in `generationParams`; the server orchestrator runs on the first and `rotateFreeModel` moves down the list on a busy, missing or refused model, never back to one tried. The store records the model a `model_switched` passed over. Server runs sent OpenRouter's free router, which answered each request with a different model.
- **The thread names the model "Free models" is running on**: `model_picked` when a run picks one, `model_resolved` from `parseStreamingResponse` when OpenRouter's free router names the model answering, shown at the step where the model changed (`lastRouterModel`); both, and `model_switched`, are forwarded over SSE. "Free models" also moves past a model that refused (`switchedRefused`).
- **A request that stopped before any reply is left out of the model's history when a new message follows**: `MultiAgentOrchestrator.execute` drops trailing user messages (`dropUnansweredMessages`) unless the prompt is `CONTINUE_AFTER_STOP_PROMPT`, and saves the history as `conversation_replaced`; the thread still shows them. The model read the refused request and the new one as one task. `conversation_replaced` carries a copy of the messages, so a message added afterwards is not in it.
- **Restore and Retry sit after the response, not under the next message**: `EventProcessor` (`components/chat-panel/event-processor.ts`) attaches a `checkpoint_created` that arrives on an empty turn to the last closed turn (or to none, when the kept events start after that response), and none to a turn holding only the user's message (a server run's "Pre-generation snapshot", still in the checkpoints panel). A run's last step opens a turn and can end without adding to it, so the end checkpoint landed there and the next prompt joined that turn.
- **Server Mode deletes on the server before deleting locally**: `deleteOnServer` (`lib/vfs/auto-sync.ts`) awaits the DELETE and throws `ServerDeleteRefused` (`auth`, `forbidden`, `failed`; messages under `sync.deleteRefused`) unless it answers 2xx or 404. Every `autoDelete*` caller awaits it before its local delete: `deleteProjectServerFirst` (project manager, guided tour), `deleteSkill`, `deleteCustomTemplate`, `deleteTemplate` (interviews), and `ConfigManager.deleteModelTemplate` and `removeCustomProvider`, which are now async. Each fired the server delete without waiting, so an expired session removed the local copy and the server kept it.
- **An expired session clears the once-per-tab auto-pull flag**: `auto-sync.ts` removes `osw_auto_pull_done` from sessionStorage on `markAuthExpired`, and `markAutoPullDone` does not set it while the session is expired, so `autoPullAllProjects` runs again after logging back in. A project the server kept stayed hidden in that tab.
- **Background pushes stop on an expired session and count refusals as failures**: `buildFileDelta` returns `'unauthorized'` on a manifest 401, and `pushProject` skips without retrying; the next load's `reconcileProjectsToServer` pushes it. It retried three times, then showed `sync.failedKept`. `autoSyncSkill`, `autoSyncTemplate`, `autoSyncModelTemplate`, `autoSyncInterviewTemplate` and `autoSyncConnection` treat a `success: false` result as failed (`sync_fail`) instead of logging it as synced.
- **A deployment save waiting on the swap dialog stays unsaved**: `DeploymentDetail`'s `onSave` may resolve `false` (`handleSaveSettings` when it opens the swap dialog), which keeps `isDirty`. `handleSwapComplete` shows `deployments.swappedSettingsNotSaved` when the settings save after a swap fails. The edits read as saved before the swap ran, and a failed settings save still said "Project swapped and deployment republished".
- **Studio calls to `/api/w/` and `/api/admin/` raise the session-expired banner**: `SyncManager`, the deployments, members, workspaces, users and mail views, the database managers, the schema editor and viewer, the project swap dialog, the review panel and `deployment-selector` use `apiFetch` instead of `fetch`. A 401 showed only an "Unauthorized" toast, or nothing; `lib/api/__tests__/gated-fetch.test.ts` fails on a plain `fetch` to those paths.
- **The studio's review panel replies only as the team**: it sends `REVIEW_AS_TEAM_HEADER` (`lib/review/api-base.ts`), and the comment routes answer 401 with no account session, or 403 for an account that would act as a participant (`teamAccessRefusal`, `lib/review/access.ts`); the panel raises the expired banner on a 401. With the session expired, a reply fell back to a participant cookie the browser held and was posted as that client.
- **The schema editor opened from the Projects list uses the workspace routes**: `ProjectManager` passes `workspaceId` to `ProjectSettingsModal`, where it is now a required prop. Apply DDL, the SQL tab and the tables view called `/api/projects/{id}/database/...`, which does not exist.
- **The users view refreshes the edited user from the list it just loaded**: `loadUsers` returns the users; changing a role, revoking or granting access no longer makes an unchecked second `/api/admin/users` request, whose failure showed an error after the success toast.
- **A refused toggle, delete or clear in a deployment's Backend section shows a toast**: `functions-manager`, `scheduled-functions-manager`, `server-functions-manager`, `secrets-manager` and `logs-viewer` (`components/database-manager/`) show the server's `error`, or `backend.delete*Failed` / `clearLogsFailed` / `update*Failed`. They only logged to the console.
- **`/api/generate` passes on the provider's reason for a 401 or 403**: a `blocked` refusal answers with the provider's own message and moderation `reasons`; an `auth` error keeps the key hint and adds the message. Both answered "authentication failed. Check your API key" and dropped what the provider said.

### Tests
- **Coverage for the origin check**: `__tests__/middleware-origin.test.ts` and `__tests__/middleware-matcher.test.ts`; 403 classification in `provider-errors.test.ts`, `terminal-api-error.test.ts`, `limit-cards.test.tsx` and `app/api/generate/__tests__/error-class.test.ts`; stop records and notices in `multi-agent-orchestrator-stops.test.ts`, `ranking-edges.test.ts`, `streaming-parser-router-model.test.ts` and `lib/stores/__tests__/orchestrator-server-stop-outcome.test.ts`; server-first deletes and the pull flag in `lib/vfs/__tests__/server-first-delete.test.ts`; background sync with an expired session in `lib/vfs/__tests__/auth-expired-sync.test.ts`; the swap-pending save in `components/deployment-detail/__tests__/save-pending.test.tsx`; team-only review requests in `lib/review/__tests__/access.test.ts` and `app/review/__tests__/review-end-to-end.test.ts`; the banner from `SyncManager` in `lib/vfs/__tests__/sync-manager.test.ts`; the Backend section toast in `components/database-manager/__tests__/refused-action-toast.test.tsx`; the preview bridge in `lib/preview/__tests__/preview-bridge.test.ts`; the in-frame capture runtime and its request protocol in `lib/preview/__tests__/frame-capture.test.ts`, replacing `screenshot-clone.test.ts`; `frame-capture-libs.test.ts` fails when the served painter differs from node_modules; the shell in `preview-shell.test.ts`; the function proxy in `function-proxy.test.ts`, running the compiled interceptor; the storage stand-ins and the host store in `preview-storage.test.ts`; host routing in `__tests__/middleware-site-host.test.ts`, the redirect in `app/api/site-location/[...path]/__tests__/route.test.ts`, the desktop forwarder in `desktop/electron/__tests__/site-proxy.test.ts`; capture HTML in `lib/utils/__tests__/deployment-thumbnail.test.ts`, the page route in `app/api/deployment-pages/[deploymentId]/__tests__/route.test.ts`; the session cookie name in `lib/auth/__tests__/session-cookie.test.ts` and the ChatGPT cookie names in `app/api/auth/codex/__tests__/cookie.test.ts`. The `*-dom` preview tests send host messages with `source: window.parent`, since the frame's listeners now drop any other source.

## v1.105.3 - 2026-10-08

### Fixes
- **The HuggingFace Space's sign-in popup shows a close screen instead of the studio**: `app/page.tsx` renders `SignInRelay` (`components/sign-in-relay/`) for a relayed return (`isRelayedReturn`), which runs `finishRelayedSignIn` and asks to close the window; `useProviderSignInReturn` skips relayed returns. huggingface.co keeps the popup from closing itself, so it stayed open with the full studio loaded.

### Tests
- **Coverage for the relay screen**: `components/sign-in-relay/__tests__/sign-in-relay.test.tsx`, `app/__tests__/root-page-relay.test.tsx`, and `isRelayedReturn` / `finishRelayedSignIn` in the existing sign-in tests.

## v1.105.2 - 2026-10-08

### Fixes
- **OpenRouter sign-in should work inside the HuggingFace Space's embed**: `prepareSignIn` (`lib/auth/provider-sign-in.ts`) makes the PKCE pair before the click, so the popup opens straight at OpenRouter. In the Space, `useSignInStart` (`lib/hooks/use-sign-in-start.ts`) passes `returnTo`, the Space's huggingface.co page (`spaceId` from `/api/auth/hf/capabilities`), whose frame shares the embed's storage; that copy stores the key and posts on `SIGN_IN_CHANNEL`. huggingface.co's `Cross-Origin-Opener-Policy: same-origin` left the popup on about:blank, reported as blocked.

### Tests
- **Coverage for the relayed sign-in**: `lib/auth/__tests__/provider-sign-in.test.ts` (prepared and relayed popups), `lib/hooks/__tests__/use-provider-sign-in-return.test.tsx` (broadcast and pickup), `lib/hooks/__tests__/use-sign-in-start.test.tsx` and `app/api/auth/hf/capabilities/__tests__/route.test.ts` (`spaceId`).

## v1.105.1 - 2026-10-07

### Fixes
- **The language choice holds inside the HuggingFace Space's embed**: `setLocale` (`lib/i18n/actions.ts`) takes `{ embedded }` from `isEmbedded` (`lib/i18n/config.ts`) and, in a frame over HTTPS, writes `osw_locale` as `SameSite=None; Secure; Partitioned`. The Lax cookie was neither stored nor sent in the huggingface.co iframe, so the language menu and the first-visit offer changed nothing there.

### Tests
- **Coverage for the framed locale cookie**: `lib/i18n/__tests__/actions.test.ts` checks the cookie attributes embedded, unembedded and without HTTPS; `use-locale-switch.test.tsx` checks the flag reaches `setLocale`.

## v1.105.0 - 2026-10-06

### Translations
- **The interface renders in English, Finnish and Korean**: `next-intl` 4.14.8 with a cookie locale (`osw_locale`, `lib/i18n/config.ts`), no routing. `setLocale` (`lib/i18n/actions.ts`) is the only writer and ignores a value that is not a supported locale; controls switch through `useLocaleSwitch`. `i18n/request.ts` deep-merges `en` under the active locale, so a missing key renders English. Messages in `messages/{en,fi,ko}.json`, typed through `global.d.ts`. Selector in Settings › Appearance. The guided tour stays English.
- **`LanguageOfferSlot` offers the browser's language once on a first visit**: `LanguageOfferSlot` (`components/language-offer/`) decides on the server from `Accept-Language` (`detectOfferLocale`, which stops at English) and the absent cookie. Either answer writes the cookie. Offer strings live in `lib/i18n/offer.ts`, since they show before their language is active.
- **Code outside components translates through `translator()`**: `lib/i18n/runtime.ts`, registered by `TranslatorBridge` in `app/layout.tsx`; it returns key paths before registration and on the server. Used by store toasts, `sync-manager`, `upload-file`, `codex-auth`, `template-service` (`templatesUi.errors.*`) and `templates-service`.
- **Registry tables are translated by id through lookup hooks**: `lib/i18n/use-*.ts` for templates, blocks, interviews, runtimes, skill groups, style properties, model templates, provider descriptions, template intents and approval sentences (`useApprovalSentence`), plus `useRoleLabel` in `components/views/role-label.ts`. The English in each constant is the fallback. `SCOPE_SUMMARY` (`lib/mcp/scopes.ts`) and `LOCAL_CONTEXT_HELP` (`lib/llm/local-context.ts`) moved into the messages.
- **Built-in templates show translated names and export English ones**: `template-manager` exports a built-in's name and description from `BUILT_IN_TEMPLATES`, not the translated list copy. `createDemoProject` (`components/project-manager/index.tsx`) names the demo after the translated catalog entry; "Multi-File Demo" is gone.
- **Archive import and export issues carry a message code**: issues and failures hold `text: {key, values}` beside the English `message` (`said`, `ArchiveError`, `ARCHIVE_EN` in `lib/vfs/archive/text.ts`), worded by `useArchiveMessage`. `ARCHIVE_EN` must equal `en.json`'s `archive`.
- **Checkpoints, quick-edit steps, mail and telemetry store codes worded at render**: optional `CheckpointLabel` on checkpoints (`projectOpened`, `preGeneration`, …, `useCheckpointLabel`; older checkpoints keep their English description). `TallyStep` drops `label` for `phraseStep`; `TallySummary` is `failed`/`stopped`/`changed`; `collate` returns a `CollatedLine` for `phraseCollated`; stop-reason chips are ids (`STOP_REASONS`; `STOP_REASON_PROMPT` removed); `useAudioRecorder` reports a `RecorderError`. `mail-logic.ts` takes a translator; telemetry `disclosure` is a `DisclosureLineKey`.
- **Errors thrown only to be logged stay English; errors a toast shows are translated**: `auto-sync`, template export and review comments keep English marked `// i18n-ignore`. Translated: the skills parser and service (`skills.errors.*`), sync's network fallback (`sync.networkError`) and backup import, whose progress is a `BackupImportStage` code worded in `data-pane`.
- **Refusal prompts sent to the agent have an English twin of the UI copy**: `refusalAgentPrompt`, `lossAgentPrompt`, `tokenAgentPrompt` (styles), `imageRefusalAgentPrompt`, `textRefusalAgentPrompt` and Describe's `WELCOME_TEXT` (`components/describe-mode/welcome.ts`) keep English for the agent while the UI wording is translated. Server API responses, licences and brand names stay English; `// i18n-ignore: <reason>` marks a deliberate line.
- **Dates, numbers and ages use the app locale**: `useLocalFormat` (`dateTime`, `number`, `relativeTime`, `recent`, `age`, `bytes`) in `lib/i18n/use-local-format.ts`, in the viewer's time zone. `date-fns`, `formatCompactAge` (`lib/utils.ts`), `CostCalculator.formatCost` and the chat panel's `formatTokenCount` are removed.

### Providers
- **Pollinations and Vercel AI Gateway are built-in providers**: `pollinations` (`gen.pollinations.ai/v1`) and `vercel` (`ai-gateway.vercel.sh/v1`) in `lib/llm/providers/registry.ts`. `/api/models` reads Pollinations `tools`/`health` (community models left out) and Vercel `tags` (`tool-use`, `free`) and pricing; `/api/validate-key` checks `/account/key` and `/v1/credits`. `ProviderModel` gains `free` and `health`.
- **OpenRouter signs in with OAuth PKCE in the browser**: `lib/auth/provider-sign-in.ts` (`startSignIn`, `completeSignIn`), return handled by `useProviderSignInReturn` in both mode roots, pending sign-ins in localStorage `osw_provider_sign_ins`. OpenRouter drops the callback's query, so a bare `?code=` matches the newest pending OpenRouter sign-in; a return with a `state` (HuggingFace's) is left alone. `signInReturnProject` reopens the project. A popup is used inside a frame, from a stopped task's card and from Settings › Connections › OpenRouter (redirect on desktop). Server mode's `/` (`app/page.tsx`) carries the return's query on.
- **A pasted key is matched to its provider by shape**: `detectKeyProvider` (`lib/llm/providers/key-detect.ts`). A key several providers could have issued is sent nowhere until the person picks one (`checkPastedKey` in `components/chat-panel/connect-options.tsx`), then checked with that provider only. `verifyApiKey` (`lib/llm/llm-client.ts`) throws when the check could not run and `/api/validate-key` answers 502 when it cannot reach the provider; `validateApiKey` wraps it as a boolean.
- **OpenRouter lists "Free models" first and gives it to an account that never bought credit**: `FREE_MODELS_ID` (`osw/free-models`) in `lib/llm/suggestions/free-models.ts`, added by `loadProviderModels` (not cached). The orchestrator resolves it per run to the top free suggestion (`freeModelPick`), else `openrouter/free`; `/api/generate` maps an unresolved id the same way. `fitModelToAccount` (`lib/llm/models/global-auto-assign.ts`) assigns it when the key reports `is_free_tier`, after every connect and at load; `connectSettled` lets a held message wait for every connect in flight (`trackConnectSettling` chains them).

### AI Orchestration
- **`/api/generate` error bodies carry a `code`**: `classifyProviderError` and `classifyGeminiError` in `lib/llm/provider-errors.ts` (`rate_limited`, `model_busy`, `daily_limit`, `credit_exhausted`, …, plus `retryAfterMs`/`resetAt`). `OswsProviderAdapter.classifyError` reads it before the keyword fallback; a 429 phrased "rate-limited" was classed as `credit_exhausted`. Spent allowances and busy models are no longer retried.
- **A provider error stops the task instead of pausing it**: `onProviderError` (was `onPausableError`; `ProviderApiError`, was `PausableApiError`) emits `api_stopped` (`errorCategory`, `canRetrySame`, `quota` from `/api/provider-status`, `alternatives`, `suggestion` from `nextModelAfter`) and returns `stop`. Removed: the `'continue'` answer, `error_paused`, `continue()`, `pauseResolve`, `continueGeneration`/`canContinueGeneration`, `GenerationTask.pausedMessage`, `SHELF_VERBS`; the generation shelf's paused action opens the project. Continue is `continueAfterStop` (`lib/llm/continue-prompt.ts`), a new turn. `error_stop` tracks `task_fail` with `reason: 'api_error'`.
- **"Free models" passes a busy or missing free model over for the next suggestion**: `MultiAgentOrchestrator.rotateFreeModel` ranks with `freeOnly: true` (so the `openrouter/free` fallback rotates on paid accounts too), emits `model_switched` and answers `onProviderError` with `retry`, which resends without the error as feedback. A model the user picked is never changed.
- **Model suggestions rank by benchmark and observed results**: `lib/llm/suggestions/` (`rankModels`, `modelKey`, `buildSnapshot`). Bundled `bundled-scores.json` (OpenRouter Data API, as of 2026-10-02), refreshed daily through `/api/model-scores` with the user's OpenRouter key, waiting an hour after a failed attempt (`osw-model-scores-attempt`). Per-browser outcomes in localStorage `osw-model-observed` (`recordAgentOutcome`; none for the `openrouter/free` router).
- **`generate-image` works in server-side runs**: the server delegates it to the browser, which holds the image model and key (`awaitImageResult`, `image_requested`, `handleImageRequested`, `imageModelFor` in `lib/llm/image-gen.ts`, also used by the orchestrator in place of `getModelOutputModalities`). Each request has a `requestId` in `task.pendingImages` (`lib/server-generate/image-requests.ts`); the first tab to claim it at `/api/server-generate/image-claim` generates it and answers `/image-result`. Server-side runs had no image capability.

### UI
- **The sidebar footer holds a help menu and a language menu**: `components/sidebar/index.tsx` footer row replaces the pin button; Guided Tour, About, Discord and GitHub left `SIDEBAR_ITEMS`. The pin toggle is a labelled outline button with `PanelLeftClose`/`PanelLeftOpen`; the logo no longer pins. The menus are `MenuPill` triggers (`components/ui/menu-pill.tsx`); `LanguageMenu` and `LanguagePill` (`components/language-menu/`, the pill also on `/admin/login` and `/admin/register`). The menus are non-modal and keep an unpinned sidebar open (`onHoverChange`).
- **Community links point to GitHub Discussions**: `DISCUSSIONS_URL`, `REPO_URL`, `SPACE_URL` in `lib/constants/links.ts`, used by the sidebar, dashboard, About dialog and project pages. Removed: `components/ui/discord-icon.tsx`, the revoked `discord.gg/mAJ8Ss4u`. The About dialog's Space link pointed at a missing `otst/oswstudio`.
- **A first visit opens a starter project on the HF Space, hosted and desktop**: `opensFirstProject` and `createFirstProject` (`lib/first-run.ts`), from `StudioApp` and, in server mode, `PageWrapper` (only when `fetchSyncStatus` and the local store list no projects). A git clone and a self-hosted server open on the projects page. Named by `projects.firstSiteName`.
- **The guided tour starts from a first-visit card, not automatically**: `useTourOffer` (`lib/hooks/use-tour-offer.tsx`) shows `TourOfferCard` (`nav.tourOffer.*`) once per browser in the studio view, after the analytics disclosure is answered (`isDisclosurePending`, `DISCLOSURE_SETTLED_EVENT` in `lib/telemetry/disclosure-state.ts`). Settings `tourOffered` (`configManager.hasOfferedTour`/`setTourOffered`); a stored `hasSeenGuidedTour` counts as offered. With no project open the card adds Create a project (`project_create` method `tour_offer`). Removed: the projects page's auto-start and `configManager.hasSeenTour`/`setHasSeenTour`.
- **The tour's demo project follows each step's `location`**: `PageWrapper` and `StudioApp` open and close it from the step, `PageWrapper` handles `tour-navigate-home`, and cleanup calls `autoDeleteProject` for the server copy. The project manager reloads on `projectsChanged` and shows the grid while the tour runs. The `wrap-up` step is removed. The card (`components/guided-tour/overlay.tsx`) moves to the top when it would cover more of the highlighted element at the bottom.
- **An empty chat shows ways to connect and a one-time tip**: `ConnectChooser`/`ConnectOptions` in `components/chat-panel/connect-options.tsx`, options per `detectDeploymentType`, also in quick edit. A message sent before connecting is held in sessionStorage `osw_held_prompt:<projectId>` and sent once a model is connected; one with attachments is not held. `chat.firstPromptTip`, a dismissable tip above the suggestions, shows until a suggestion is picked, a conversation has a message or it is dismissed (settings `firstPromptTipDone`).
- **A stopped task renders as a card with ways to continue**: `StoppedCard` and `LimitNotice` in `components/chat-panel/limit-cards.tsx`; event processor items `api_stopped` (old `error_paused` events render the same, without actions) and `notice` for `retry` and `model_switched`; model names through `modelLabel`. `ContinueOnConnect` continues once a connected provider appears (`isProviderConnected`). Shows OpenRouter's $10 step when the daily limit is 50; an error with no provider uses `limits.titleOtherNoProvider`.

### Security
- **Function routes keep OSW Studio's cookies away from function code**: `lib/edge-functions/http-boundary.ts` (`functionRequestHeaders`, `functionResponseHeaders`) in `app/api/deployments/[id]/functions/[...path]/route.ts`. Functions receive `cookie` without `osw_` cookies; a `Set-Cookie` for an `osw_` name or with no name is dropped and `Domain` removed; response headers are content, caching, `location`, `etag`, `last-modified` and `x-` less `RESERVED_X_HEADER` (`x-accel-*`, `x-sendfile`, `x-middleware-*`, `x-nextjs-*`, `x-instance-api-key`). Functions received `osw_session` and `osw_codex_rt` and could set any header. `x-` request headers now reach functions.
- **Public deployment routes stay inside the deployment's folder**: `deploymentStaticFile` (`lib/compiler/deployment-static-dir.ts`) checks the id against `^[A-Za-z0-9_-]+$` and joins through `resolveWithin`, in `app/deployments/[id]/route.ts` and `[...path]/route.ts`. Under `next start` without `STATIC_PROXY`, `%2e%2e%2f` reached the route as `../` and served files outside it, such as `.env`.
- **Function `fetch` refuses private addresses in every environment**: `publicFetch` (`lib/edge-functions/public-fetch.ts`) fetches through undici with `publicAgent`, whose `publicLookup` refuses a private answer at connect time. It follows 301/302/303/307/308 by hand up to `MAX_FETCH_REDIRECTS` (5), checking each hop's scheme, counting hops against `MAX_FETCH_REQUESTS` and dropping credentials across origins. `isPrivateUrl` is removed: it was skipped outside production, matched hostnames as text and missed IPv6, `0.0.0.0`, most of `127/8`, `100.64/10` and redirects. `FUNCTIONS_ALLOW_PRIVATE_FETCH=true` lifts the check. `undici` is a direct dependency.
- **`isPrivateIp` covers special-purpose ranges**: `lib/web/ssrf-guard.ts` also refuses 192.0.0/24, 198.18/15, 224/4 and up, IPv6 multicast, site-local and local-use NAT64 `64:ff9b:1::/48`, and checks the IPv4 address inside NAT64 and 6to4 addresses.
- **Function SQL is refused on `scheduled_functions` and allowed on `sessions`, `pageviews` and `interactions`**: `FORBIDDEN_TABLES` in `lib/edge-functions/database-api.ts`. Function code could read `scheduled_functions`. The other three are site tables now that analytics lives in `analytics.sqlite`; the Blog template's register and login failed with "Access to system table".

### Fixes
- **Template database tables are created with the project**: `applyProjectDatabaseSchema` (`lib/vfs/project-schema.ts`) posts the schema to the current workspace's `/api/w/{id}/projects/{id}/database/query` (`getAutoSyncApiUrl`); it posted to an unscoped route that does not exist. `extractBackendFeatures` reads the project database from the workspace's directory (`SQLiteAdapter.getProjectDatabaseBaseDir`); it looked in the shared data directory. A published Blog's register, login and comments failed with "no such table".
- **`db.run` returns `lastInsertRowid` to functions**: `RuntimeDatabase.executeRawSQL` returns it for writes and `createDatabaseAPI` passes it on. It was always 0, so the Blog template's register failed on its `sessions` foreign key.
- **OpenRouter image generation goes through the Image API**: `generateOpenRouterImage` in `app/api/generate-image/route.ts` posts to `/images` (`aspect_ratio`, and `resolution` from `image_size`, resent once without both on a 400) and reads `data[0].b64_json`; the request's `modalities` is not read for OpenRouter. Image models OpenRouter added since its Image API launched, such as `qwen/qwen-image-3`, failed with "cannot be used with the chat/completions endpoint".
- **An image generation call is given 240s**: `imageGenTimeoutMs` (`lib/llm/image-gen-timeout.ts`, `IMAGE_GEN_TIMEOUT_MS`) replaces the route's 120s default. A server-side run waits `imageDelegationTimeoutMs`, 30s longer, in `awaitImageResult`; it waited a fixed 180s.
- **A new project opened right after creation keeps its sync revision**: `createOpenCheckpoint` (`components/workspace/open-checkpoint.ts`) reads the record again once its first checkpoint exists. The write used a copy taken before the first push finished, erasing `revision`/`serverUpdatedAt`, so every later push and publish failed with a 409 "edited on another device".
- **Server-mode runs add their cost to the project**: `recordServerUsage` (`lib/stores/slices/orchestrator.ts`) passes each `usage` event's `taskCost` to `vfs.recordServerTaskCost`, one `sessionHistory` entry per task (`sourceTaskId`, now on every SSE event; `taskTokens`), adding only the difference so replays count once. Cost writes and the post-run pull share `queueProjectWrite`. The header cost stayed at the IndexedDB total.
- **A stopped run's unfinished tool call shows as stopped**: `EventProcessor` (`components/chat-panel/event-processor.ts`) marks tools still `pending`/`executing` at `stopped` or `task_complete` with a `stopped` status. They kept a spinner.
- **Guided Tour starts in server mode**: `PageWrapper` passes `onStartTour` to the sidebar and dashboard; other pages hand over with `?tour=start`. The sidebar item did nothing, and the dashboard pushed `/admin/projects?tour=start`, which nothing read.
- **The code editor loads Monaco without an unhandled rejection**: `useLoadedMonaco` in `components/editor/multi-tab-editor.tsx` replaces `@monaco-editor/react`'s `useMonaco`, which rejected `{type: 'cancelation'}` uncaught when the editor unmounted mid-load (Next's dev overlay showed "1 Issue").
- **The SEO tab's Open Graph preview shows a failed image as text**: `seo-tab.tsx` renders the fallback through React (`failedOgImage`) instead of writing `innerHTML`, so a new URL is tried again; the replaced markup stayed after the URL changed.
- **Settings › Connections renders the same on the server and the client**: `ConnectionsPane` reads connections from storage only after hydration. The server HTML said no providers were connected.
- **A ChatGPT sign-in states its expiry once**: `expiryInfo` in `components/settings/codex-auth-panel.tsx`. An expired token read "Expires in Expired (will auto-refresh)".
- **Registration re-enables its button after an error**: `app/admin/register/page.tsx` stayed on "Creating account…" after a refused email or password.

### Tests
- **Coverage for this release's routes, hooks, components and translations**: new suites under `lib/i18n/__tests__/`, `lib/llm/__tests__/`, `lib/llm/suggestions/__tests__/`, `lib/auth/__tests__/`, `lib/hooks/__tests__/`, `lib/edge-functions/__tests__/`, `lib/server-generate/__tests__/`, `lib/vfs/archive/__tests__/`, `app/api/*/__tests__/`, `app/deployments/[id]/__tests__/` and `components/*/__tests__/`. Display logic moved into named helpers to be testable: `review-logic.ts` (`reviewStatus`), `filterSkills`, `costTotalFormat`, `withLocalWelcome`, `describeBackendRecord`, `templateDisplayName`, `tourLocksInput`/`mayLeave`/`continueHandler`; `fmtPrice` is shared in `components/providers-models/format.ts`. Executor fetch tests stub `node:dns` and route undici's `fetch` to the stubbed global. `glossary.test.ts` matches prose with ICU arguments stripped.
- **A `createTranslator` test translator hides broken messages**: next-intl returns the key path for a missing key or a formatting error, so `not.toMatch(/\{/)` passes on a broken message. Tests that check rendered copy build the translator with an `onError` that throws. `messages.test.ts` checks every `fi`/`ko` message uses only arguments its `en` source declares (`PASSED_BUT_UNUSED_IN_ENGLISH` lists two Finnish tally plurals).

## v1.104.1 - 2026-09-29

### AI Orchestration
- **A loop or conditional gets one short answer from `bash`**: `SHELL_KEYWORDS` in `lib/vfs/cli-shell.ts` catches bash control-flow words before the unknown-command path. `for f in a b; do echo $f; done` splits on `;` into three unknown commands, so it answered with three copies of the command list, about 9KB, without saying loops are unsupported. An ordinary unknown command still gets the list.
- **`grep` and `rg` share their file walk and context expansion**: `lib/vfs/shell/commands/search-shared.ts` holds `searchableFiles`, `contextWindow` and `matchingLines`, which both commands carried their own copies of. The flag parsers stay separate. Neither command's output changes.

### Server Mode
- **Caddy serves published sites from a path outside the build directory**: `resolvedPublicRoot` in `lib/caddy/regenerate.ts` resolves `process.cwd() + '/public'` with `fs.realpath` before writing it into the Caddyfile. Next's standalone server chdirs into `.next/standalone`, so the root pointed inside `.next` and a deploy that removes that directory took every published site offline for the build's duration. Caddy reads them off disk, so stopping the app does not help. Where `public` is a real directory the path is unchanged.

### Tests
- **Coverage for the loop refusal, the extracted helpers and the published-site path**: `lib/vfs/__tests__/cli-shell-control-flow.test.ts`, `lib/vfs/__tests__/search-commands.test.ts` and `lib/caddy/__tests__/public-root.test.ts`. `rg` had no test before this.
- **A path assertion needs the whole line**: `toContain('root * /x/public')` is satisfied by `root * /x/public/deployments`, so a prefix match cannot tell a correct root from one a level deeper. `public-root.test.ts` compares the set of whole `root *` lines.

## v1.104.0 - 2026-09-29

### MCP
- **`files_write` stores a file's bytes from base64 or text**: `lib/mcp/server.ts` takes `path`, `content` and `encoding` (`utf8` or `base64`), checks `isSafeVirtualPath`, and refuses `utf8` for a path `isTextExtension` calls binary. Writes go through `VirtualFileSystem` (`updateFile` when the path exists, else `createFile`), 10MB decoded per call. `decodeBase64Strict` re-encodes and compares rather than letting `Buffer.from` drop characters, and slices the pooled buffer.
- **`files_read` returns a file's bytes, 256KB at a time**: answers with type, mimeType and size, `maxBytes` up to 4MB, and `truncated` with the real size past that. Refuses `utf8` for stored bytes. Every `bash` write stores a string and `cat` refuses a binary file, so an image could not be put into a project or taken back out.
- **`files_upload_url` and `files_download_url` return a one-time URL for `curl`**: served by `app/api/mcp/files/[token]/route.ts` (PUT stores, GET answers bytes as `content-disposition: attachment` with `nosniff`, both report `sha256`). Tokens in `lib/mcp/transfers.ts`, single-use, ten minutes, bound to grant and path; `overwrite` defaults false; 10MB cap. `writeProjectFile` (`lib/mcp/files.ts`) is shared with `files_write`.
- **`bash` points a refused binary command at the file tools**: `withBinaryHints` in `lib/mcp/server.ts` appends a `files_download_url` or `files_upload_url` pointer to the `cat` binary refusal and the byte-format redirect refusal.
- **`initialize` returns server `instructions`**: `SERVER_INSTRUCTIONS` in `lib/mcp/server.ts` is passed as the `McpServer` `instructions` option: that `bash` is the file interface, that `files_upload_url` / `files_download_url` move bytes by URL and `files_write` / `files_read` inline, that a project may hold `/.PROMPT.md`, and that `curl localhost/` renders without publishing. The server registers no resources or prompts.
- **The MCP endpoint requires server mode, not just `MCP_ENABLED`**: `mcpEnabled` in `lib/mcp/auth.ts` also checks `NEXT_PUBLIC_SERVER_MODE`. Browser mode has no accounts or workspaces to authorize against, so the flag alone exposed dynamic client registration and a consent route that could not run. The docs and the MCP settings pane already required server mode.

### AI Orchestration
- **A redirect into an image, font, audio or video file is refused**: `writeRedirect` in `lib/vfs/shell/runtime.ts` checks `getFileTypeFromPath` against `BYTE_FORMATS` and answers with a `curl -o` pointer instead of storing text under a binary name. SVG and extensionless names are unaffected.

### Preview
- **A stylesheet's relative `url()` resolves from its own folder**: `processUrlReferences` in `lib/preview/virtual-server.ts` takes the CSS file's path and resolves `./`, `../` and bare references against it (`resolveFrom`, query and fragment set aside for the lookup, fragment kept), falling back to the root-based `normalizePath` lookup. Self-hosted fonts referenced as `url("./x.woff2")` loaded when published and were missing in the preview.

### Server Mode
- **Deployment SEO settings fill a page's missing tags rather than duplicating them**: `injectSeoMetaTags` in `lib/publishing/html-processor.ts` tests the page's `<head>` with `headHasTag` and skips the `<title>`, description, keywords, `og:image` and canonical it would otherwise add where the page has its own; `og:url`, `og:type`, `twitter:card` and robots still replace (`removeHeadTags`). The tags were appended, so a page carrying its own title published with two.
- **The OG Title, OG Description and Twitter card type settings are published**: `injectSeoMetaTags` reads `seo.ogTitle`, `seo.ogDescription` and `seo.twitterCard`, with `og:title` / `og:description` falling back to `seo.title` / `seo.description` and `twitter:*` mirroring them. None of the three was read: the Open Graph text came from the meta title and description, and the card was always `summary_large_image`. The Card Type select in `components/publish-settings/seo-tab.tsx` shows Summary Large Image as the unset default to match.
- **A write is metered at the adapter, not at the route**: `lib/api/storage-quota.ts` (`admitWorkspaceWrite`, `workspaceStorageMb`, `forgetWorkspaceStorage`) is called from `SQLiteAdapter.createFile` / `updateFile`, which the sync routes, server-mode generation, `bash/execute` and the MCP tools all reach. `app/api/w/[workspaceId]/sync/files/route.ts` was the only one of 39 workspace write routes to check `max_storage_mb`, and compared usage before the write, so a workspace at 99% admitted a push of any size. A `workspaceId` is unset for the shared database, so a desktop install carries no limit.
- **A file's size is taken from its content, not from its stored row**: `contentByteLength` in `lib/vfs/adapters/sqlite-adapter.ts` measures an `ArrayBuffer` by `byteLength` and a string by its UTF-8 length, and runs before `encodeFileContent`, because a binary file's row holds a blob-store hash rather than its bytes.
- **The metered total counts the published output**: `measureWorkspaceBytes` walks the workspace directory and every deployment's static directory as one total, so hardlinked blobs count once. `getCachedStorageMb` in `sync/status/route.ts` is removed; the figure shown in Server Sync and the figure the gate enforces now come from the same function.
- **Publishing is admitted against the storage limit**: `publishDeployment` (`lib/publishing/publish-deployment.ts`) calls `admitWorkspaceWrite` before `buildStaticDeployment`, with the project's stored bytes (`SQLiteAdapter.projectContentBytes`) less what the deployment's output directory already holds, and returns 403 when it will not fit. A publish could put a workspace over its limit and leave every later file write refused. The check precedes the build because a build clears the output directory first.
- **Deleting a deployment or project drops the cached storage reading**: `forgetWorkspaceStorage` is called from `unpublishDeployment` (which takes a `workspaceId` for it), the deployment `DELETE` route and the project `DELETE` route in `sync/projects/[id]`. The measurement is cached for a minute, so freed space did not count until it expired. `SQLiteAdapter.listDeploymentIdsSync` replaces the inline query in `admitWrite`.

### Tests
- **Coverage for the connector's byte tools, the storage limit, stylesheet lookup and SEO tags**: `app/api/mcp/__tests__/files-write.test.ts` and `files-transfer.test.ts`; `lib/api/__tests__/storage-quota.test.ts`; `lib/vfs/adapters/__tests__/quota-at-the-write.test.ts`; `app/api/w/[workspaceId]/__tests__/delete-frees-storage.test.ts`; `lib/mcp/__tests__/enabled-gate.test.ts`; `lib/preview/__tests__/css-relative-urls.test.ts`; `lib/publishing/__tests__/seo-tag-replacement.test.ts`; `lib/vfs/__tests__/cli-shell-binary-redirect.test.ts`.
- **A quota test needs binary content to be worth anything**: only a binary file takes the blob-store path, where the row holds a hash instead of the bytes, so a text-only test cannot tell a gate that measures the content from one that measures the stored row. `quota-at-the-write.test.ts` writes an `ArrayBuffer` for that reason.

## v1.103.0 - 2026-09-24

### MCP
- **A built-in MCP server is at `/api/mcp`**: `lib/mcp/server.ts` (`createOswMcpServer`) registers `projects_list` / `projects_get` / `projects_create`, `bash`, `backend_list` / `backend_upsert` / `backend_delete`, `deployments_list` / `url` / `create` / `update` / `publish` / `unpublish` / `sql`, `analytics_overview` and `agent_run` / `agent_status` / `agent_cancel`. No project delete, members or connections, and secret values are never returned. The route answers only when `MCP_ENABLED=true`, otherwise 404.
- **Connecting runs OAuth against the instance's own login**: `/api/mcp/oauth/register` (RFC 7591), `/authorize`, `/token` and `/revoke` (RFC 7009) with PKCE S256, discovery at `app/.well-known/oauth-authorization-server` and `oauth-protected-resource`, and `resource_metadata` on the 401 `WWW-Authenticate`. `mcpOauthRateLimiter` in `lib/analytics/rate-limiter.ts` caps those endpoints; `next.config.ts` sends `X-Frame-Options: DENY` for `/mcp/*`.
- **A grant covers one workspace and the scopes that role can give**: `app/mcp/authorize/page.tsx` lists the account's workspaces and `grantableScopes` narrows by role; every tool call re-checks the grant's workspace and `verifyWorkspaceAccess`. Grants live in `mcp_grants` (`lib/mcp/store.ts`) with `last_used_at`. Settings shows them with Disconnect, and `GET` / `DELETE /api/mcp/grants` do the same over HTTP.
- **An account's grants go with its access**: `revokeMcpGrantsFor` in `lib/auth/system-database.ts` sets `mcp_grants.revoked` and drops the grant's `mcp_tokens` rows, called from `revokeWorkspaceAccess` for that workspace and from `deactivateUser` and `updateUser({ active: 0 })` for every grant the account holds. Guarded on `sqlite_master`, so an instance that never ran `initMcpSchema` is untouched.
- **A held consent request survives an external login**: `GET /api/mcp/oauth/hold` stores the authorization query in the `osw_mcp_pending` cookie (HttpOnly, Lax, ten minutes) and sends the visitor to the configured login; `middleware.ts` spends the cookie on the next authenticated page GET and returns to `/mcp/authorize`. `lib/mcp/pending.ts` holds the cookie name and `pendingAuthorizationIsWellFormed`, with no `server-only` import so the Edge runtime can read it.
- **`bash` runs against the workspace SQLite adapter**: tools reach files through `getWorkspaceAdapter`. `BASH_DESCRIPTION` lists only the commands that work over the connector, leaving out `build`, `python`, `python3`, `lua`, `sqlite3` and `status`. `agent_run` is claimed by an open tab (`POST /api/mcp/agent-claim`) because provider keys stay in `localStorage`.
- **Connector changes reach an open tab without a reload**: `notifyProjectChanged` and `notifyDeploymentChanged` (`lib/mcp/notify.ts`) emit `mcp_project_changed`, `mcp_run_requested` and `mcp_deployment_changed` on the SSE bus; the orchestrator pulls the project through `pullAndCheckpointServerFiles`, the deployments view reloads on `SERVER_DEPLOYMENTS_CHANGED`, and `McpActivityBanner` (`components/mcp-activity-banner`) names the client that is working.
- **The SSE stream stays open with no task running**: `reattachServerTasks` in `lib/stores/slices/orchestrator.ts` no longer schedules `disconnectSSE` five seconds after replay, so an idle tab still receives connector events. `SSEEventBus.hasListener` reports whether a tab is attached, which `agent_run` needs before it hands a task over.
- **Settings pane is `mcp`**: the sidebar and `UnifiedSettings` label it MCP (`id: 'mcp'`), and `?settings=connected-agents` maps to it. The pane carries the endpoint to copy and the grant list.

### Security
- **User SQL is checked against the statement's query plan**: `validateNotSystemTable` in `lib/vfs/adapters/runtime-database.ts` reads written tables from `EXPLAIN` opcodes (`OpenWrite`, `Clear`, `Destroy`), keyed by page and schema against `main.sqlite_master` and `temp.sqlite_master`, and refuses triggers and temp objects named after a system table. The previous check matched statement text, so a write to `files` or `secrets` phrased around the pattern was accepted.
- **A user SELECT returns at most 5000 rows**: `MAX_RESULT_ROWS` in `runtime-database.ts` reads through `stmt.iterate()` and the result carries `truncated`. One statement could return a whole table, measured at 300,000 rows and about 2.6MB.
- **A piped command is gated stage by stage**: `pipelineStages` in `lib/llm/tool-registry.ts` splits on `|` and runs `checkCommandPermission`, `isWriteOperation` and `checkWriteScope` over every stage; `commandLineWrites` in `lib/llm/write-scope.ts` splits a command line on `\n`, `|`, `&&`, `||` and `;`. Only the first stage was inspected, so a write reached through a pipe in a read-only chat.
- **`verifyWorkspaceAccess` refuses an inactive account**: `getUserById` filters on `active` and only the admin shortcut consulted it, so a deactivated account holding a `workspace_access` row kept working. The `admin`, `desktop` and `instance-api` principals move ahead of the lookup, having no `users` row.

### Server Mode
- **Projects carry a server-owned `revision`**: SQLite `projects.revision` (migration `add_project_revision_v12`) starts at 0. `SQLiteAdapter.updateProject` does not write it; only `bumpRevision` does, in the same `runTransaction` as the file writes on `POST /api/w/{id}/sync/projects/{id}`, `POST .../sync/files` and `POST .../sync/projects`.
- **A push sends `baseRevision`**: `SyncManager.pushBatches` / `pushFiles` and `postProjectBatches` send the last observed revision; each 200's `revision` becomes the next batch's base. Mismatch is 409 `{ error: 'conflict', reason: 'stale', revision }`. Server Sync no longer passes `force: true`.
- **The client stores the ack on a fresh row**: `persistAcknowledgedRevision` in `lib/vfs/auto-sync.ts` loads the project, writes `revision` / `lastSyncedAt` / `syncStatus`, then `updateProject(..., { preserveUpdatedAt: true })`. `pushProjectWithFiles` uses `pushSingleProject` rather than metadata-then-`/sync/files`.
- **A 409 is not retried**: `pushProject` in `auto-sync.ts` calls `markSyncNeedsRetry` (`syncStatus: 'error'`, `saveManager.markDirty`, `osw-sync-needs-retry`) and returns. Conflict toast: open Server Sync. `silent: true` skips the toast (gallery reconcile). `pushProjectToServer` uses the same helper.
- **`localHasUnackedEdits` gates automatic pulls**: true when `updatedAt` is after `lastSyncedAt` (or `lastSyncedAt` is missing). `pullServerUpdates` then skips. `pullAndCheckpointServerFiles` adds new server files only, does not overwrite or delete local paths, and does not set `syncStatus: 'synced'`.
- **Keep both forks then pulls**: `vfs.forkLocalDraft` copies files, settings, empty dirs and IndexedDB backend rows (new ids; schedules remapped to copied edge ids) to `{name} (local draft)`. `handleKeepBoth` then `handlePullSingle`. Conflicts sort first (`sortSyncItems`); the row shows Keep both, not push/pull. Bulk push/pull omit `conflict`. A successful pull sets `syncStatus: 'synced'`.
- **`checkServerUpdates` is true only for `server-newer`**: `conflict` is not a pull. `POST /sync/files` `replace` defaults to false; `replace: true` with `files: []` is 400. An empty server snapshot does not delete local files.
- **A new project's first push runs after the template**: `createProjectFromTemplate` calls `vfs.flushSyncTimeout`. `autoPullAllProjects` GETs `/sync/projects/{id}` and `persistAcknowledgedRevision` when local `revision` is missing.
- **Publish does not call `window.confirm`**: `handlePublish` in `deployments-view.tsx` starts the spinner immediately. `flushEditorToVfs` races `Promise.all(waiters)` against a 2s timeout. `getSyncManager(workspaceId)` is passed the workspace id.
- **Unpublishing removes what is served**: `unpublishDeployment` in `lib/publishing/publish-deployment.ts` calls `cleanStaticDeployment` (static output and review build) and clears `publishedAt` / `lastPublishedVersion`. `DELETE /api/w/{id}/deployments/{id}/publish`. Unpublish sits in the deployment card and row menus. The `deployment_routing` entry and slug are kept, so republishing serves at the same URL.
- **An unpublished deployment answers nothing**: `app/api/deployments/[id]/functions/[...path]` refuses with 404 `Deployment is not published`, and `processDeployment` in `lib/scheduler/deployment-scheduler.ts` skips it, so neither invocation nor cron reaches a deployment whose files have been removed. Both previously gated only on `databaseEnabled` and the function's own `enabled`.
- **`Deployment.enabled` is removed**: no serving path read it, so a disabled deployment kept being served. Gone from `Deployment` and `PublishSettings`, the Published switch in `publish-settings/general-tab.tsx`, `handleEnable` / `handleDisable` and the Disabled badges in `deployments-view.tsx` / `deployment-card` / `deployment-detail`, and the unused `getPrimaryPublishedDeploymentId`. Published state derives from `publishedAt` and `lastPublishedVersion`. The `deployments.enabled` and `site_info.enabled` columns stay, unread.
- **`/sync/backend-features` keeps a secret the payload omits**: `POST /api/w/{id}/sync/backend-features/{projectId}` writes the stored value back when the request carries the secret's name but no value, instead of clearing it. `pullAndCheckpointServerFiles` also runs `pullBackendFeatures`.

### Workspace
- **Opening a project does not restore the last save**: `Workspace` init no longer calls `saveManager.restoreLastSaved`. Discard still does, via `lastSavedCheckpointId` (Save writes `initialCheckpointId`). `Project opened` stays unpinned.
- **A user save is pinned at create**: `saveManager.save` calls `createCheckpoint` with `pinned: true` (`CreateCheckpointOptions.pinned`) and `unpinCheckpoint` on the previous save after the pointer advances.
- **A file write stamps `updatedAt`**: `noteContentEdit` on `createFile` / `updateFile` / `deleteFile` / `createDirectory` unless `saveManager.isDirtySuppressed`. `noteProjectEdit` is the public entry for the backend panel. `file-sync-handler` and `pullAndCheckpointServerFiles` run inside `runWithSuppressedDirty`. SQLite `updateProject` also `bumpRevision` when the adapter has it.
- **Discard and dirty follow the save pointer**: `handleRestoreCheckpoint` for Discard uses `saveManager.getSavedCheckpointId`. After restore, `updatedAt` is set to `lastSavedAt`. Reopen marks dirty when `updatedAt` is after `lastSavedAt` (else `lastSyncedAt`).
- **Save and leaving the project flush the editor**: `flushEditorToVfs` (`lib/vfs/flush-editor.ts`) dispatches `osw-flush-editor`; `multi-tab-editor` pushes `saveFile` for each `modified` tab into `detail.waiters`.

### Desktop
- **The desktop app serves on port 30011**: `desktop/electron/server-port.ts` (`DESKTOP_DEFAULT_PORT`, overridden by `OSW_DESKTOP_PORT`) pins the port instead of taking the first free one in [30011, 50000], and its fallback range stays below 32768. A connector is registered against a URL, and the old range reached into the ephemeral ports macOS allocates from 49152.

### UI
- **Docs pages have a Copy page control**: `components/docs-page-actions.tsx` (`DocsPageActions`, mounted in the title row of `components/views/docs-view.tsx`) copies the page's Markdown source to the clipboard, with a menu item that opens it as plain text in a new tab via a `text/plain` Blob URL.

### Tests
- **Coverage for revision, Keep both, pulls, MCP and access revocation**: `app/api/w/.../sync/projects/[id]/__tests__/revision.test.ts`; `lib/vfs/__tests__/save-manager.test.ts`, `check-server-updates.test.ts`, `sync-files-replace-default.test.ts`, `sync-end-state.test.ts` (ack persist, second-writer file kept), `pull-failure-recovery.test.ts` (unacked local-only file), `export-import.test.ts` (`forkLocalDraft`); `components/project-manager/__tests__/sync-item-order.test.ts`; `lib/mcp/__tests__/`, `app/api/mcp/__tests__/`, `lib/stores/__tests__/orchestrator-mcp-*.test.ts` and `orchestrator-sse-standing.test.ts`; `lib/auth/__tests__/access-revokes-mcp-grants.test.ts` and `workspace-access-guard.test.ts`; `__tests__/mcp-consent-resume.test.ts`; `lib/vfs/adapters/__tests__/runtime-sql-guard.test.ts` and `runtime-sql-limits.test.ts`.

## v1.102.1 - 2026-09-19

### AI Orchestration
- **Gemini functionCall parts become tool calls**: `lib/llm/gemini-adapter.ts` (`createGeminiToCompletionsTransformer`, `geminiToCompletionsResponse`) rewrites `candidates[].content.parts[]` into Chat Completions deltas: `functionCall` to `tool_calls`, `thought` parts to `reasoning`, `finishReason` and `usageMetadata` to `finish_reason` and `usage`. `/api/generate` relayed the Gemini body unchanged and the client parser read an empty response from every tool-calling turn.
- **Gemini tool turns replay with thought signatures**: `messagesToGeminiContents` in `lib/llm/gemini-adapter.ts` sends assistant `tool_calls` as `functionCall` parts and tool results as `functionResponse` parts, re-attaching `thoughtSignature` from `reasoning_details` entries of type `gemini.thought_signature` (keyed by tool call id, or `text`); calls with no stored signature get `GEMINI_SKIP_SIGNATURE`. Gemini 3.x returns 400 without them. `toGeminiContents` in `app/api/generate/route.ts`, which dropped both message kinds, is removed.
- **Gemini registry lists the 3.x models and defaults to gemini-3.8-flash**: `geminiModels` in `lib/llm/providers/registry.ts` has `gemini-3.8-flash` (the `getDefaultModel` case), `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-2.5-flash`, `gemini-2.5-pro`; `gemini-2.0-flash` is removed. Discovery in `/api/models` skips image, TTS, transcription, robotics, computer-use, omni, deep-research and antigravity models.
- **Local providers have a Context length setting**: stored per provider under `localContextLengths` in `osw-studio-settings` (`configManager.getLocalContextLength` / `setLocalContextLength`); edited by `components/settings/local-context-length.tsx` on the Connections pane's local-provider connect and edit views. `lib/llm/local-context.ts` holds `DEFAULT_LOCAL_CONTEXT_LENGTH` (32768), `resolveLocalContextLength` and `boundCompactionLimit`, and notes which servers take the value: Ollama per request; LM Studio and llama.cpp only at load or startup, so the setting must match them.
- **Compaction is bounded by the local context length**: `resolveCompactionLimit` in `multi-agent-orchestrator.ts` caps the resolved limit with `boundCompactionLimit` for local providers; the client sends the value as `context_length` in the generate request (`getLocalContextLength` on `ProviderAdapterConfig`) and as `localContextLength` in `ServerGenerationParams` (`ServerConfigManager.getLocalContextLength`).
- **Ollama requests use the native chat endpoint with the configured context**: `lib/llm/ollama-adapter.ts` (`buildOllamaChatBody`, `createOllamaToCompletionsTransformer`, `ollamaToCompletionsResponse`) sends `/api/chat` with `options.num_ctx` from `resolveOllamaNumCtx` (the setting, capped at the `/api/show` context length, cached per process in `/api/generate`) and rewrites the NDJSON stream into Chat Completions SSE. `app/api/generate/route.ts` sent Ollama's `/v1` endpoint, which ignores `num_ctx`, loaded every model at 4096 tokens and dropped the start of the prompt.
- **Server mode starts tasks on keyless local providers**: `startServerGeneration` in `lib/stores/slices/orchestrator.ts` and `POST /api/server-generate` require an API key only when `getProvider(provider).apiKeyRequired`; `taskManager.createTask` stores an empty key. Both refused with "Please set your Ollama API key" and "Missing required fields: ... apiKey", so a self-hosted instance could not run a local model.
- **Ollama discovery returns each model's trained context length**: the `ollama` case in `app/api/models/route.ts` returns `{ id, contextLength }` from `/api/show` instead of bare names, which `normalizeModelEntry` defaulted to 128000.
- **A failed command chain does not complete the task**: `extractSignals` in `lib/llm/tool-executor.ts` ignores `--complete` when the tool result starts with `Error:`. `edit && build && status --complete` with a failed edit stopped at the edit, but the flag in the command text ended the task with the edit unapplied.
- **Local providers resolve to 127.0.0.1**: `ollama`, `lmstudio`, `llamacpp` and `meshllm` `baseUrl` in `lib/llm/providers/registry.ts` use `127.0.0.1` instead of `localhost`, which Node can resolve to `::1` where the server only listens on IPv4.
- **Unreachable local provider error states the endpoint and start command**: the network-error branch of `/api/generate` returns "Could not reach {provider} at {url}. Make sure it is running on the same machine as OSW Studio", with `ollama serve` for Ollama, instead of the internet-connection message. `docs/TROUBLESHOOTING.md` replaces the CORS section, which described browser-direct calls the app does not make.

### Settings
- **Connections pane checks an Ollama setup**: `POST /api/ollama/preflight` (`app/api/ollama/preflight/route.ts`, types in `lib/llm/ollama-preflight.ts`) runs `/api/version`, `/api/tags` and `/api/show` and returns `reachable`, `models`, `model_pulled`, `tools` and `context` rows with a fix command each, `hosted` on the unreachable row when `SPACE_ID` is set, `capped` on the context row when the model limit is below the setting. `components/settings/ollama-preflight.tsx` renders it under the Local Provider box with copy buttons.
- **`preflight_result` telemetry event**: added to `EVENT_CATALOG` in `lib/telemetry/events.ts` with the check ids that failed; `DISCLOSED_KEY` in `components/telemetry-bootstrap/index.tsx` is `osw-telemetry-disclosed-v4`, so the disclosure shows once more.

### Tests
- **Test coverage**: `lib/llm/__tests__/gemini-adapter.test.ts`, `gemini-live.test.ts`, `ollama-adapter.test.ts`, `local-context.test.ts`; `lib/config/__tests__/local-context-length.test.ts`; `app/api/ollama/__tests__/preflight.test.ts`, `app/api/generate/__tests__/ollama-route.test.ts`, `app/api/server-generate/__tests__/keyless-provider.test.ts`; `components/settings/__tests__/ollama-preflight.test.tsx` and `local-context-length.test.tsx`; new cases in `multi-agent-orchestrator.test.ts`, `orchestrator-server-generation.test.ts`, `tool-executor-status.test.ts`, `provider-adapter.test.ts`, `server-config-manager.test.ts` and `app/api/models/__tests__/route.test.ts`.
- **`gemini-live.test.ts` runs only with `GEMINI_API_KEY`** and needs a real two-request budget: a free-tier key returns 429 on the pro models and on quick repeats, and Google returns transient 503 "high demand". Rerun rather than debug those.

## v1.102.0 - 2026-09-15

### Server Mode
- **A custom domain's www counterpart redirects to it**: `generateCaddyfile` in `lib/caddy/regenerate.ts` emits a second on-demand-TLS block per `custom_domain` for `wwwCounterpart(domain)` (`www.` added or stripped) with `redir https://{custom_domain}{uri} permanent`; `/api/resolve-domain` falls back to the counterpart so the on-demand `ask` approves its certificate. Caddy refused the TLS handshake for the unlisted form.

### AI Providers
- **Image generation through a ChatGPT subscription**: `openai-codex` lists `gpt-image-2-low`/`-medium`/`-high` (`codexModels` in `registry.ts`, appended by `app/api/models/route.ts` on discovery and by `loadProviderModels` on a cache read, since Codex does not advertise tools as models). `app/api/generate-image/route.ts` sends the Responses `image_generation` tool with `tool_choice` required and reads the PNG from the SSE stream (`extractCodexImage`); `generateImage` refreshes the Codex token first. Contributed in #24.
- **Image generation requests carry a deadline and the run's abort signal**: every fetch in `app/api/generate-image/route.ts` uses `AbortSignal.any([request.signal, AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS)])`, default 120s, answering 504 on the deadline and 499 when the caller left, judged by `signal.aborted` rather than the error's name (undici reports a client cancellation as `ResponseAborted`). `GenerateImageOptions.signal` carries `MultiAgentOrchestrator`'s abort, so Stop ends an image still generating. A stalled upstream stream held the tool call open for good.
- **An expired HuggingFace sign-in is dropped before it is sent**: `setHFAuth` stores `expires_at` from the OAuth result, and `configManager.getProviderApiKey('huggingface')` clears an expired token and fires `apiKeyUpdated` with `{ provider: 'huggingface', hasKey: false }` instead of returning it. `startGeneration` refuses an OAuth provider with no token rather than sending an empty bearer.
- **A 401 from HuggingFace clears the stored sign-in**: `OswsProviderAdapter` calls `clearHFAuth` and rewrites the message to say the sign-in expired; `MultiAgentOrchestrator.onPausableError` returns `stop` for `auth_expired` on a `usesOAuth` provider instead of pausing. Before, the error card said to reconnect while Settings still showed the account as connected, and Continue re-sent the dead token.
- **`getDefaultModel` covers `deepseek` and `meshllm`**: `deepseek` returns `deepseek-v4-flash`, `meshllm` returns `''`, and the `default` arm returns `''`. Both fell through to the OpenRouter slug `minimax/minimax-m2.7`, which their APIs reject.
- **OpenRouter requests send `HTTP-Referer: https://oswstudio.com`**: `OPENROUTER_ATTRIBUTION` in `lib/llm/request-builder.ts` (with `X-Title: OSW Studio`) is sent by `buildHeaders`, `app/api/models/route.ts` and `lib/testing/judge.ts`. The `referer` parameter of `buildHeaders` is removed; the header carried the incoming request's host.

### Telemetry
- **`provider_selected` fires from the models dialog**: `trackAgentProviderChange` in `lib/telemetry/provider-selection.ts` emits it on a slot edit, template switch or template save when the agent's provider changes. The previous emitter in `ModelSettingsPanel` is only rendered by `/test-generation`, so the event had stopped for real users.
- **`connection_added` carries `method`**: `oauth`, `key`, `local` or `custom`, so an HF sign-in and a pasted HF key are no longer the same payload.
- **`session_start` carries `referrer_host` and `utm_source`/`utm_medium`/`utm_campaign`**: `sessionStartFields` in `lib/telemetry/session-fields.ts`, hostname only, same-origin referrers dropped, tags truncated to 64 characters.
- **`quick_edit_opened` fires when a project opens in quick edit**: emitted by `Workspace`. Catalogue disclosures updated for the new fields and events; `DISCLOSED_KEY` is `osw-telemetry-disclosed-v3` and `DISCLOSURE_UPDATED` is September 2026, so the notice shows once more to anyone who saw the July one.

### AI Orchestration
- **An API error ends the task unless a resend could pass**: `isTerminalApiError` in `multi-agent-orchestrator.ts` returns `stop` from `onPausableError` for `model_not_found`, `tool_not_supported`, `invalid_request`, `context_too_long`, `auth_expired` on a `usesOAuth` provider and `credit_exhausted` on `huggingface`; other categories still pause with Continue.

### UI
- **The chat panel asks why a task was stopped**: `stopGeneration` records `userStop` on the store and emits `stop_reason_shown`, only while `isTelemetryActive()`; `ChatPanel` renders a dismissable chip row (`STOP_REASONS` in `lib/telemetry/stop-reason.ts`, four answers plus `other`, shown per `shouldShowStopReason`) as the newest transcript item and emits `stop_reason` with the pick. Cleared by an answer, a dismissal or the next task.
- **The Continue button renders only for a client-side run**: `Workspace` passes `onContinue` only when the store's `canContinueGeneration()` is true, which needs the viewed project's task to hold an `orchestratorInstance`. A server-mode run has none and `/api/server-generate/resume` refuses, so the button did nothing there.

### Tests
- **Coverage for the HuggingFace expiry, terminal errors, the stop ask, the telemetry fields and Codex images**: `hf-auth-expiry`, `terminal-api-error`, `registry-defaults`, `orchestrator-user-stop`, `provider-selection`, `session-fields`, `tracker-active`, `model-catalog-codex-cache`, `resolve-domain/route` and `generate-image/route`. `registry-defaults` sweeps every `BuiltInProviderId` through `getDefaultModel`, so a provider added without a case fails there.
- **State a `vi.mock` factory reads must come from `vi.hoisted`**: the factory is hoisted above every top-level `const`, so `const track = vi.fn()` referenced inside it throws `Cannot access before initialization` at load and the file reports no tests, which a filtered run shows as passing.

## v1.101.0 - 2026-09-13

### Quick Edit
- **Quick edit is a second workspace surface**: new route `/w/{id}/quick/{projectId}`, with the surface on its own store field `quickEdit` (`setQuickEdit`), not in `WorkspaceMode`. `Workspace` renders its own tree, fixed to `QUICK_PANEL_ORDER` (chat, preview, Inspector) under `ResizablePanelGroup` id `quick-edit-slots`, with visibility from `quickPanels` state rather than the store. Deploy, Settings and the project cost are not rendered.
- **The conversation is a thread of runs, not a transcript**: `splitRuns` (`lib/quick-edit/runs.ts`) cuts the event stream at the person's own messages, skipping harness nudges via `isInjectedUserMessage`, now exported from `components/chat-panel/event-processor.ts`. A `Run` carries the request, its checkpoint, a pending approval, a `Tally`, ordered `segments` and `activity`. Reasoning is not kept.
- **`SimpleThread` renders runs**: `components/quick-edit/thread.tsx` shows the request with the workspace's context marking, then a card of segments in order, steps as a `TallyList`, then Undo this, Save or Restore, Undo flipping to Redo once the newest change is undone. It renders `tally.summary` only when `tally.status` is not `done`, so a run that worked ends on its steps.
- **A tally describes each action and the file it touched**: `buildTally` (`lib/quick-edit/tally.ts`) turns every `tool_status` into a described action, collapses repeats into a count, marks failures apart, and records each write's path through `WRITING_KINDS`, since only a server-run generation emits `files_changed`. `collate` (`lib/quick-edit/collate.ts`) folds a stretch into one sentence over three levels of generality; `TallyList` (`components/quick-edit/tally-list.tsx`) opens it onto its steps, eight rows before scrolling.
- **The tally reads an event allowlist, never tool arguments or output**: `toolCalls`, `tool_status`, `files_changed`, `task_complete`, `approval_required`, `error`, `error_paused` and `stopped`. A step records a file path or nothing, never the command; an unrecognised one reads `Working`.
- **`ChatPanel` and `MultipagePreview` take a simple mode**: `simpleThread` replaces the transcript, keeps the model picker and the Code/Chat/Interview menu, drops the `PermissionModeSelector`, falls back to `QUICK_EDIT_PILLS` (`lib/constants/suggestion-pills.ts`) and reads `Ask for a change`; its close button and the preview's toggle write to `quickPanels`. `simple` on the preview hides the semantic-blocks control, and quick edit passes no `onCaptureScreenshot`.
- **Undo and redo walk the project's checkpoints**: `undoTarget` and `redoTarget` (`lib/quick-edit/undo.ts`) over `checkpointManager.getCheckpoints`, oldest first, with a cursor the workspace sets on every restore and resets when a checkpoint lands. Quick edit's header carries them; the studio's does not yet.
- **A gated command can be answered from quick edit**: a waiting run states the capability via `approvalPhrase` (`lib/quick-edit/approval-phrase.ts`) with Allow and Don't, which do what the transcript's approval chip does: `configManager.setPermissionOverride` plus a continue message through `handleGenerate`.
- **The composer's attach menu takes a screenshot of the preview**: a Screenshot item beside Image, offered when `onCaptureContextScreenshot` is passed and the model takes images. `MultipagePreviewHandle.captureScreenshot` takes an `outputWidth`; the workspace captures at 1280 wide. New `pendingImageFromDataUrl` (`lib/llm/pending-image.ts`) builds the attachment for it and for picked, pasted and dropped images.
- **Three ways into the quick route**: `handleProjectOpen` in `page-wrapper.tsx` routes there when the account is not in the studio, `ProjectTableRow` carries a Quick edit item above the export actions in server mode, and `PageWrapper` takes `quickEditProjectId` into the same restore path `?project=` uses without writing a second id to the URL. Leaving clears `quickEdit`.
- **On a phone, quick edit is the workspace's panel switcher**: the mobile bar carries Chat, Preview and Inspector, with Files, Editor and the overflow menu hidden. `AppHeader` keeps Save visible in quick mode (`mobileVisibleActions`) rather than only while dirty, and drops the active-panel subtitle.
- **The Code/Chat/Interview menu is offered in the simple view**: it chooses the agent's mode, and the surface is `quickEdit` rather than a mode, so picking one keeps quick edit. The interview picker's Manage and New are not offered there.

### Inspector
- **The Inspector runs on a phone**: a fifth `activeMobilePanel` value, `elements`, with the preview kept mounted above it. Both panel trees mount at once, so `sendToFrame`, `getActivePath`, frame-ready and the tree and style replies resolve through `inspectorTargets()` and the new `useMobileViewport` (`lib/hooks/use-mobile-viewport.ts`) rather than the desktop instance. Provenance reaches the mobile preview only while the Inspector is active; the wider `previewRef` ordering hazard is unchanged.
- **Picking an element in the preview opens the tree onto it**: the tree holds only expanded levels and a node carries no path, so the frame answers a new `tree-path` with every level from the body down to that node's parent plus the ancestors to open (`tree-levels`). A `reveal` transition rebuilds from those and selects the node. A tree click no longer dispatches `reveal`, which had collapsed hand-opened branches.
- **"Ask the agent" writes the message instead of sending it**: the Styles tab started a run from a half-formed request. The text now lands in the chat composer through `composerDraft`, appending when asked more than once, and the chat is brought into view. The request names the value that was set (`padding-block: 24px`), not just the property.

### AI Orchestration
- **`lib/agent-activity/parse-command.ts` classifies an agent's shell command**: new `parseCommand` returns an `ActionKind`, the absolute path it acts on and the raw `detail` it was read from, reading a chain by its leading command, looking past a `cd`, and dropping stderr plumbing so `cat /a.md 2>/dev/null` is still a read. `GenerationShelf` phrases that result with a tense and the quick-edit tally without one; its own `parseBashAction` patterns are gone, which also gave it `agent`, `propose-create`, `preview`, `python`, `lua`, `generate-image` and `sqlite3`.
- **The transcript's command grouping moved to `lib/agent-activity/classify-command.ts`**: `classifyBashCommand` in `components/chat-panel/event-processor.ts` is renamed `classifyCommand`. Its `agent` and `status` buckets derive from `parseCommand`'s kinds, so the `agent`/`delegate` alias is spelled once, and `cd / && status` and `runtime restart` now group with their own kind. The write rules stay written out.

### Server Mode
- **A workspace owner administers their own members**: new `/api/w/{id}/users` and `/api/w/{id}/users/{userId}` behind `requireWorkspaceOwner`, with `WorkspaceMembers` (`components/views/workspace-members.tsx`) rendered by `UsersView`. Adding an email with no account creates one; adding an existing one grants access. Removing revokes `workspace_access` for that workspace only. `POST /api/admin/users` was instance-admin only.
- **Users is a Settings pane with a workspace tier and an instance tier**: it moves from `/admin/users` to `settings?settings=users`, gated `ownerOnly`. An owner gets the members section, an instance admin also the table of every account. `visiblePanes` and both sidebar sub-item filters take the owner answer, `SettingsNav` gains the `workspaceId` it was missing, `UsersView` drops its `PageShell` when embedded, and `settings-view.tsx` validates `?settings=` against the new `SETTINGS_PANE_IDS`. `/admin/users` still renders standalone.
- **`requireWorkspaceOwner` moved to `lib/api/workspace-context.ts`**: `lib/api/mail-route.ts` re-exports it, so its callers are unchanged.

### UI
- **An account can open the simple view instead of the studio**: new `users.studio_view`, additive and defaulting to 1. A `studioOnly` flag hides Templates, Skills, Interviews, Guided Tour, Benchmark, Mail and the Templates and Permissions settings panes, leaving Dashboard, Projects, Deployments, Docs, Models, Cost Tracking and the account's own settings. Applied in both the expanded sidebar and the collapsed flyout, which filters sub-items separately.
- **The view is server-decided, per-person, and live**: `app/w/[workspaceId]/layout.tsx` reads `studio_view` off the account it already loaded for the access check and passes it to the new `ViewModeProvider` (`components/view-mode-provider.tsx`), so the first HTML carries the right menu; the sidebar reads `useStudioView` rather than fetching. `PATCH /api/auth/me` takes only `studioView` and only for the session's own account. `emitViewChanged` (`lib/view-mode-event.ts`), dispatched by the Appearance control, the members list and the account editor, is what the provider re-reads on.
- **The simple view is a per-device choice in browser mode**: `readLocalStudioView`/`writeLocalStudioView` (`lib/view-mode-event.ts`) keep it under `osw-studio-view`. `StudioApp` mounts the provider the workspace layout mounts in server mode, and a project opens into quick edit by setting the surface alongside the selection, that tree having no `/w/{id}/quick/{projectId}` route.
- **A studio-only view is not reachable by URL in the simple view**: new `requireStudioView` (`lib/auth/studio-view-guard.ts`), awaited by the `skills`, `templates` and `interviews` pages under `/w/{workspaceId}`, sends a simple-view account to its dashboard. `StudioApp` moves off `STUDIO_ONLY_VIEWS` in browser mode, but in server mode each view is a route a typed address reaches directly. Not an access check: the layout has already verified membership.
- **The default panel order is chat, preview, then files**: `DEFAULT_PANEL_ORDER` (`lib/stores/slices/layout.ts`) moves `preview` ahead of `files`. The order places open panels left to right and `pickEvictionTarget` walks it from the right, so a third panel now takes `files` instead of `preview`. A saved `osw-workspace-panel-order` still wins.
- **A user row opens the editor**: the Users table drops its expandable panel, and a row click opens the edit dialog, grouped into Account, Password and Workspaces. The figures the table hides on a narrow window (projects, storage, last active) and each workspace's quotas and creation date move into it. `expandedUserId` and `roleBadgeVariant` are gone, and `viewer` is no longer offered as a role.
- **A chat panel that is the only panel open holds its content to a column**: new `solo` prop on `ChatPanel`, passed when `visiblePanelCount` is 1, bounds the messages and composer to `max-w-3xl` centred. Applies in the studio and quick edit.
- **The preview header drops its thumbnail camera**: `MultipagePreview` loses `onCaptureScreenshot`. The listings already take their own on save and publish; the handle's `captureScreenshot`, used by the composer's Screenshot attachment, is untouched.

### Fixes
- **A project's settings are read as a record whatever was stored**: new `lib/vfs/project-settings.ts`, whose `normalizeProjectSettings` parses settings held as a JSON string, peels stacked stringify layers, drops the `"0"`/`"1"` keys a spread of such a string leaves, and drops an unrecognised runtime. Called at `hydrateProject`, `rowToProject`, the SQLite write and the write-backs fed from a JSON response. Nothing threw: an affected project read as having no runtime, entry point or prompt suggestions.
- **`resolveRuntime` answers the missing-runtime case for every consumer**: `FALLBACK_RUNTIME` and `resolveRuntime` replace `|| 'handlebars'` in `VirtualServer` and `exportProject`, and `MultipagePreview` resolves once for both the compiler and `supportsDirectEditing`, which answers `false` for `undefined`. A handlebars project naming no runtime was stamped with provenance and then refused the selection toolbar that runs on it.
- **A checkpoint restore no longer deletes a runtime it has no record of**: `restoreSettings` (`lib/vfs/checkpoint-backend.ts`) applies `runtime` only when the snapshot carries one; the other three covered settings still clear. Capture read it off settings that may have been a JSON string, so an absent value did not distinguish "had none" from "could not read one".
- **IndexedDB v8 repairs stored project settings and fills in a missing runtime**: v6 did `project.settings = project.settings || {}` and then assigned to `.runtime`, so a stored JSON string was kept and the assignment threw `TypeError` on a string primitive, aborting the cursor and leaving every later project unmigrated. v6's loop now normalizes first; v8 rewrites malformed records without touching `updatedAt`.
- **A local edit no longer reads as another device's**: `updateProject` wrote every field it was given, including the sync layer's own `lastSyncedAt`, `serverUpdatedAt` and `syncStatus`. A listing holds a project loaded once, so removing or capturing a thumbnail replayed an old `lastSyncedAt` and the next push came back 409 as "edited on another device". A content edit now keeps the stored row's stamps; `preserveUpdatedAt: true` still writes them.
- **Two pushes for one project cannot overlap**: `autoSyncProject` guarded on `syncStatus === 'syncing'`, a value nothing ever set. Pushes are serialised per project through an in-memory map, not a persisted flag, so a tab that dies mid-push leaves nothing unsyncable.
- **One generation per project in server mode**: `startServerGeneration` claims the project before its first `await`, not once `/api/server-generate` has answered, where the guard reported "not busy" through a model resolve, a sync and a checkpoint write. Every early exit gives the claim back and the final update merges onto it. The user message is added ahead of that sync, so a request appears in the transcript at once.
- **`startGeneration` reports whether it started anything**: `false` for every refusal (project busy, no model or key, empty prompt, tour lock) and `true` once a run was accepted. The workspace's post-send cleanup keys off it, so a refused send no longer spends the selection's inclusion or drops attachments still in the composer.
- **Nothing rewinds a project while a run is writing to it**: Restore, Discard and Retry rolled files back, and Retry truncated the conversation, before the generation each ends with was attempted and refused by the one-task guard. `refuseWhileGenerating` turns all three down while a task is live, disables the transcript's Restore and Retry, and sits ahead of `handleStartInterview` and `handleHandoff`.
- **Stopping a server task the server can no longer reach closes it**: `/api/server-generate/cancel` completes a task with no live orchestrator, such as one reloaded from the durable store after a restart, and emits its `task_complete`, reporting `hadOrchestrator` either way. `stopGeneration` waits for the server only when that is true, otherwise marking the task stopped locally.
- **Screenshots and thumbnails are painted by the browser, not by html2canvas**: `captureIframeScreenshot` (`lib/utils/screenshot.ts`) renders the frame through `modern-screenshot`'s `domToCanvas`, an SVG `foreignObject` pass by the browser's own engine, so `oklch` colours, `oklab` gradients and `color-mix` come out as displayed. html2canvas parses none of them and `prepareScreenshotClone` flattened every gradient to slate; it is now the fallback.
- **The selection toolbar works on a phone**: `onToolbarAction` was wired only to the desktop preview, so X, Include and Style posted a message nothing handled. A press is attributed to the surface it came from, Include makes the chat the active panel, and Style the Inspector.
- **The pacing notice sits at the bottom of the transcript**: `shouldShowPacingNotice` (`lib/pacing-notice.ts`) is unchanged; the notice it gates was the first item of a list that appends downward, so it scrolled out of view during the long write it reassures about.
- **A chain splits into commands, pipes and all**: the `;`, `&&` and `||` branches of `vfsShellExecute` (`lib/vfs/cli-shell.ts`) recursed into `vfsShellExecuteSingle`, which does no pipe splitting, so a piped chain returned the left side's raw output at exit 0. `parseBashCommand` also tracked quoting one boolean per token, so `echo '---'; date` swallowed `date`; each token now carries the offset past its final closing quote for `splitOperatorTokens`.
- **`grep -c`, `grep -l`, `wc -l` and `ls` on a file path answer correctly**: the first two fell off the end of the flag parse in `lib/vfs/shell/commands/grep.ts`, so `-c` printed the matching lines themselves; `wc -l` counted newline characters against output carrying none trailing; and `ls` on a single path went to `listDirectory`, returning empty at exit 0 for a file that exists. An unrecognised grep flag now exits 2.

### Tests
- **Coverage for quick edit, the view and the settings normalizer**: run splitting, tallies, collation, approval phrasing and undo targets (`lib/quick-edit/__tests__/`), the thread and tally as rendered components (`components/quick-edit/__tests__/`), the device store and the provider (`lib/__tests__/view-mode-event.test.ts`, `components/__tests__/view-mode-provider.test.tsx`), the Interface row rendering with no request made (`components/settings/__tests__/appearance-pane.test.tsx`), the column default on upgrade (`lib/auth/__tests__/studio-view-migration.test.ts`), every stored settings shape (`lib/vfs/__tests__/project-settings.test.ts`), command classification (`lib/agent-activity/__tests__/`), and `setQuickEdit` leaving `mode` alone (`lib/stores/__tests__/project.test.ts`).
- **A route's own payload needs its own test**: `app/api/auth/__tests__/me-studio-view.test.ts` drives the real `GET` and `PATCH` against a real database with only `getSession` mocked. The client tests stub `fetch` and would pass whatever the route emitted, so a field renamed on one side only is invisible to them.
- **Marking a view `studioOnly` fails the suite until its page is gated**: the last case in `lib/auth/__tests__/studio-view-guard.test.ts` reads `STUDIO_ONLY_VIEWS` and checks each view's page awaits `requireStudioView`. It matches the call, not the identifier, since an import alone would satisfy a looser check.
- **`useMobileViewport` needs `matchMedia` stubbed against a width**: jsdom implements no media queries, so a stub returning a fixed answer passes whatever breakpoint the hook asks for (`lib/hooks/__tests__/use-mobile-viewport.test.tsx`).

## v1.100.0 - 2026-09-05

### Review Mode
- **The deployments listing shows a count of unresolved review comments**: `openThreadCounts` (`lib/review/open-thread-counts.ts`) attaches `openReviewThreads` to each deployment from `GET /api/w/{id}/deployments`, counted by the new `ReviewDatabase.countOpenThreads` over open comments with no parent. Only deployments with `review.enabled` and an existing `review.sqlite` are opened, since `getReviewDatabaseConnection` creates the file. Nothing open leaves the field absent rather than zero.
- **A review count opens the deployment on its Review tab**: new `ReviewBadge` (`components/ui/review-badge.tsx`) in the table row and the card's status overlay, passing the new `initialSection` prop to `DeploymentDetail`.

### UI
- **A deployment's URL copies when clicked**: the address in the listing was inert, so a click reached the row and opened the detail view. It now calls the same `copyDeploymentUrl` as the button beside it.
- **The deployment URL column no longer takes width from Name and the row actions**: the address takes `flex-1` with a 220px cap on the inner element rather than the `td`, which `table-auto` may ignore.
- **Listings drop their lower-priority columns as they narrow**: each table's scroll box is a query container and secondary columns carry `@max-5xl:hidden`, so they answer to the table's width rather than the viewport's. Projects drops Files and Cost, Templates Author and License, Interviews Artifact, Deployments the URL, Users Projects, Storage, Workspaces and Active, Workspaces Members, Projects and Deployments. The Users and Workspaces figures reappear in the row's expanded panel under `@5xl:hidden`.
- **Row actions move into the overflow menu as a listing narrows**: below 48rem of table width Projects, Templates, Skills, Interviews and Deployments hide their inline row buttons and carry the same actions in the menu, Deployments adding an Open link item. Skills had no menu and gets one; Templates and Interviews had menus only for custom entries, leaving a built-in row with no actions at all.
- **`useNarrowContainer` measures a listing a container query cannot reach**: new `lib/hooks/use-narrow-container.ts` returns a boolean and a callback ref, for cases where Radix portals menu content out of the container a `@max-*` variant resolves against. `COMPACT_ROW_WIDTH` (`lib/constants/layout.ts`) is the width shared by it and the `@max-3xl` variants.
- **Mail settings are a pane in Settings**: `settings?settings=mail` replaces the sidebar entry and the `/w/{id}/mail` page, which now redirects there. `UnifiedSettings`, `SettingsView` and `SettingsNav` take a `workspaceId`, and `visiblePanes` hides the pane without one. Sidebar sub-items gained `serverModeOnly`.
- **Deployment settings collapse their side nav into a dropdown**: below `md` the 192px rail is replaced by a Select above the content, built from the same `DEPLOYMENT_NAV` and `BACKEND_NAV` groups the rail renders.
- **The open project is in the URL in server mode too**: `?project={id}` is written on open and cleared on close by `page-wrapper.tsx`, and read back on mount. This existed only in the browser-mode shell (`studio-app.tsx`). The Dashboard's recent-project link emitted `?open={id}`, which nothing read, and now uses the same parameter; the unread `?open=` on its deployment link is gone.
- **A link carrying `?project=` renders a placeholder until the project resolves**: both shells previously rendered the view they landed on and replaced it. The sidebar is suppressed for that moment too.
- **The workspace Back control shows which page it returns to**: new `backLabel` on `Workspace`, read by the Back control and the logo beside the project name. The Dashboard's recent-project link opens over the dashboard rather than the projects list.

- **The in-workspace settings dialog is non-modal again**: `UnifiedSettingsModal` lost `modal={false}`, its own backdrop and its focus guards when v1.97.0 moved the dialog out of `chat-panel.tsx`. The connections drawer is portaled to `<body>`, so a modal dialog's focus trap pulled focus straight back out of its fields, which took a click but no typing, and react-remove-scroll cancelled wheel events over it. Adding a custom provider from inside a project was affected; the Settings page has no dialog and was not.

### AI Providers
- **A custom provider sends extra headers with every request**: `ProviderConfig.customHeaders` was declared and read by nothing. `buildCustomProviderConfig` now takes them, the Connect drawer collects name/value pairs with masked values, and they travel in the request body to both routes the way `baseUrl` already does, since `getCustomProviders` is localStorage-backed and server-side `getProvider` only ever returns a stub for a custom id. Merged by `buildHeaders` (`lib/llm/request-builder.ts`) for chat and in the default branch of `app/api/models/route.ts` for discovery.
- **Both provider drawers share one header editor**: new `CustomHeadersEditor` (`components/providers-models/custom-headers-editor.tsx`) with `headerRowsFrom`, `headersFromRows` and `unusableHeaderNames`, used by the add and edit bodies of `connections-pane.tsx`. `EditConfigBody` seeds its rows from the stored config and passes them back, since `handleSaveCustom` rebuilds the whole config on every save.
- **`sanitizeCustomHeaders` filters what a custom endpoint may be sent**: new `lib/llm/providers/custom-headers.ts` drops `host`, `content-length`, `content-type`, `cookie`, the RFC 9110 hop-by-hop set and any `proxy-*`, plus names that are not HTTP tokens and values carrying CR, LF or NUL, which `Headers.set` rejects mid-request. A second name differing only in case is dropped too, since `fetch` lowercases them. Run when storing and again on each route, a client not being a trust boundary.
- **A non-object `customHeaders` is refused whole**: the value arrives from a request body, and `Object.entries` on a string or array yields index keys that pass the field-name check, so `"ab"` would otherwise become the headers `0` and `1`.
- **The API token owns the `Authorization` header**: `authorization` is on the refusal list, so a custom header cannot set it and the two can never disagree. That is the precedence rule; a non-Bearer scheme is not reachable.
- **Model discovery on a custom endpoint has a deadline**: the `/models` fetch had no timeout or abort signal, so an endpoint that accepted the connection and never answered held the route open. It now carries `AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)`, 15 seconds. The chat route already passed `request.signal`.

### Security
- **A workspace URL is refused to someone not in that workspace**: new `app/w/[workspaceId]/layout.tsx` calls `verifyWorkspaceAccess` for every page beneath it and sends a refused caller to their own default workspace. The middleware guards these paths but runs on the Edge runtime, where the access tables are unreachable, so it could only establish that the session was valid: any signed-in user could load another workspace's URL and get the shell. No data was exposed, but the page rendered.

### AI Orchestration
- **A chat suggestion can be scoped to the preview paths it applies to**: `PromptSuggestion` gains an optional `paths` glob list (`lib/vfs/types.ts`), matched by `matchesPathPattern` and ordered by `selectPromptSuggestions` (`lib/vfs/suggestion-paths.ts`), which puts scoped matches ahead of unscoped ones before the chat panel's inline and overflow split. `*` stays inside one path segment, `**` crosses folders. Turn-0 only, as before.
- **A suggestion's pages are built from typed rules rather than typed globs**: each rule in `PromptSuggestionsEditor` is a kind and a value. Page picks from the project's `.html` files, Directory picks one and compiles to `{dir}/**`, Pattern takes a glob. `lib/vfs/suggestion-path-rules.ts` holds `pageDirectories`, `ruleToPattern` and `patternToRule`; only the compiled glob is stored, and the kind is read back off it when the editor opens. A picked value no longer in the project stays selectable rather than being swapped for the first page in the list.
- **The preview reports its current file to the chat panel**: `MultipagePreview` gains `onPathChange`, held in workspace state and passed to `ChatPanel` as `previewPath`. It reports the resolved `filePath`, not the requested path, so a link to `/` and one to `/index.html` are one page to a scoped suggestion. `getActivePath()` on the ref still reports the requested path for the three imperative callers.
- **`seedPromptSuggestions` and `usablePromptSuggestions` carry `paths`**: both rebuild each entry field by field, so a new field is dropped unless they are updated. `usablePromptSuggestions` normalises each pattern to a leading slash and drops the field when nothing survives.
- **The chat suggestion row waits for the project's own suggestions**: the store's `promptSuggestions` starts empty, which read identically to "this project has none", so the generic starters rendered and were replaced once the project loaded. The row now waits for `projectId`, set in the same `initProject` update and cleared by `resetProject`.
- **The chat suggestion menu is always present and links to the editor**: the `…` button was gated on something overflowing and now renders regardless, with Manage suggestions as its last item. `setShowProjectSettingsModal` takes an optional section id, held as `projectSettingsSection` and cleared by the dialog once used. The "Try one of these:" heading shows only when there are pills.
- **Saving chat suggestions takes effect without reopening the project**: `PromptSuggestionsEditor` wrote to the VFS but never called `updateProjectSettings`, so the row above the composer kept the list loaded when the project opened. Its draft now follows the stored value instead of what it read on mount.

### Fixes
- **Retry deadlines read SQLite timestamps as UTC**: columns defaulted to `datetime('now')` hold `YYYY-MM-DD HH:MM:SS` with no zone marker, which `new Date` read as local time, displacing webhook retries by the host's offset. New `lib/sqlite-timestamp.ts` exports `parseSqliteTimestamp`, used by `lib/webhooks/delivery.ts` and `lib/mail/delivery.ts`. Invisible on a UTC host.
- **Analytics ranges are bound in SQLite's timestamp format**: an ISO cutoff sorts above a stored `YYYY-MM-DD HH:MM:SS` row of the same date, so `getStats`, the `dateFrom`/`dateTo` filters and `clearAnalytics` were wrong on the cutoff day, the last deleting rows it should have kept. `lib/vfs/adapters/analytics-database.ts` passes every bound range value through `toSqliteTimestamp`.

### Tests
- **Coverage for the new scoping, guard and timestamp paths**: glob matching and ordering (`suggestion-paths.test.ts`), rule building and read-back (`suggestion-path-rules.test.ts`), the workspace layout guard (`workspace-access-guard.test.ts`), review counts (`open-thread-counts.test.ts`), the webhook backoff deadline across four host timezones (`delivery-backoff.test.ts`) and `AnalyticsDatabase.getStats` on the cutoff day (`analytics-timestamp-range.test.ts`). Header sanitising, forwarding, precedence and survival across an edit extend `custom-headers.test.ts`, `custom-headers-editor.test.ts`, `request-builder.test.ts` and `app/api/models/__tests__/route.test.ts`.
- **`useNarrowContainer` needs `clientWidth` stubbed**: jsdom performs no layout and reports 0, so an unstubbed test passes against a hook that never fires (`lib/hooks/__tests__/use-narrow-container.test.tsx`).

## v1.99.0 - 2026-08-30

### Review Mode
- **Publishing writes a private review copy of a deployment**: `review.enabled` on the deployment record makes `buildStaticDeployment` emit a second copy into `deployments/{id}/review-build/`, outside `public/` so nothing serves it statically. `app/review/[deploymentId]/route.ts` and its `[...path]` sibling read it. The public copy is built from the same files with `reviewWidget: false` and never carries the widget.
- **A comment widget is injected into the review copy only**: `generateReviewWidget` (`lib/publishing/review-widget.ts`) emits an inline script into a closed shadow root, gated by the `reviewWidget` flag on `processHtml`. Anchoring, page paths and thread assembly live in `lib/review/widget-runtime.ts` as JavaScript source text, since the widget ships as script and cannot import.
- **Comments are stored per deployment**: new `ReviewDatabase` (`lib/vfs/adapters/review-database.ts`) at `deployments/{id}/review.sqlite`, with `participants`, `comments` and `notification_state` tables. Comments anchor to a CSS selector plus the text it matched, so a moved element still shows what was said.
- **The review API is served under the review prefix**: `/review/{id}/osw-api/comments` and `/osw-api/participant`, from `reviewApiBase` (`lib/review/api-base.ts`). Under `/api` a browser would not send the participant cookie, which is scoped to `/review/{id}`.
- **Anonymous reviewers are identified by a signed cookie**: `mintReviewCookie` (`lib/review/session.ts`) issues `osw_review_{id}` carrying `purpose: 'review'`, the deployment id, and an epoch derived from the review password. `resolveReviewAccess` (`lib/review/access.ts`) admits workspace members as `team` without the gate.
- **A review copy can take a password and a deadline**: `review.passwordHash` is deployment-scoped and bcrypt-hashed by the route, never supplied by a client; `review.expiresAt` stops serving to reviewers while still admitting workspace members. `mergeReviewConfig` (`lib/api/deployment-review-merge.ts`) treats an absent hash as unchanged and `password: null` as a clear.
- **The Review tab reads and answers comments**: `components/publish-settings/review-tab.tsx` lists threads with open/resolved filters, replies and resolve. Its Show button opens `/review/{id}{page}?osw-comment={id}`; the widget reads that parameter and opens the thread against the element it was left on.
- **Review traffic is rate limited per caller and deployment**: `reviewAsset`, `reviewComment`, `reviewCommentList`, `reviewPassword`, `reviewWrite` and `reviewUnsubscribe` in `RATE_LIMIT_CONFIG` (`lib/analytics/rate-limiter.ts`), consumed before the access check.

### Mail
- **An instance can be given an SMTP server**: stored in `instance_settings` under `mail.smtp.*` keys (`lib/mail/settings.ts`), with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` as fallbacks. A value stored through the UI wins over the environment. Passwords are stored unencrypted; see `docs/VPS_DEPLOYMENT.md`.
- **A workspace either relays through the instance or brings its own server**: new `workspace_mail` table. In `instance` mode a workspace may set a display name but not the From address, which keeps SPF and DKIM aligned; `resolveMailSource` (`lib/mail/transport.ts`) settles which tier sends.
- **Mail is queued and drained on a timer**: new `email_outbox` table with `deliverPendingEmails` (`lib/mail/delivery.ts`) and a backoff schedule. Registered as the `email-delivery` scheduler task in `instrumentation.ts`. With no transport resolvable a pass holds every row untouched rather than spending an attempt.
- **New comments go out as a digest**: the `review-notifications` task composes per recipient from `lib/review/digest.ts`, gated on `review.notifyByEmail` and on `isMailSending` for the workspace. A watermark in `notification_state` marks how far each recipient has been told. Turning a tier off drops what it had queued.
- **Recipients can stop their own notifications**: `/review/{id}/unsubscribe` with an HMAC token from `lib/review/unsubscribe-token.ts`, setting `muted` on `notification_state`.
- **Mail settings have their own page**: `/w/{id}/mail` (`components/views/mail-view.tsx`, logic in `mail-logic.ts`), server mode only, with a test send that reports the mail server's own refusal. Admin routes under `app/api/admin/mail/`, workspace routes under `app/api/w/[workspaceId]/mail/`.
- **A workspace SMTP host is checked before it is dialled**: `assertMailHostAllowed` (`lib/mail/transport.ts`) refuses a workspace host that resolves into private address space, and pins the connection to the address it checked. The instance tier is exempt, so `localhost:1025` and internal relays still work.

### Security
- **Origin checks compare hosts rather than string prefixes**: `validateOrigin` (`lib/analytics/security.ts`) parsed nothing and used `startsWith`, so `https://example.com.attacker.net` satisfied a rule written for `https://example.com` and could post analytics for any deployment. It now parses both headers, requires exact origin equality, and matches wildcard entries only at a label boundary.
- **A handoff token can no longer be presented as an account session**: `verifySession` (`lib/auth/session.ts`) accepted any well-signed token, so the short-lived token from `createHandoffToken` worked as a session cookie. It now refuses any token carrying a `purpose` claim.

### Server Mode
- **Deployments with no routing row are registered on boot**: `backfillDeploymentRoutes` (`lib/auth/default-workspace.ts`) runs per workspace from `instrumentation.ts`. Without a row `resolveDeployment` finds the deployment in neither database it tries, so analytics, edge functions and the scheduler behave as though it were deleted.
- **A deployment id held by two workspaces is left unrouted**: `migrateLegacyData` copies a legacy `data/osws.sqlite` into every workspace created on the box, so an upgraded instance can hold the same deployment id twice while `deployment_routing` has room for one owner. The backfill skips those rather than assigning by workspace creation order.
- **Publishing a deployment another workspace owns answers 409 before building**: the ownership check in `registerDeploymentRoute` ran after the build had been written and `publishedAt` recorded, so the caller was told the publish failed while the deployment was marked published. The publish route now checks the routing row first.

## v1.98.0 - 2026-08-29

### UI
- **Listing pages render as a table by default**: new `ViewModeToggle` (`components/ui/view-mode-toggle.tsx`) switches Projects, Templates, Skills, Interviews and Deployments between `table` (the new default) and the existing card `grid`; Users and Workspaces gain a table with no grid mode. The `useViewMode(page)` hook in the same file persists each page's choice to the new `AppSettings.listViewModes` record via `configManager.getListViewMode`/`setListViewMode`, read in an effect so the value cannot desync server and client markup. Tables are `table-auto` with a sticky `bg-muted` header inside a scrolling bordered box. New `project-table-row.tsx`; `ThumbnailArea` gains an `xs` size for table cells; `formatCompactAge` (`lib/utils.ts`) drops the "about/over/almost/less than" prefix from date columns.
- **Main-menu pages share a page shell**: new `components/ui/page-shell.tsx` exports `PageShell`, `PageHeader` and `PageBody`, which put the page title first in a fixed header above a scrolling, centered body. `PageBody` takes `fill` for pages whose inner table scrolls and `bodyRef` for a pagination scroll target. Adopted by Settings, Dashboard, Docs, Users, Workspaces and Deployments.
- **Settings panes are built from sections of rows**: new `components/ui/section.tsx` (`Section`, `SectionHeader`, `SectionBody`) and `setting-row.tsx` (`SettingRow`) replace the hand-rolled bordered boxes in `appearance-pane.tsx` and `data-pane.tsx`. `UnifiedSettings` renders a `Settings · <pane>` header.
- **Active and emphasis controls use a muted orange**: `bg-primary/15` with `text-primary` and `border-primary/40` replaces the solid `bg-primary` fill on the `accent` Button variant and the checked `Switch` track (which keeps a full-orange thumb), and the `bg-accent` fill on `ToggleGroup`; the new `ViewModeToggle` and the deployment-detail side nav use the same treatment. Dashboard and `models-pane` cards move from `rounded-xl` to `rounded-lg`.
- **Deployment settings open as a full-page detail view**: `components/deployment-detail/index.tsx` replaces `DeploymentSettingsModal` with a side nav over the existing publish-settings tabs (General, Scripts, CDN, SEO, Analytics, Compliance) and the backend managers (Functions, Helpers, Secrets, Schedules, Schema, SQL, Logs). `DeploymentCard` takes an `onClick` so the whole card opens the detail view, replacing the Settings and Server Settings items in its dropdown. `components/deployment-settings/` and `components/publish-settings/index.tsx` are removed; `DeploymentCard` drops `onOpenSettings` and `onOpenServerSettings`.
- **Deployment settings tabs use the shared section layout**: all six `publish-settings/*-tab.tsx` files drop their `text-lg` headings and hand-rolled `p-4 border rounded-lg` boxes for `Section`/`SectionHeader`/`SectionBody` and `SettingRow`. The detail view's side nav marks the active item with the same muted orange as the rest of the app.
- **Skills page toggles and filters move into a strip and a section header**: the master "Skills system" and "Skill evaluation" switches share one strip with `InfoTip` explainers (new `components/ui/info-tip.tsx`). The Skills/Groups tabs, Built-in/Custom filter and Enable all/Disable all fold into a single `SectionHeader`; Import and Export move to a toolbar overflow menu.

### Server Mode
- **Gated commands pause for approval instead of being denied**: server-side generation answered every permission gate with `deny`. `checkCommandPermission` (`lib/llm/tool-registry.ts`) now takes `pauseForApproval`, emits an `approval_required` progress event and ends the run with `exitReason: 'awaiting_user'`. The pending `{gateKey, command}` is stored in the new `pending_approval` column (`task-store.ts`, additive migration) so the Allow/Deny prompt survives a reload; Allow writes a permission override and restarts the run.
- **`search` works during server-side generation**: the command delegates to the connected browser through a `search_requested` SSE event, which posts back to `/api/server-generate/search-result` (`search-delegation-handler.ts`). With no browser connected, a 30s timeout falls back to `runServerSideSearch` (`server-side-search.ts`), which calls the provider on the server and passes a user-supplied SearXNG URL through `assertPublicUrl`. To make that fallback possible the provider key travels in the `webSearch` field of the start request; it stays in memory for the run and is excluded from `PersistedServerTask`.

### Fixes
- **The pagination row only renders when there is more than one page**: `PaginationRange` and `Pagination` both return nothing when `totalPages` is 1, which left an empty padded row above the table in Projects, Deployments, Templates and Skills. Each call site now guards on `totalPages > 1`.

### Tests
- **Coverage for the new search, approval and formatting paths**: `runServerSideSearch` including the SearXNG SSRF guard (`lib/server-generate/__tests__/server-side-search.test.ts`), `pending_approval` round-trip and malformed-column handling (`task-store.test.ts`), the approval-pause branch (`permission-gate.test.ts`), and `formatCompactAge` (`lib/__tests__/utils.test.ts`).

## v1.97.0 - 2026-08-23

### UI
- **Settings and Provider/Model merged into one pane**: `unified-settings/index.tsx` replaces both `settings/index.tsx` and `providers-models/index.tsx` with a single 7-pane layout: Connections, Models, Templates, Appearance, Cost Tracking, Permissions, Data. The old `SettingsPanel` is split into `appearance-pane.tsx`, `cost-tracking-pane.tsx`, `permissions-pane.tsx`, `data-pane.tsx`. Old `?settings=application` and `?settings=model` params map to the new pane ids.
- **Collapsed sidebar shows a flyout sub-menu on hover**: `SidebarFlyout` component, portal-rendered at `document.body`, viewport-clamped, 150ms hide debounce. First selectable item aligns vertically with the trigger. If the sidebar is mid-expand, the flyout waits for the CSS transition to finish before appearing.
- **Dialog heights standardized to 90vh**: function editor, scheduled function editor, server function editor, deployment settings, import, interview templates, permission matrix, publish settings, server settings, skills manager and skills panel dialogs.

### AI Orchestration
- **Cost tracking covers all cloud providers via models.dev**: `ensurePricing` in `provider-adapter.ts` fetches `models.dev/api.json` on first use and registers pricing for Anthropic, OpenAI, Gemini, Groq, DeepSeek, HuggingFace, MiniMax, ZhiPu and SambaNova. Previously only OpenRouter and HuggingFace had dynamic pricing. New module: `lib/llm/models-dev.ts`. The static `PROVIDER_PRICING` table in `cost-calculator.ts` remains as fallback.
- **Model metadata filled from models.dev**: `enrichModelsFromModelsDev` stamps `inputModalities`, `outputModalities`, `supportsVision`, `supportsFunctions`, `supportsReasoning`, `contextLength` and `maxTokens` onto models that lack them. Existing values are not overwritten; `contextLength` is only updated when the current value is 128000 or below.
- **Providers without model discovery get their list from models.dev**: MiniMax and ZhiPu load models via `loadModelsFromModelsDev()`. The hardcoded array is the fallback.
- **Model selector delegates to `loadProviderModels`**: `model-selector.tsx` calls `loadProviderModels()` in `model-catalog.ts` instead of duplicating the OpenRouter/HuggingFace/discovery/static model-loading branches.

### Server Mode
- **Admin Edit User dialog replaces the separate Reset Password dialog**: the dialog now holds display name, admin toggle, inline password reset with generate/show, active toggle, and a workspace memberships section with per-membership role selector and revoke. `updateUser` in `system-database.ts` accepts `is_admin`; the PUT route guards against self-demotion.
- **Admin Workspaces expanded row lists projects and deployments**: project names with last-updated dates and deployment slugs with custom domains. The workspace detail API returns `projects` and `deployments` arrays.
- **Admin sidebar items render on first paint in server mode**: `isAdmin` initializes as `null` (unknown) instead of `false`, so admin-only items appear before the `/api/auth/me` fetch resolves.

## v1.96.2 - 2026-08-22

### Server Mode
- **`build` delegates to the browser during server-side generation**: `buildCommand` (`lib/vfs/shell/commands/build.ts`) sends a `build_requested` SSE event to the connected browser session, which compiles with esbuild-wasm and POSTs the result back via `awaitBuildResult` (`server-orchestrator-runner.ts`). Without a connected session, the command returns an explicit error instead of silently failing.
- **Python and lua runtimes hidden from the agent during server-side generation**: `buildCodeModePrompt` omits python and lua from the runtime list and adds a caveat. `getDefinitions` strips them from the bash tool description. `buildToolAccessError` uses a filtered command list.

### Security
- **Server-side generation error logging no longer risks leaking the API key**: the `.catch` in the generation route logged the full error object, which for provider failures could include request headers. It now logs only `err.message`.

### Fixes
- **esbuild cache invalidated on service-level failures**: `bundleProject` (`lib/preview/esbuild-bundler.ts`) now clears `esbuildInstance` and `initPromise` when the thrown error has no `.errors` property, distinguishing a WASM crash from a source error. The next build attempt re-initializes instead of reusing a dead instance.
- **Compile error attributed to the file that caused it**: `pushCompileError` in `virtual-server.ts` extracts the actual file path from `[esbuild] /path:line:col` format instead of always blaming the entry point.
- **Admin Users page can reset a password**: `updateUser` in `system-database.ts` accepts `password_hash`, the PUT route at `/api/admin/users/[id]` hashes an optional `password` field, and the Users view adds a Reset Password dialog with generate and show/hide controls. Hidden when identity is managed externally.

### Tests
- **Hollow test audit across the full suite**: 13 findings fixed across 11 test files. Deleted 3 live-reference and tautological tests. Strengthened 5 loose assertions (`toBeGreaterThan(0)` → exact values, `endsWith` → positional checks). Added floor guards before loops that would pass vacuously on empty arrays. Renamed a misleading test description. Added missing positive and negative test cases.

## v1.96.1 - 2026-08-20

### Server Mode
- **Workspace quotas are enforced on all server mode instances**: `sync/projects`, `sync/files` and `deployments/[id]/publish` checked quotas only when `NEXT_PUBLIC_GATEWAY_URL` was set, so standalone instances stored the fields but never enforced them. The page-layout storage warning and the project-manager project-count check were likewise gated.
- **New workspace defaults are unlimited**: SQL defaults in `system-database.ts` changed from 3 / 1 / 100 to 9999 / 9999 / 99999. A migration raises existing workspaces still at the old 3/1/100 values. Redundant `updateWorkspace` calls removed from `default-workspace.ts` and `register/route.ts`.
- **WorkspaceSwitcher and Users page visible on all server mode instances**: both were gated by `isManagedMode` (`!!process.env.NEXT_PUBLIC_GATEWAY_URL`). `managedOnly` field removed from `SidebarItem`.

## v1.96.0 - 2026-08-19

### Preview direct editing
- **Compiled preview HTML stamps each element with its source file and offset**: `injectProvenance` (`lib/preview/provenance.ts`) writes `data-osw-src="<path>:<index>"` onto each eligible open tag, the index a UTF-16 code unit rather than a byte offset, and `resolveSelection` (`lib/direct-edit/resolution.ts`) reads it back. Per `VirtualServer` instance and off by default, so publish, export, thumbnails and the `build` shell command never see it; `curl` strips it with `stripProvenance` regardless.
- **Styles set in the preview are written to `/overrides.css`**: `stampMarker` (`lib/direct-edit/marker.ts`) puts `data-osw-id` on the open tag, `upsertDeclaration` (`lib/direct-edit/overrides-css.ts`) keys a block to that marker, and `ensureOverridesLink` (`link-invariant.ts`) keeps the stylesheet linked from every page.
- **A style change renders in the preview before the file is written**: `STYLE_PREVIEW_JS` (`lib/preview/style-preview.ts`) applies it in-frame as a transient `data-osw-style` rule, and `STYLE_QUERY_JS` reads the computed values the controls display.
- **A declaration the page's own CSS overrules is reported at the foot of the Styles panel**: `STYLE_PROBE_JS` compares what was written against what the element computes, and `STYLE_LOCATOR_JS` finds the rule that won.
- **Selecting an element in the preview shows a toolbar anchored to it**: built inside the frame (`lib/preview/toolbar-dom.ts`), positioned in document coordinates with its chrome in a shadow root, and mounted only where `supportsDirectEditing` (`lib/runtimes/registry.ts`) holds: `static` and `handlebars`, not the bundled or terminal runtimes. Icon actions for Style, a kind-specific Edit text or Replace image, include-in-message and dismiss, each labelled by a shadow-root tooltip built from `aria-label` with `attr()`. Excluded from drop-target detection, the selector, `buildHtmlContext` and `screenshot.ts`'s `onclone`.
- **The Inspector lists the rendered document as a tree in an Elements tab**: `components/elements-panel/` annotates each element with the source file that produced it, serialized in-frame by `SERIALIZE_TREE_JS` (`lib/preview/element-tree.ts`). Opening it no longer closes the preview: `pickEvictionTarget` (`lib/stores/slices/layout.ts`) skips the companion of the panel being opened, otherwise still closing the rightmost open one.
- **Text content is edited from the toolbar and the Inspector**: `readTextRange` and `writeTextRange` (`lib/direct-edit/apply-text.ts`) splice the source range `data-osw-src` points at. Child elements, `{{ }}` expressions and a source tag shared by several elements are refused with a reason.
- **An image is replaced from the project's own images or an upload**: `replaceSrcAt` (`lib/direct-edit/apply-image.ts`) rewrites the one `src` at the provenance index, refusing a value built from a template expression. `uploadFile` moved to `lib/vfs/upload-file.ts` as `uploadFileToProject`.
- **The Styles tab edits the element's text and image, not only its CSS**: a Content section above Spacing holds the text inline, or an image tile and Replace (`components/styles-content/content-state.ts`).
- **Colour is chosen from a popover listing the project's tokens**: `sameColor` (`components/styles-content/tokens.ts`) matches the element's computed colour against a token's declared value across spellings, so the current one is marked. Every token is offered rather than the first six. Reset drops the element's own declaration through `removeDeclaration` (`lib/direct-edit/overrides-css.ts`).
- **Length controls take a typed value, a unit menu and per-side longhands**: the unit converts against the frame's reported root font size, and padding, margin, border width and corner radius expand to their longhands through `partEntry` (`components/styles-content/properties.ts`). `margin-inline` is offered.
- **`Select element` in the empty Styles tab arms the picker**: `focusToolArmed` (`lib/stores/slices/layout.ts`) is shared with the preview header's crosshair, so either toggles it and both show the armed state.
- **Selecting an element no longer attaches it to the next message**: `focusIncluded` (`lib/stores/slices/project.ts`) gates the prompt text, the generation options and the composer chip; the toolbar's include button raises it. Where there is no toolbar to press (mobile, and the runtimes without direct editing) selecting still includes.

### Preview
- **A preview mount handles only its own frame's messages**: the workspace mounts the preview twice and only the visible mount renders an iframe, so `iframeRef.current` was null in the other one and the `iframeRef.current &&` guard let it accept every message the visible frame posted. Both mounts therefore acted on one frame's clicks, each with its own surface.
- **The hidden preview does not compile**: the workspace mounts the preview twice and hides one by CSS, so every change compiled and rendered the project twice. `PreviewCompileGate` (`lib/preview/compile-gate.ts`) parks the request until the mount is measured at a non-zero size.
- **A recompile keeps the frame's scroll position**: `FrameScrollMemory` (`lib/preview/scroll-memory.ts`) reads `scrollY` off the outgoing document and restores it on frame-ready for the same path. Restored with `behavior: 'instant'`, since `scrollTo(x, y)` obeys a document's own `scroll-behavior` and three templates set it to `smooth`.

### UI
- **The Debug Events tabs fill the strip**: Events and Messages stretch to half each, matching the panel tabs the Inspector introduces.

## v1.95.1 - 2026-08-15

### Server Mode
- **A binary file whose `ArrayBuffer` carries another realm's constructor syncs as bytes**: `serializeFileContent` (`lib/vfs/sync-manager.ts`) and `serializeFilesForResponse` (`lib/vfs/sync-utils.ts`) tested with `instanceof`, which an IndexedDB structured clone fails, so `JSON.stringify` sent `{}` and the file was stored empty and published zero-length. Both use `isArrayBuffer` (`lib/vfs/is-array-buffer.ts`), as `backup-service.ts`, `binary-encoding.ts` and `sqlite-adapter.ts` already did.
- **A request for a static asset skips the middleware**: `middleware.ts` excludes `js`, `mjs`, `cjs`, `css`, `map`, `woff`, `woff2`, `ttf`, `otf`, `eot`, `ico` and `avif` alongside the image types it already did. A preview iframe sends every reference the VFS interceptor cannot resolve to the app, so each 404 verified the session JWT first, and a loader retrying a missing chunk sent thousands.

## v1.95.0 - 2026-08-14

### Security
- **A project file path cannot escape its deployment directory on publish**: `static-builder.ts` joined `file.path` onto the output directory, so `/assets/../../../x` resolved above it and wrote anywhere the server process could reach, across workspaces. `resolveWithin` (`lib/vfs/path-safety.ts`) drops such a file, and `isSafeVirtualPath` rejects the push at `sync/files` and `sync/projects/[id]` with a 400. A leading `..` was already excluded, since `shouldExcludeFromExport` drops a dot-prefixed first segment.
- **Deleting a workspace removes its deployments' published output**: the admin delete route cleaned the workspace directory only, leaving `public/deployments/{id}/` on disk and served. It now calls `cleanStaticDeployment`, `removeDeploymentRoute` and `deleteDeployment` per deployment, then `closeWorkspaceAdapter` (`lib/vfs/adapters/server.ts`) before removing the directory.

### Storage
- **Server-side binary content is stored beside the database, not inside it**: a file row holds a sha256 and the bytes live once in `data/workspaces/{id}/blobs/` (`lib/vfs/adapters/blob-store.ts`), recorded as `encoding = 'blob'`. Rows written before this keep `base64` and are read as before.
- **A workspace directory has to be backed up whole**: a database restored without its `blobs/` reads every binary as empty and logs the path and hash. A build older than this reads a `blob` row's hash as the file's text.
- **Publishing hardlinks media into the deployment instead of copying it**: `static-builder.ts` links each blob, and writes only the text it transforms. Copies instead when the deployment output and the data directory are on different filesystems, which is the default on desktop.
- **Unreferenced blobs are collected after a publish**: a blob goes when no row holds its hash, nothing links it, and it was not written in the last ten minutes. A deployment still serving a file the project has replaced keeps working until it is republished.
- **Storage is measured by what it occupies rather than by path**: `lib/api/directory-size.ts` counts hardlinked content once, and the reported figure (`sync/status`) and the enforced one (`sync/files`) both use it.

### Preview
- **A project of several hundred pages compiles**: `processInternalReferences` (`lib/preview/virtual-server.ts`) called `listDirectory` once per HTML file, only to test whether a referenced path exists, so one compile read the whole project — content included, uncached — once per page. `compileProject` builds the path set once. A 621-page project reported `Compile timed out after 30000ms`.
- **The blob-URL map is injected once rather than baked into every page**: `processHTML` wrote a copy into each page's asset interceptor, 45KB per page with 700 assets. The interceptor reads `window.__oswVfsBlobUrls`, supplied by the preview host and by `captureProjectScreenshot` (`lib/utils/project-thumbnail.ts`) through `injectVfsBlobMap`.

## v1.94.2 - 2026-08-14

### Server Sync
- **Publishing a deployment larger than one request body works**: publish goes through `pushProjectWithFiles` (`lib/vfs/sync-manager.ts`), whose `/sync/files` POST sent every file in one request and failed on the truncated body. `pushFiles` batches it. v1.94.1 covered the three paths reaching `/sync/projects/{id}`; this is the fourth.
- **`/sync/files` takes `replace`**: it clears the project's files before writing, which only the first batch may carry, or each batch would delete what the one before it wrote. Absent it defaults to true, so a caller sending the whole set in one request is unchanged.
- **The storage quota is checked once per push** rather than once per batch (managed mode). `getDirSize` walks the whole workspace synchronously, so repeating it per batch blocked the event loop for every workspace on the instance.
- **Publishing reports upload progress**: batch count on one toast, the same handle the workspace and Server Sync use.
- **A template larger than one request body syncs**: "Create a Template" copies the project's whole file set (`lib/vfs/template-service.ts`), so `pushTemplate` hit the same limit. It batches, and `/sync/templates/{id}` takes `appendFiles`, sent on every request but the first, adding to the stored record rather than replacing it.

## v1.94.1 - 2026-08-13

### Server Sync
- **A project larger than one request body pushes**: `pushSingleProject`, `pushProjectDelta` (`lib/vfs/sync-manager.ts`) and `autoSyncProject` (`lib/vfs/auto-sync.ts`) send files in ~5MB batches. Next truncates a body past `experimental.proxyClientMaxBodySize` instead of rejecting it, so the route parsed a body cut mid-string and returned 500. Auto-sync read that 500 as the backend being down.
- **`experimental.proxyClientMaxBodySize` is 32MB** (`next.config.ts`), up from the 10MB default. Batching keeps pushes under it.
- **Every push sends `partial: true`**: a `partial: false` delete-and-recreate cannot be split across requests, so both paths compute `deletedPaths` from the server manifest. A push whose manifest cannot be read is refused rather than attempted.
- **Only the last batch of a push writes the project row**: the route takes `writeProject`. The row stores the client's `updatedAt`, so an earlier batch writing it put the server past the client's `lastSyncedAt` and the next batch took a 409 from the concurrency check. A row a non-final batch creates is stamped at the epoch, since an equal pair of timestamps reads as `synced`.
- **An interrupted push resumes**: deletions ride with the last batch and `lastSyncedAt` is recorded only once it lands, so the retry is a delta carrying the remainder.
- **A file over 24MB serialized fails the push by path** rather than being dropped from it.
- **Push and pull report progress**: `lib/vfs/sync-progress-toast.ts` updates one toast in place, batch count for a push and file count for a pull.

### Checkpoints
- **Checkpoints cover backend features and project settings**: `createCheckpoint` snapshotted only `listDirectory` output, leaving edge functions, server functions, secrets, schedules, `runtime`, `previewEntryPoint`, `globalStyles` and `databaseSchema` outside every undo. `lib/vfs/checkpoint-backend.ts` captures and diffs them; `restoreCheckpoint` takes `{ backend: false }`. Checkpoints written before this leave the backend alone.
- **A checkpoint holds a secret's name, never its value**: a restore keeps the project's stored value where the secret still exists. `previewRestore` reports the two cases that cost one, and the workspace confirms before those restores only.
- **`saveManager.restoreLastSaved` restores files only**: it runs on every project open, and backend features are editable from the project gallery, so rolling them back to the last save discarded edits there was no Save button to commit.

## v1.94.0 - 2026-08-13

### AI Orchestration
- **A run stops for the user when the agent asks something**: a turn with a message, no tool calls and an explicit `status --incomplete` is a hand-back, but `agent-loop.ts` treated the flag as "more work remains" and continued, so the agent answered its own question instead of waiting. It exits `awaiting_user` now. An `--incomplete` with no message still carries on.

### Publishing
- **Published output can be written outside the install directory**: the builder and both serving routes hardcoded `cwd/public/deployments`, and on a desktop install `cwd` is the app bundle, so publishing failed with `EACCES` or landed where the next upgrade discarded it. `DEPLOYMENTS_STATIC_DIR` redirects it, as `DATA_DIR` and `DEPLOYMENTS_DIR` do for the databases. The default is unchanged, so a `STATIC_PROXY` install keeps serving from where Caddy is rooted.
- **Deploy in the workspace starts a deployment for that project**: the Server Mode target dispatched `nav-to-view` with no project attached, so it landed on the Deployments list and the deployment had to be pointed at a project by hand, which is how one ends up serving a project you did not mean. It now opens Deployments with a new deployment started for the project you pressed Deploy from.

### Files
- **Text formats with no runtime here are stored as text**: `SUPPORTED_EXTENSIONS` in `lib/vfs/types.ts` classified anything outside 28 extensions as `binary`, which decides whether an upload is read with `file.text()` or `file.arrayBuffer()` and how a download encodes it. `.php`, `.java`, `.sql`, `.yml`, `.sh`, `.scss` and the rest are text now; unknown extensions still default to bytes. Archives exported before this carry those files as base64.
- **Extensionless text files are recognised**: `Dockerfile`, `Makefile`, `Procfile`, `LICENSE` and similar matched no extension (`'Dockerfile'.split('.').pop()` returns the whole name) and were read as bytes. `TEXT_FILENAMES` matches them by filename.
- **The editor highlights the languages it can store**: its map held 16 extensions, so `.php`, `.java`, `.sql`, `.sh`, `.scss`, `.rb`, `.go`, `.rs` and others opened as plaintext, as did `.jsx`, `.svelte`, `.vue` and `.hbs`.

### Dependencies
- **The dependency tree has no known vulnerabilities**: `npm audit` reported 7 (1 critical, 5 high). The lockfile had drifted behind `node_modules` after an interrupted `npm update`, so `npm ci` and CI installed the vulnerable versions while a local tree looked clean. Refreshing the lock cleared four; the remaining three were `postcss` and `sharp` bundled inside `next`, which needed Next 16.
- **Next builds with webpack explicitly**: Next 16 defaults to Turbopack and refuses a build carrying a `webpack` config. `next dev` and `next build` now pass `--webpack`, keeping the client-side `better-sqlite3` alias and the `fs`/`path`/`crypto` exclusions that config sets.
- **`npm run lint` runs `eslint .`**: Next 16 removed the `lint` subcommand. `eslint.config.mjs` now carries the ignores `next lint` applied implicitly (`.next`, `out`, `build`, `public`, `desktop`), so lint covers the same files as before.

## v1.93.0 - 2026-08-11

### Templates
- **Eight built-in templates are new**, bringing the catalogue to 20: `business-website`, `portfolio`, `store-locator`, `llm-wiki`, `project-tracker`, `guided-chat`, `ai-assistant`, `spring-rest-postgres`. `ai-assistant` requires Server Mode (its key lives in a server function). `spring-rest-postgres` is a Project Kit: Java is neither built nor run here, so its `index.html` is a project overview and its preview is not the service. Closes [#16](https://github.com/o-stahl/osw-studio/issues/16). `research-library` was replaced by `llm-wiki`.
- **Content templates share one component stylesheet**: the CSS moved into `lib/vfs/templates/theme.ts`, extracted from `deepstudio/osw-template-theme.html`. A template's stylesheet now supplies only tokens (accent hue, colour scheme, radius, serif) via `templateStylesheet()`. Content templates were rewritten onto it, which also replaced their seed content and moved form and comment results from toasts into a live region on the page.
- **Built-in template contents are lazy-loaded**: the browser loaded every template's files and edge functions on open, roughly 156 KB. `lib/vfs/templates/registry.ts` now holds metadata only, and a template's module is imported when a project is created from it.
- **Templates can seed `promptSuggestions`** into project settings, applied by `applyBuiltInTemplate`. Copies are per-project; editable in Settings under Project. A project without them falls back to the generic starters.
- **`react-demo` is now "To-do List" and keeps its list**: saved to `localStorage` under a key scoped to `window.location.pathname`, so two deployments on one host do not share a list.

### Choosing a template
- **The list is grouped by a template's `intent`** (starter, website, workspace, app, project-kit) instead of filtered by runtime. Collapsed-group state persists via `configManager`. Runtime remains a searchable badge.
- **A template can be previewed before it is chosen**: it compiles through the same `VirtualServer` path as the editor preview, in a throwaway project deleted on close. Available from the template list and the Templates page. Terminal runtimes (Python, Lua) have no preview.
- **The list warns when a template cannot fully run in Browser mode**, before the project is created, linking to the Server Mode docs. This covers templates whose runtime or backend features do not run locally.
- **New projects default to the `handlebars` runtime** rather than `static`. Starter templates renamed (`Starter (Svelte)` to `Svelte Starter`) and moved into a collapsed group.

### Fixes
- **Bundled runtimes no longer resolve dependencies to a CDN at runtime**: `esbuild-bundler` left package imports pointing at `esm.sh`, so published and exported React, Preact, Svelte and Vue sites fetched their framework on every visit and broke when it was unreachable. Dependencies are fetched during the build and inlined into `bundle.js` (Svelte's runtime alone was 42 modules). Builds need network access, as they already did for the Svelte and Vue compilers. Published and exported output is minified; the editor preview is not.
- **An outbound `fetch` is bounded by the function's deadline**: the sandbox capped every request at 10s while a function may run for 30s, so a slow upstream was aborted well inside the budget it had been given. Model calls hit this routinely. The cap is now the lower of the function's remaining time and 30s.
- **A secret set on a deployment survives the next publish**: the deployment's secrets panel wrote only to `runtime.sqlite`, and publishing deletes every runtime secret and re-provisions from the bound project, so the value was silently replaced. Create, update and delete now write through to the project's `project_secrets` as well as the runtime copy.
- **An edge function's `console` output is logged when it fails**: the sandbox collected it and the route dropped it, so a function that recorded an upstream 401 reported only its own generic error. Output is logged when a call errors or returns 4xx/5xx.
- **An edge function can call `fetch` again**: any sandboxed function that fetched aborted the QuickJS runtime at teardown (`Assertion failed: list_empty(&rt->gc_obj_list)`) and returned a 500, so every template making a server-side API call was dead. `fetch` returned its deferred promise handle from a `newFunction` callback, transferring ownership to the VM, and the continuation then resolved it through that freed handle. The VM gets a duplicate now.
- **A function that runs out of time no longer aborts the runtime**: same assertion, different route. The evaluated module's handle was released only on the success path, so a deadline expiring mid-request left it alive with a request still in flight. Teardown cancels outstanding requests, waits for them to settle, and releases the handle whatever the outcome.
- **A deployment's URL is resolved by the server**: the deployment card and publish settings built `https://{slug}.{hostname}` whenever a slug existed, which publish assigns unconditionally, so a local deployment offered the unreachable `https://{slug}.localhost` and thumbnail capture followed it. Both API routes return a `publicUrl` from `resolveDeploymentServing`, falling back to `/deployments/{id}` unless `STATIC_PROXY` routes slug subdomains.
- **Preview works from the Projects list**: it required an editor-opened project to compile, so the dialog never left "Compiling project...", and it ignored the project's runtime, rendering bundled-runtime projects blank.
- **Template Manager applies the template's runtime**: it wrote the files and left the runtime at its default, so bundled-runtime projects stayed marked `static`. It also handled only five built-ins; the rest produced an empty project.
- **`.oswt` export includes backend features**: it read them from the temporary project it builds to export, which was never provisioned with them.
- **Template-declared scheduled functions are provisioned**: templates could declare them and nothing created them.
- **The contact form template sends its notification email**: the Resend call passed an already-encoded body that the server runtime encoded again, so Resend rejected it. Affected projects created from that template with a Resend key; stored submissions were unaffected.

### Security
- **The contact form template no longer ships `list-messages`**: the edge function returned the 50 most recent submissions, including names, email addresses and message bodies, to any unauthenticated caller. The page called it on load only to detect a server, and discarded the response; that check is now a `contact-status` function returning no data. **Existing projects keep their own copy and republishing will not remove it**: delete the function in the project's Backend panel.
- **Blog comments are built as DOM nodes** rather than concatenated HTML with manual escaping.

## v1.92.1 - 2026-08-06

### Fixes
- **A project's database schema stays with the project**: The schema was kept in browser storage rather than on the project, so everything that moves a project left it behind: downloading its files, an `.osws` backup, and Server Mode sync. A project made from the contact form or blog template arrived on another machine with its edge functions intact and no tables for them to read. The schema is now stored with the project and travels in all three, and it appears in the import preview as a setting you can accept or leave. A schema saved before this release moves across the first time it is read, which is when you download the project's files, or when the project opens in Server Mode.

## v1.92.0 - 2026-08-06

### Projects
- **A project can be downloaded and brought back**: The existing ZIP export produces a compiled site — the pages a host serves, without the sources, the project's settings or its server functions. The File Explorer now also downloads the project itself: every file at its real path including `.PROMPT.md` and the rest, the runtime and entry point in a `project.json`, and each server function as an editable `.js` file next to a small `.json` holding its settings. Secret values are never included; their names and descriptions are. The result is a plain zip you can open in any editor, and downloading an unchanged project twice produces identical files.
- **Importing shows what it will do before it does it**: Import accepts a downloaded zip, a folder, or the old `.json` backup, from the Projects list as a new project or from the File Explorer into the project you have open. Before anything is written you see what would be added, what already exists, what is identical, and anything that can't be imported along with the reason. Files that already exist can be kept, replaced, or both kept with the incoming copy renamed, decided in bulk or one at a time. Importing into an existing project takes a checkpoint first, so the file changes can be undone in one step from the Checkpoints panel — a replaced server function or a changed setting cannot, and the preview says so where you make that choice.
- **An archive that carries AI instructions says so**: `.PROMPT.md` is read as standing instructions for the assistant, so an archive containing one changes how the assistant works on the project. It is called out separately rather than listed as one file among many.
- **Server functions in an imported archive are kept in Browser mode**: they are stored with the project and travel with it, but only run in Server Mode. The preview says so rather than leaving it to be discovered after publishing.
- **Settings from an import take effect immediately**: importing a runtime or entry point used to write it to storage while the open project kept building the old way until it was reopened.
- **A dropped `.zip` opens the import preview** instead of being stored as a file, which it almost never was meant to be. The preview offers to keep it as a file instead, and uploading a zip as an asset still works from **Upload files** or by dropping it alongside other files.

### Fixes
- **Dropping a file onto a folder in the File Explorer no longer does nothing**: a file or folder dragged from outside the app onto a folder row was discarded with no upload and no message. Anything dropped now lands at the top level of the project, where it can be moved.

## v1.91.2 - 2026-08-03

### AI Orchestration
- **Transcription and skill checks stop receiving coding instructions**: Both send a single request with their own instructions, and the server was prepending a description of the file-editing agent including a list of shell commands written for an earlier version, naming two that have never existed. That description is now only added to requests that actually carry tools.

### Agent shell
- **`rmdir` works**: The permission settings offered a control for it and the delete permission was labelled "rm / rmdir", but running it reported an unknown command. It now removes a directory when it is empty and refuses when anything is still inside, leaving `rm -r` as the way to delete a folder along with its contents. `-p` clears the parents that empty out along with it.
- **The agent is told about every command it can run**: Six commands the shell accepts were missing from the list it is shown, including the one printed when it uses an unknown command, so it had no way to learn they existed. The list is now generated from the commands themselves and cannot fall behind.
- **The agent's instructions list `head -c`/`tail -c`**: The instructions described `head`/`tail` as taking a line count only. The shell's own reference was corrected in v1.91.1; this is the copy the agent is given up front.

### Security
- **Restricted agents can no longer change the project runtime**: An agent confined to one directory — the interview agent is confined to `/.interviews/` — was allowed to run `runtime`, which rewrites the project's prompt file outside that directory. Changing the runtime now counts as a write and is refused for a confined agent, while unrestricted use is unchanged.
- **Chat mode no longer lets two commands through**: Chat is read-only, but the check for which commands write had fallen behind the shell, so generating an image or changing the runtime could still modify the project from Chat. Both are refused now, and the check is derived from the commands themselves rather than kept in step by hand.

## v1.91.1 - 2026-08-02

### Fixes
- **The shell's command reference lists `head -c`/`tail -c`**: Character counting was supported but missing from the command list the agent is shown, including the one printed when a flag is rejected.
- **Redirects written without spaces work**: `ls>out.txt` and `cat a>>b` were only recognised when the `>` stood alone, so the command ran without redirecting and silently wrote nothing. Markup (`<p>hi</p>`), quoted text and stderr redirects such as `2>/dev/null` are still left as they are.

## v1.91.0 - 2026-08-01

### Project creation
- **Templates are browsable**: Creating a project asked for a runtime first and then offered only the templates belonging to it, so you had to know what "Handlebars" or "Preact" meant before seeing what you could build. Every template now sits in one searchable list, built-in and your own together, with the runtime shown against each and available as a filter. Expanding a row shows the full description, author, license, tags, and a thumbnail if the template has one.
- **The template sets the runtime**: The separate runtime picker is gone. Whichever template you pick decides the runtime, and you can still change it later in project settings.

### Providers
- **DeepSeek**: Added DeepSeek as a built-in provider. Add your key under Connections and its models appear like any other provider's, with tool calling and streaming.
- **Providers are listed alphabetically**: Connections and the model settings picker followed the order providers happened to be declared in, which made a name hard to find as the list grew.

### Agent shell
- **`head` and `tail` accept `-c`**: Counting characters was unsupported, and the flag was skipped rather than refused, so `head -c 600 file` looked for a file named 600 and failed with a missing-file error that said nothing about the flag. Both commands now take `-c`, and an unrecognised flag is reported as one.
- **Operators no longer need spaces around them**: `cmd; other` and `a|b` were only recognised when the operator stood alone, so a command written without spaces ran as one long argument list and produced errors that pointed at the wrong thing. Unquoted `;`, `&&`, `||` and `|` now separate commands wherever they appear, while quoted ones stay literal.

## v1.90.2 - 2026-08-01

### Fixes
- **A conflict can be resolved by keeping your copy (Server Mode)**: When a project had changed both locally and on the server, Server Sync offered Push and then refused it with a bare "conflict", so the only way out was to pull and discard the local work. Pushing from Server Sync now overwrites the server copy, which is what the button has always said it does. Background syncs still leave a conflicted project alone and report it rather than picking a side for you.

## v1.90.1 - 2026-07-31

### Fixes
- **Projects restored from an `.osws` backup sync on their own (Server Mode)**: A restore also brought back the timestamps recording when each project last synced, and those referred to whichever instance the backup was taken from. Measured against a different server they never settled, so a restored project stayed marked as out of step (as a conflict, which pushing cannot resolve, or as local only) until it was pushed by hand in Server Sync. A restored project now counts as not yet synced, so the automatic push picks it up. Restored skills carried the same timestamps and reported the same false drift.

## v1.90.0 - 2026-07-31

### Files
- **Any file can live in a project**: Only a fixed list of extensions was accepted — everything else was refused on upload, and anything that slipped in by another route was treated as text and corrupted. That list is gone. Drop in an audio track, a web font, a PDF, a 3D model for three.js, a WebAssembly module; the preview and published site serve them with the right media type. Size is the only limit.
- **File contents are no longer guessed from the file name**: Whether a file is text or raw bytes now follows what it actually contains, recorded when it is saved. Previously an extension the app didn't recognise was assumed to be text, which destroyed it — the reason images, fonts and audio were being lost in several places. A format nobody anticipated is now safe by default rather than corrupted by default. Files that were already stored as text this way cannot be recovered and need adding again.

### Sync (Server Mode)
- **Sync state is visible without opening Server Sync**: Project cards show a badge when a project is out of step with the server, and the Server Sync entry in the sidebar shows how many projects are waiting to be pushed. Previously the only way to find out was to open the dialog and look.
- **Imported projects no longer get stuck on "Local newer"**: The push on import worked, but opening the imported project straight afterwards counted as a local change and nothing pushed again, so it stayed marked as unsynced indefinitely. Opening a project is no longer treated as a change to it — one consequence is that opening a project no longer moves it to the top of Recent Projects.
- **Renaming a project, or changing its runtime, entry point or thumbnail, now syncs**: These were saved locally but never pushed, so the project stayed marked as having unsynced changes.
- **Projects the server is behind on catch up on load**: The load-time reconcile only handled projects that had never reached the server at all. It now also pushes projects that have simply moved on locally, sending just the files that changed. Projects with unsaved edits, and genuine conflicts, are left for you to resolve in Server Sync.
- **A project that failed to upload is retried**: If the server was unreachable when a project was saved, it was afterwards excluded from the background sync that exists to retry exactly that — so it stayed local until the next edit happened to trigger another attempt.
- **An unreachable server is no longer read as an empty one**: When the server could not be reached, or the session had expired, background sync took that as "the server has nothing" and re-uploaded every project in full, deleting and recreating every file server-side. The sync badges and sidebar count did the same, marking everything "Local only". Both now hold on to the last known state and wait until the server can actually be seen.
- **An interrupted download retries itself instead of going quiet**: If downloading a project from the server stopped part-way — a full disk, a closed tab — it was already recorded as up to date over a half-written set of files. It looked fine, was never downloaded again, and the next background sync could upload that partial copy over the server's complete one. A download is now recorded only once the files have arrived, and a project that was being created for the first time is removed again rather than left behind.
- **Auto-sync no longer corrupts images and fonts**: Background sync sent binary files unencoded, so every automatic save replaced the project's images and fonts on the server with empty files, and pulling stored them locally as text. Both directions are now correct, and a background push sends only the files that changed instead of re-uploading the whole project.
- **Freshly synced projects stop showing as unsynced**: The sync badge and the sidebar count read a snapshot taken up to five seconds earlier, so a project could show "Local only" straight after it had been uploaded. Any completed sync, automatic or manual, now refreshes that immediately.
- **Sync status is no longer misreported after a pull**: A project pulled from the server was marked as locally changed the moment it arrived, and one pulled during a server-side generation was reported as "Synced" no matter how far the two copies had actually diverged.
- **Projects stay in their own workspace**: A project belonging to one workspace could be copied into another after switching workspaces in the same tab. Background sync now declines to act when a project's own record contradicts the server's list, rather than assuming the project is new.

### Deployments (Server Mode)
- **The project picker in deployment settings stays current**: Pushing a project through Server Sync and then opening a deployment's settings showed the project list from when the page loaded, so a just-pushed project was missing until a full reload. The settings picker and the project gallery now both refresh when a sync completes.
- **Analytics, edge functions and scheduled functions work again**: All of these are reached by deployment ID alone and were looking in the wrong database, so opening a deployment's settings raised "Deployment not found" errors, published sites recorded no analytics, edge functions returned 404, and scheduled functions never ran. Every server-mode install was affected, not only managed ones.
- **Analytics no longer loads behind other dialogs**: Opening deployment settings or server settings also started the analytics dashboard's requests in the background, before you had asked to see them.

### Backup & restore
- **Restoring an `.osws` backup works again**: The backup tool opened a fixed database name and schema version rather than the one the app uses. Outside browser mode the local database is named after the workspace, so a restore wrote everything into an unrelated database, reported "Data imported successfully", and reloaded to unchanged data; exporting failed outright. In browser mode both failed with a version error. Backups now read and write the database the app is actually using. Your existing data was never overwritten by this, but a backup taken before this release will be missing the items below.
- **Backups cover everything, not a third of it**: Only projects, files, the file tree, conversations and checkpoints were included. Custom templates, skills, edge functions, server functions, scheduled functions, secrets and debug events were silently absent from every backup. The backup now follows the database's own contents, so anything added later is included automatically. **Because secrets are now included, and project secrets are stored unencrypted, an `.osws` file can contain API keys and other credentials — treat a backup file as sensitive and don't share it.**
- **Images and fonts survive a backup**: Binary file content was written out as an empty object, so every image and font was lost on restore even when the restore itself worked.
- **"Replace all current data" actually replaces it**: Outside browser mode the existing data was never cleared, and the step that was supposed to close the database first never did, so it stalled for several seconds before continuing regardless. Replace now clears the live data directly.

### Templates
- **Templates keep their images and fonts**: A template's files are stored as JSON, which cannot hold binary content — so every image, font and other binary file in a template was written out empty. This affected templates saved locally, templates exported as `.oswt`, and templates pushed to the server, where pulling one back then wrote those empty files over the good local copy. Binary content is now encoded in all three, so a template you create a project from restores those files intact rather than as corrupted text, and archives are compressed so encoding them doesn't push a large template past the import size limit. Existing `.oswt` files and saved templates are missing that content and need to be re-created from a project to recover it.
- **Exported templates keep their author, license, tags and thumbnail**: Exporting a saved template from the template manager wrote its details into the wrong part of the `.oswt` package. Importing that file back silently dropped the author, license, tags, thumbnail and version number, and uploading it could be rejected as an unsupported template format. Template exports now use the same package format as exporting a project as a template. Exporting a built-in template was not affected.

### Security
- **Analytics endpoints check who is asking**: They required a session but never checked that the caller had access to the deployment, and deployment IDs appear in every published page — so any signed-in user could read, export or delete another workspace's analytics. Access is now verified against the workspace that owns the deployment. An unused endpoint that skipped the check entirely has been removed.

## v1.89.0 - 2026-07-20

### Connections
- **Free DuckDuckGo web search**: DuckDuckGo is available as a search provider that needs no account or API key — select it under Connections and it becomes the active provider. It supports the same search, result-count, and page-content options as the existing providers. Because it relies on unofficial scraping, searches can be rate-limited or blocked — more so on shared or hosted instances where every user's searches come from one address — so Connections flags it as best-effort and the agent is told to retry or switch to a key-based provider when a search fails.

### Providers & models
- **Live ChatGPT (Codex) model discovery**: The model picker now fetches the current Codex catalog for the signed-in ChatGPT subscription instead of relying only on a hardcoded list, so new GPT-5.5 and GPT-5.6 models appear without an OSW Studio release — with live names, descriptions, context windows, and image support, ordered by Codex's own priority. Expired access tokens are refreshed automatically before the fetch, and if the catalog can't be reached the built-in fallback list (also updated in this release) is used.

### Fixes
- **"Clear all events" tooltip now notes it also clears the chat** ([#23](https://github.com/o-stahl/osw-studio/issues/23)): the chat is built from the same event log.

## v1.88.0 - 2026-07-19

### Connections
- **Browser sign-in for ChatGPT subscriptions (Codex)**: Connecting a ChatGPT Plus/Pro subscription now uses a browser sign-in instead of installing the Codex CLI and pasting `auth.json`. Tokens are created and refreshed automatically, and the refresh token stays in an HttpOnly cookie, never in localStorage. Local and desktop installs complete automatically; on a self-hosted instance where OpenAI's localhost callback can't reach the app, you paste the redirect URL from the ChatGPT tab to finish. Not available on HuggingFace Spaces, which runs the app in an embedded frame that can't hold the session cookie.

## v1.87.2 - 2026-07-19

### AI Orchestration
- **AI file edits containing HTML entities are no longer corrupted**: When the AI wrote code that contained HTML entities — for example an HTML-escaping helper built on `&amp;`/`&lt;` — the content was decoded as it was saved, silently turning that code into a no-op. Content the AI writes to a file is now saved exactly as written; only the command around it is decoded.
- **Reliable multi-file writes in a single step**: When the AI created several files at once and one file's contents had an odd number of quote characters, the files that followed could be merged together or dropped. Each file is now written correctly.
- **Inline Python and Lua snippets run**: `python -c "..."` and scripts piped in on standard input previously failed with "Entry point not found". They now execute.
- **Clearer errors when the Python or Lua runtime can't load**: The Python and Lua runtimes download on first use. If that download fails — the browser is offline, or the source is blocked — the AI now gets a clear "runtime unavailable" message telling it to write the script out instead of a cryptic error, and a failed optional-package download no longer aborts an otherwise-working Python script.

## v1.87.1 - 2026-07-19

### Fixes
- **No more HuggingFace sign-in nag when another provider is connected**: On HuggingFace Spaces, the composer's onboarding button pushed "Sign in with HuggingFace" whenever the active model wasn't ready — even for users who had already connected a different provider or pasted an API key and never touched HuggingFace. The sign-in prompt now only appears when no provider is connected at all.
- **Imported projects sync to the server automatically (Server Mode)**: An imported project (or one whose earlier push silently failed) used to stay "local only" until you manually ran Server Sync. Server Mode now reconciles local-only projects up to the server on load, so they become deployable on their own.
- **New-deployment project list stays current (Server Mode)**: The project picker in the "New deployment" dialog previously needed a full page reload to show a freshly created or imported project. It now refreshes when you open the dialog.
- **Imported templates appear immediately in the new-project picker**: Importing, saving, or deleting a custom template now updates the template list in the "Create New Project" dialog live, instead of only after navigating away and back.
- **Interrupted generations resolve cleanly (Server Mode)**: If the server restarts mid-generation, that generation is now reported as a clear failure instead of appearing stuck or being mistaken for a success. Reconnecting after a generation finished still recovers its result; a generation whose status has aged out is shown as "status unknown" rather than a false success or failure.
- **Faster generation start (Server Mode)**: Before each generation the app no longer re-uploads the entire project — it skips the upload when the server copy is already current, and otherwise sends only the files that changed or were deleted.
- **Background task popup stops nagging once you've seen it**: A generation that finished in the background kept showing its notification on the projects list and menus even after you opened the project and viewed the result. Opening a project now dismisses its finished-task popup; still-running tasks keep showing until they complete.
- **No stray focus outline on the analytics disclosure dialog** ([#18](https://github.com/o-stahl/osw-studio/issues/18)): When the "Anonymous Usage Analytics" dialog opened, Firefox drew a focus ring around the "Details" toggle because the dialog auto-focused its first button. The dialog no longer moves focus to a control on open, so no outline appears.

## v1.87.0 - 2026-07-13

### Preview
- **In-app navigation is respected**: The live preview no longer hijacks links that the app handles itself, so client-side routers (React/Vue/Svelte) and hash-based routing work instead of reloading or dead-ending. Plain multi-page links still navigate, and the Back/Forward buttons now move through history correctly (Back previously jumped straight back to the latest page).
- **External links open safely**: Clicking an external link in the preview now prompts to open it in a new tab (with `noopener`/`noreferrer`), instead of silently navigating the preview away or opening a tab with no protection.
- **Recovers from a lost preview**: If the preview navigates somewhere it can't serve — a form submit, a script redirect, a meta refresh — it now notices the frame is no longer showing your project, tries a reload, and if that doesn't help shows a "Preview navigated away — Reload preview" prompt, instead of going silently blank until your next edit.
- **A stalled compile can't wedge the preview**: A compile that hangs (for example waiting on a component-compiler download) now times out and surfaces an error, instead of freezing every later preview update.
- **Read-only commands don't reload the preview**: While the agent works, only commands that actually change files reload the preview. Read-only commands (search, grep, cat, listing files) no longer trigger a needless recompile.

### Fixes
- **Mobile voice input no longer duplicates words**: On phones, the browser speech-to-text repeated finalized words (e.g. "Testing 1 2 3" came out as "Testing TestingTesting TestingTestingTesting 1"). Each word is now transcribed once.
- **Local `curl` no longer asks for web-access permission**: In Ask permission mode, a local preview fetch that was piped or redirected (e.g. `curl -s localhost | head`) was misread as an external request and prompted for Web access. Local fetches are recognized as local again and run without a prompt; only genuinely external URLs ask.

## v1.86.2 - 2026-07-12

### Fixes
- **Guided reconnect for older HuggingFace connections**: A HuggingFace connection made before publishing was added stored your display name where your username belongs, so publishing a Space failed with a raw "403 Forbidden". The Deploy dialog now detects this and prompts you to reconnect HuggingFace once, rather than showing the error.
- **Reconnecting returns you to Deploy**: After you grant permission or reconnect HuggingFace from the Deploy dialog, it reopens automatically when you come back, instead of leaving you in the workspace.

## v1.86.1 - 2026-07-12

### Fixes
- **Publishing to a Hugging Face Space works**: Publishing failed with a "403 Forbidden" that kept asking to re-grant permission even after it was granted. The Space was being created under your display name instead of your HuggingFace username — not a valid location — and the resulting error was misread as a missing permission, causing the loop. It now uses your username, and a genuine refusal shows the actual reason instead of bouncing back to the permission prompt. Reconnect HuggingFace once to pick up the fix.

## v1.86.0 - 2026-07-12

### Deploy
- **Publish to a Hugging Face Space**: With HuggingFace connected, a new Deploy button in the workspace header lets you publish a project as a static Space under your own account, live as soon as it finishes. Pick a name (suggested from the project), an optional description, and public or private. Re-deploying updates the same Space, or you can publish it as a new one. Each Space's README credits OSW Studio, and the site gets an optional "Built with OSW Studio" footer you can turn off. Python and Lua projects run in a terminal and can't be served as a static Space; use ZIP export for those.
- **Deploy target picker**: The Deploy button opens a picker with three targets: a Hugging Face Space, this OSW Studio instance (Server Mode), or a ZIP download you can upload to any static host. Targets that aren't available in your setup are shown with how to enable them, and each links to the deployment docs.
- **Connect HuggingFace with a token**: Outside the HuggingFace Space demo, where the one-click sign-in isn't available, you can connect HuggingFace by pasting an access token with write access under Connections. This will enable publishing a Space from a self-hosted or local instance.

### UI
- **Consolidated Settings**: The workspace header's separate Project and settings buttons are now a single Settings button that opens one dialog with tabs for your general preferences (app settings, cost tracking, permissions) and the project's own settings and backend features. When the tabs don't fit the width, they collapse into a dropdown.

### Fixes
- **Broken images are caught instead of silently blank**: When a generated page references an image (or script or stylesheet) that fails to load — common with fabricated stock-photo URLs — it now surfaces as a console error the agent can see and fix, rather than leaving a blank spot it assumes is working. On a load failure the agent falls back to a reliable placeholder image.
- **Manual edits are no longer reverted**: If you edit and save a file between tasks, the agent can no longer silently revert it by rewriting the whole file (or replacing a whole element) from an older version held in its conversation history — when it detects the file changed under it, it's prompted to re-read your current version and reconcile instead. Surgical edits that leave your changes in place still work, and files it hasn't changed are unaffected, so it never interrupts normal writing.

## v1.85.0 - 2026-07-11

### Fixes
- **"Sign in with HuggingFace" no longer blocks the chat for already-connected users**: On a HuggingFace Space, a user who already had a provider connected could see the "Sign in with HuggingFace" button take over the model selector and disable the composer. The chat is now usable on load, without deleting and re-adding the connection. (#17)
- **Dashboard cards in light mode**: The dashboard cards (Content Overview, What's New, Recent Projects) rendered with a dark background on the light dashboard. They now follow the theme in both light and dark modes.
- **Docs showing the wrong page**: Switching documentation pages quickly could briefly show the previous page's content. Only the most recently selected page is shown now.
- **Docs table-of-contents highlighting**: On pages with repeated section names (like the changelog), the "on this page" outline highlighted the wrong entries and clicking one could scroll to the wrong place. Both now track the correct heading.

### UI
- **Neutral by default, orange as an accent**: Primary buttons, active items in the sidebar and settings, project cards, and the workspace's dark-mode panel toggles now use a neutral style instead of a solid orange fill. Orange is kept for accents and active highlights, such as the Built-in/Custom source filters on the Skills and Interviews pages. Destructive actions remain red.
- **Consistent chat controls**: The model selector and the Chat/Code/Interview selector now share the same neutral split-button style, with the mode's color shown on its icon.

## v1.84.0 - 2026-07-07

### Onboarding
- **Straight into a workspace**: A first-time visitor with no projects yet now lands directly in a workspace with a starter project already created, instead of the dashboard and a new-project form. Returning users still see the dashboard.
- **Sign in with HuggingFace**: On a HuggingFace Space, when no provider is connected the model selector shows a "Sign in with HuggingFace" button. One click runs the OAuth sign-in and then selects a capable default model, so a new user can start building without pasting an API key. The chevron beside it still opens the full Connections screen for other providers.
- **Your project survives sign-in and reload**: The open project is now kept in the page URL, so reloading the page (including the redirect during HuggingFace sign-in) returns you to the same project instead of the dashboard. The browser Back button also leaves a project as expected.
- **Starter suggestions**: When a provider is connected and the conversation is empty, a small row of suggestion pills appears above the chat input. Clicking one fills the composer with a starter prompt you can edit before sending.

### Model selection
- **One model selection for every project**: Your model and template selection is now global and applies to every project, instead of being remembered separately per project. Switching between projects no longer changes which model is selected.
- **Connecting a provider readies the chat**: Connecting a provider now selects a working model automatically (its recommended default if the provider serves it, otherwise the first model it offers), so the chat is ready to use immediately and every project, including newly created ones, inherits it instead of showing "Select provider".
- **Pick a model and use it right away**: Choosing a model in the picker takes effect immediately. Save writes your selection into the current template and Reset reverts to the template's saved models, so you can try different models without changing your template unless you want to. Built-in recommended templates are read-only and marked with a lock icon.
- **Model picking works in the describe step**: The model you select while describing a new project to get started is now the one actually used for generation, and that picker updates live the same way it does in the workspace.

### Generation
- **Reassurance on long file writes**: If a single file write runs longer than 30 seconds (common on slower models without live tool streaming), a small note explains the agent is still working and will continue once the write finishes. It can be dismissed for good.

## v1.83.1 - 2026-07-06

### Desktop
- **Generation works**: Desktop generation failed with an "Unauthorized" error, and its progress stream filled the console with errors. The desktop app runs in Server Mode but does not sign in the way a self-hosted server does, and the generation endpoints did not recognize its local session. They now do, so generation and its live updates work.
- **Auto-update downloads**: The Windows and Linux auto-updater could not download new versions because the installer filename in the update manifest did not match the published file. The names now match, so updates download and install.
- **Update failures are reported**: If an update fails to download, the app now shows an error with a link to the releases page, and reports download progress while it runs, instead of silently doing nothing.
- **Open Logs Folder**: The Help menu's "Open Logs Folder" opened a folder that did not exist yet on a clean install. It is now created when you open it.

## v1.83.0 - 2026-07-05

### Web access
- **`search` command**: The agent can search the web when you configure a search provider under Connections. Pick one of Tavily (1,000 searches/month free, no card), Firecrawl (1,000/month free), Brave ($5 monthly credit, card required), or your own SearXNG instance, and enter its key or URL. `search "query"` returns numbered results; `-n N` sets the count and `--markdown` includes extracted page content. Without a configured provider the command is not offered to the agent, so no wasted calls.
- **`curl` fetches external URLs**: `curl` previously only served the local preview. It now also fetches real external pages through a server-side proxy. `curl --markdown <url>` returns readable markdown instead of raw HTML, and `curl -o <path> <url>` downloads a file (including images and other binaries) into the project. Localhost preview behavior is unchanged. Outbound requests are validated against private and internal addresses, capped in size and time, and can be disabled per instance.

### Permissions
- **Permission modes**: A new selector on the chat input sets when the agent asks before running a consequential command: Auto (never ask), Ask (the default; prompts for web access, image generation, and file deletion), or Custom. When a gated command comes up, the run pauses and shows a prompt with Allow once, Always allow, or Deny. Denying tells the agent to continue without that action.
- **Custom permissions**: A per-command matrix (from the selector's cogwheel or the Permissions section in Settings) lets you choose exactly which commands ask for confirmation, including separate control for read versus write on commands that do both.
- **Server Mode**: Server-mode generation runs on the backend where there is no prompt to show, so any command you have gated is declined there rather than run silently. Set the mode to Auto if you want server-mode runs to use these commands without asking.

### UI
- **Connections reorganized**: The Connections screen is now split into an AI section (cloud and local inference providers) and a Search section. Web search providers are managed the same way as inference connections, as cards, with one marked active and used for searches. Each section's "Add" button sits on its header.
- **Collapsible model groups**: In the model picker, each provider's header can be collapsed to hide its models, and the collapsed state is remembered. Searching temporarily expands every group so matches are never hidden.
- **Completion sound**: Task completion now plays the same two-note sound whether the run was in the foreground or background; a single-note sound signals a pending permission prompt.

## v1.82.0 - 2026-07-04

### Analytics
- **Wider anonymous usage analytics**: The optional usage analytics now cover many more actions, so a one-person project can see which features are actually used. New signals include mode switches, interview and skill/template authoring, project open/export/import, deployment and manual-sync activity, and which built-in skills the AI reads while working. Everything collected is still counts and category labels only, never your prompts, code, file names, custom skill/template names, API keys, or error messages. The first-run notice was updated to list the fuller set and is shown once more so you can review it; if you had already turned analytics off, they stay off and you are not asked again.
- **Analytics now report in Server Mode**: Previously only the browser app reported usage, so self-hosted and desktop instances sent nothing at all. They now report the same anonymous signals. Self-hosted builds can still disable analytics entirely at build time.

## v1.81.0 - 2026-07-03

### Interview mode
- **Custom interview templates**: You can now create, edit, duplicate, and delete your own interview templates, alongside the four built-ins. The editor sets the interview's title and description, the file under `/.interviews/` it records into, and a list of items. Each item is a question the agent asks and a "done when" condition that the completion check verifies against what was recorded. An optional handoff shows a button when the interview finishes that starts a build (or chat) from the result. Built-in templates are read-only, but you can duplicate one to start from it. Interview mode itself is unchanged; this adds the template management that was missing.
- **Managing templates**: Reach them from the interview picker in the chat panel (New and Manage), or from a new Interviews entry in the main menu.
- **Sync (Server Mode)**: Your custom interview templates sync across devices, alongside skills, project templates, and model templates. Only the template definition travels; nothing device-specific is sent.

### UI
- **Custom items listed first**: In the Skills, Templates, and Interviews listings, your own custom items now sort before the built-in ones.
- **Narrower editor dialogs**: The skill and interview template editors no longer stretch to full width on large screens.

## v1.80.2 - 2026-07-02

### Fixes
- **Zip export is now self-contained**: Exported HTML and CSS referenced assets through `blob:` URLs pointing back at the OSW Studio instance that produced the export, so images and other assets failed to load when the zip was deployed elsewhere, even though the files were included in the zip. The export now restores the original root-relative asset paths and strips the preview-only instrumentation scripts, so the output loads correctly when served from a web server root. ([#12](https://github.com/o-stahl/osw-studio/issues/12))
- **JSON export no longer drops images or resets the runtime**: Exporting a project to JSON serialized binary files (images, fonts, etc.) as empty objects, so they were missing after import, and neither JSON import nor project duplication carried over the project's settings, so the copy fell back to the legacy Handlebars runtime instead of keeping its own (e.g. static). JSON export now encodes binary content as base64 and restores it on import, and both import and duplication preserve the project's settings. Chat history is still not included in JSON export. ([#11](https://github.com/o-stahl/osw-studio/issues/11))
- **Server Mode: imported and duplicated projects can now be deployed**: An imported or duplicated project lived only in local storage until the next manual save, so it never reached the server and was missing from the New Deployment project picker. Importing or duplicating now pushes the project to the server, so it's immediately available to deploy. ([#13](https://github.com/o-stahl/osw-studio/issues/13))
- **Server Mode: published deployments no longer 404 their assets on first publish**: A newly published deployment's stylesheets, scripts, and other assets were built with the wrong URL paths, so everything except the main page failed to load. The first publish now writes correct asset paths. Deployments published before this fix load correctly after publishing once more. ([#14](https://github.com/o-stahl/osw-studio/issues/14))

## v1.80.1 - 2026-07-01

### Fixes
- **Server Mode: generation no longer fails for per-project model setups**: When a project's agent model was set through the per-project picker (rather than a global default), server-mode generation sent an empty model to the backend and failed with "Missing required fields: ... model". It hit newer providers hardest — opencode-go has no global default model to fall back on, so it failed every time. Server-mode generation now resolves the model from the project's own configuration, matching browser mode.
- **Preview: dynamically fetched files no longer 404**: In static projects, loading a shared partial at runtime (e.g. `fetch('/components/nav.html')` to inject a nav or footer) returned a 404 in the preview, even though the file existed. The preview only resolved its asset map for files referenced as attributes (`<img>`, `<link>`, `<a>`), so a path fetched from JavaScript escaped to the real host and missed. The preview now resolves any project path the same way, so these fetches work. The static project guidance also leads with duplicating shared elements as the simplest reliable approach, and notes that the fetch approach is root-relative — it works when the site is served from the domain root but not under a subpath. ([#10](https://github.com/o-stahl/osw-studio/issues/10))

## v1.80.0 - 2026-06-30

### Providers & models
- **Opencode Go provider**: Added Opencode Go as a built-in provider — a subscription service with a range of open-weight models (GLM, Kimi, DeepSeek, MiMo, MiniMax, Qwen). Add your token under Connections and its models appear like any other provider's, with their context lengths and input types fetched from models.dev. Some of its models use the OpenAI API format and others the Anthropic format; the correct one is used per model automatically. ([#8](https://github.com/o-stahl/osw-studio/issues/8))

## v1.79.0 - 2026-06-30

### Providers & models
- **Custom providers**: Add any OpenAI-compatible API endpoint as a provider — give it a name, the base URL, and an optional API token, and its models are discovered like any other provider's. Only external (public) endpoints are supported; a local or private address is rejected when you add it. Thanks to [@jasalt](https://github.com/jasalt) for the initial implementation ([#7](https://github.com/o-stahl/osw-studio/pull/7)).
- **Connection sync (Server Mode)**: Your provider connections now sync across devices, alongside skills, templates, and model templates. Only the connection definition — its name and endpoint — syncs; API keys stay on each device and are never sent to the server.
- **Hosted instances**: On managed/hosted instances, local providers (Ollama, LM Studio, llama.cpp) aren't offered, since a hosted instance has no local inference.

## v1.78.2 - 2026-06-28

### Fixes
- **Chat no longer stuck on "Select provider" after configuring a model**: The chat readiness check looked at the old global provider selection instead of the project's agent model, so a fully configured project (e.g. an OpenRouter model with a valid key) could leave the input disabled and the "Select provider" button glowing — most visibly on the HuggingFace Space, whose global default is HuggingFace. It now checks the project's actual agent provider.

## v1.78.1 - 2026-06-26

### Fixes
- **Server Mode: sync status no longer fails**: The sync-status endpoint returned a 500 (`no such column: updated_at`) because the `custom_templates` table predated template sync and never got the column. A migration adds it. This also clears the "Backend unreachable" banner that the failing request was triggering.
- **Settings menu "Provider & Model" no longer 404s**: In Server Mode the menu item pointed at a route that didn't exist; it now opens the settings page on the correct tab.
- **Legacy `/admin/*` redirects keep query parameters**: Redirecting an old `/admin/{view}` path to its `/w/{workspace}/{view}` equivalent dropped the query string, so deep links (like a specific settings tab) lost their target. The redirect now preserves it.
- **Model picker no longer gets stuck on "Loading…"**: Opening the per-project picker before the model migration had run could leave it stuck — with no way to dismiss it on mobile. It now runs the migration on open, and the mobile dialog always has a close button.
- **Model button opens Connections when no provider is set up**: With nothing connected the picker had nothing to show; it now opens the Connections tab directly so you can add a provider.
- **Providers no longer appear connected without auth**: A cloud provider (e.g. HuggingFace) whose public model list had been cached could show as "connected" with no key. Connection status now requires an actual key or token for cloud providers; cached models only count for local providers.

## v1.78.0 - 2026-06-26

### Providers & models

- **Per-project model setup**: Each project now picks its own models instead of relying on one global provider and model. A required agent model handles all generation, replacing the previous separate Chat and Code model selections (the Chat/Code/Interview mode toggle stays, as a behaviour, independent of the model). An optional voice-input slot layers on top.
- **Templates**: Save a model setup as a named template and reuse it across projects. A project selects a template and can override any individual slot; saving promotes those overrides back into the template. Your existing provider and model selection is migrated into a "Default" template on first load, so projects you have not configured keep working unchanged.
- **Recommended templates**: Both of the most used providers, OpenRouter and HuggingFace each come with a built-in "Recommended" template as a starting point. Built-ins are read-only and are updated over time as better models appear.
- **Connections**: API keys and endpoints are now managed as named connections, separately from models, with add and edit forms grouped by provider type. Each connection has a menu to edit, revalidate (re-fetch its model list), or disconnect.
- **Providers & models settings view**: A reworked settings area with three sections: Models (agent model, modality slots, compaction, reasoning), Connections, and Templates.
- **Per-project picker in the workspace**: The model button in the chat footer opens a picker to change the current project's template and per-slot models without leaving the editor. Changes apply to that project only.
- **Template sync (Server Mode)**: Your custom model templates now sync between devices, alongside skills and project templates. API keys stay on each device and are never synced.

### Voice input

- **Record from the chat input**: When a project has a voice-input model set, a mic button appears on the composer. Recording shows a live waveform, and the clip is held as context on the message until you send.
- **Three ways a clip is handled**: Reuse the agent model and the recording is sent to the agent as audio (for agent models that accept audio input). Choose a separate transcription model and the clip is transcribed when you send, with the text added to the message. Choose browser / on-device and it transcribes locally using the browser's own speech recognition, with no provider or key.
- **Recordings as context**: A clip appears in the message's context area with a player, the same way images and other attachments do. A voice-only message opens that context expanded; a message that also has typed or transcribed text keeps it collapsed.

### Image generation

- **Generate images**: Set an image-generation model for a project (any image-capable model on OpenRouter), and the AI can generate images from a text prompt as it builds. Generated images are saved into the project under `/.generated/` by default, which is excluded from the published build; the AI can save to a served path instead, and control aspect ratio and resolution.

### Chat input

- **Attachment menu**: A "+" button on the composer attaches an image or a text file. Text files are sent as context on any model. The image option is disabled when the selected model does not accept image input, and the input's modality indicators now reflect the project's agent model rather than a global selection.

### File explorer

- **Hidden files shown by default**: The file tree now lists dot-prefixed files and folders (`.skills/`, `.server/`, `.generated/`, `.PROMPT.md`) by default. The toggle to hide them again is unchanged.

### Fixes

- **Internal reminders hidden from chat again**: Harness-injected reminders and retry nudges, sent to the model when it stops without acting or calls a tool incorrectly, were sometimes rendered in the transcript as user messages. They are now kept out of the conversation view.

## v1.77.0 - 2026-06-14

### Interview Mode

- **Interview mode**: A new workspace mode alongside Code and Chat. An AI agent conducts a structured, conversational interview from a template — asking one question at a time, reading the project to verify answers where relevant, and recording what it learns as a Markdown artifact under `/.interviews/`. Four templates ship built in: "Understand a company", "Plan a website", "Plan a feature", and "Get ready to publish".
- **Template picker**: Switching to Interview mode replaces the message box with a searchable list of templates; pick one to begin. The active interview's name appears in the chat header, and clearing the chat returns you to the picker.
- **Completion check**: An interview only wraps up once its required items are actually recorded in the artifact. When the agent goes to finish, each required item is verified in a single pass — anything missing is sent back to the agent and surfaced in the chat so it gets captured first. When everything's covered, a clear "interview complete" marker is shown, prompting you to clear the chat to start a new one.
- **Handoff**: A completed interview offers a one-click follow-up — e.g. "Build a site from this" or "Implement this plan" — that switches to Code mode and starts the work from the recorded artifact.
- **Read-broad, write-narrow**: The interview agent can read anywhere in the project but only writes within `/.interviews/`, so an interview never touches your code.

### Fixes

- **Duplicate messages in chat**: Assistant replies could render twice in the transcript. Now shown once.
- **Relative paths in the shell**: Shell commands like `find .` now resolve `.` and `./` to the project root, instead of a non-existent path that silently returned nothing.
- **Chained `status --complete` now ends the task**: Ending a task with a chained command like `build && status --complete` now registers completion. Previously it could leave the AI re-running status and appearing to "complete" several times.
- **No "Task completed" toast on pause**: Pausing for your input — an interview question or `ask` chips — no longer shows a completion toast or plays the done sound.

### Desktop

- **Boot reliability**: Desktop workspace initialization no longer invokes bcrypt for the synthetic local accounts (admin/desktop) that never sign in by password — avoiding a class of startup failure when bcrypt's native addon fails to load under the packaged runtime.
- **Boot-failure diagnostics**: When the app can't initialize its workspace, the diagnostic screen now shows the underlying error and stack trace instead of a generic message, so failures are reportable.
- **Release self-test**: Desktop releases now boot the real packaged binary headlessly (on Fedora, under Electron's own runtime) and assert workspace initialization before publishing — exercising the native-module and filesystem paths a system-Node smoke test can't.

## v1.76.1 - 2026-06-13

### Desktop

- **Recovery from lost or stale workspace state**: Desktop startup now always validates the workspace instead of trusting a remembered reference — if the database was lost (e.g. during an update on older versions), the app re-initializes cleanly instead of getting stuck on a dead workspace. Legacy data stored inside the installation directory by versions ≤1.75 is migrated to the user-data directory when still present.

## v1.76.0 - 2026-06-13

### Desktop

- **Fixed desktop app failing to start on Linux and Windows**: The server wrote its databases relative to the installation directory, which is read-only for AppImage and Program Files installs — workspace initialization failed silently and the app sat on "Loading..." forever (macOS was unaffected because app bundles happen to be user-writable). All data now goes to the platform user-data directory, a workspace initialization failure shows the actual error with a link to report it, and the release pipeline's smoke test now asserts the data location and bootstrap so this class of bug cannot ship again.
- **User-controlled updates**: The desktop app no longer installs updates silently. It notifies you when a new version is available and only downloads and installs after you choose to — with a "Skip this version" option. macOS (where in-place updates require code signing) now gets update notifications too, linking to the releases page.
- **Failure diagnostics instead of a blank window**: If the app fails to start or load, it shows a diagnostic page with the version, the error, a link to reinstall from the releases page, and the log file location — instead of loading forever.
- **Help menu**: Check for Updates, Open Releases Page, Report an Issue, and Open Logs Folder.
- **Atomic desktop releases**: Desktop releases are now published only after all three platforms build successfully and the complete artifact set is verified — a failed platform build means no release, so auto-updaters can never see a partial or broken release. Release notes are generated automatically, and a boot smoke test runs before any packaging.
- **Single-source desktop shell**: The Electron shell now lives in the repository (`desktop/`), used identically by CI and local builds. Previously divergent copies could have caused desktop builds to behave differently from web releases.

## v1.75.0 - 2026-06-12

### Projects & Templates

- **Blank-canvas starters**: All starter templates now open as an empty page — bare `header`/`main`/`footer` scaffolding on a dark canvas with a subtle OSW watermark — instead of placeholder welcome content the AI had to clear out first.
- **Guaranteed rollback point**: Opening a project that has no saved checkpoint automatically creates a "Project opened" checkpoint, so there is always a state to restore to.

### Fixes

- **Fixed runtime change failing after hot reload**: The `runtime` shell command could fail right after a dev-server hot reload invalidated its lazily loaded module. The import is now retried automatically.
- **Fixed broken ESLint setup**: `eslint-config-next` v16 was installed against Next 15, crashing `npm run lint` since it was added. Pinned to the matching major and fixed all lint errors it surfaced.

### Debugging

- **Messages tab in the Debug Events panel**: Inspect the exact message history sent to the provider. A session-only "Capture requests" toggle (off by default) records the outgoing history of each LLM request; a "Provider view" toggle shows the precise shape after reasoning-replay and tool-argument processing. Captures update once per request — never per streamed token — and are independent of the Stream debug toggle. Local generations only.
- **Debug panel layout**: Event and message counts moved into the tab labels, and each tab gained expand/collapse-all, copy, and clear actions (Events also keeps export-to-file). The panel header is no longer crowded.

### AI Context Fixes

- **Fixed project file tree omitting subdirectories**: The project structure shown to the AI listed only root-level files — everything inside subdirectories (`/styles`, `/scripts`, `/templates`, …) was silently dropped. The AI worked blind to existing files and could needlessly recreate or collide with them.
- **`curl` no longer returns preview instrumentation**: The shell `curl` command now strips all preview-only scripts from fetched pages, so page inspections no longer feed the AI OSW Studio's own injected code.
- **Harness messages are tagged**: Loop-injected user messages (status nudge, retry prompts, runtime-error reports) are wrapped in `<automated_reminder>` tags so the model — and anyone reading an exported history — can distinguish them from genuine user input. They are still sent with the user role, which models weight more reliably than system messages deep into a conversation.
- **Token savings**: The `status` command no longer echoes the full task/done text back as its result. Large tool outputs that byte-for-byte repeat an earlier result still in context (e.g. re-reading an unchanged skill file) are replaced with a short marker. The system prompt now instructs the model to separate multi-file reads with echo markers so concatenated outputs can't be misparsed as one file.

### AI Orchestration Fixes

- **Truthful task results**: Generation results now reflect the actual loop outcome. Runs that hit max iterations, loop detection, or nudge exhaustion report failure with the real reason instead of "Task completed". Stopping a task no longer shows a success toast or fires duplicate telemetry.
- **Conversation repair on send**: Orphaned tool calls (e.g. from stopping mid-execution) are repaired before every provider request. Previously a conversation with an unanswered tool call was permanently rejected by strict providers (OpenAI, Anthropic) with no recovery.
- **Sub-agent event isolation**: Child agents' streaming text and tool calls no longer leak into the main chat transcript as if the orchestrator produced them — output stayed garbled when agents ran in parallel. The subagent status line now shows the running command and real elapsed time.
- **Stop works after pause/resume**: Resuming from an API-error pause no longer disconnects the stop button from in-flight tool execution.
- **Compaction correctness**:
  - The compaction check uses the loop's own context size; previously sub-agent runs could delay needed compaction until the context overflowed.
  - Compaction now survives project switches and reloads; previously the full pre-compaction history was silently restored without the summary.
  - Follow-up compactions chain from the previous summary instead of starting over.
  - The post-compaction rebuild uses a freshly built system prompt and file tree instead of the stale pre-compaction system message.
  - In-flight compaction requests are aborted on stop.
- **Loop detection preserves work**: When duplicate/pattern detection terminates a run, already-executed tool results are committed to the conversation. Previously they were discarded, leaving file changes the model had no record of.
- **Agent dedup scoped to turn**: Duplicate agent-command suppression only applies within the same turn. Identical re-delegation in a later turn runs again, and a failed batch no longer answers retries with a false "already executed".
- **System message consolidation**: All system messages in a request are merged into a single message at position 0. Some providers reject system messages at any other position in the conversation.
- **Server Mode parity**: Server-generated tasks report `failed` with the failure reason when the loop ends unsuccessfully, and compaction events reach the client.
- **Reasoning blocks now close**: Models that stream reasoning via the provider's reasoning field (Qwen, DeepSeek via OpenRouter) left the reasoning indicator spinning forever when the stream ended on reasoning.
- **Reasoning-only responses handled**: When a model thinks but never emits a tool call or text (seen with Qwen 3.6 via OpenRouter), the loop now keeps the reasoning in conversation history and asks the model directly to act via function calling, instead of dropping the turn and sending the unrelated status nudge. Previously the model restarted identical reasoning every iteration until the run failed.
- **Per-model reasoning replay**: Prior-turn reasoning is passed back only to model families whose APIs require it (DeepSeek, GLM, MiniMax) and stripped for everything else — Qwen3's template forbids replayed thinking, and sending it back broke tool calling on every turn after the first. Reasoning-only turns are promoted to plain assistant text at the provider boundary so the model still sees its own prior thinking; in the chat they remain reasoning blocks. Final text answers also keep their reasoning details for replay-required providers.

## v1.74.0 - 2026-06-07

### Server Mode

- **Transparent sync**: Project syncing is now fully automatic and invisible. Projects load instantly from local storage while server updates are fetched in the background. The "Workspace Setup Required", "Server Database Not Initialized", and "Sync Your Projects" modals have been removed — auto-pull on load and auto-push on save handle everything.
- **Immediate conflict notifications**: When a project is edited on another device, a persistent notification appears immediately with clear language and a path to resolution via Server Sync.
- **Faster sync status**: The sync status endpoint uses lightweight SQL queries instead of loading full objects. Disk usage is cached. Concurrent callers share a single request. First-load sync pulls up to 4 projects in parallel.

### UI

- **Input modality indicators**: Icon tabs above the chat input show which input types the current model supports (text, image). Capability data is discovered from provider APIs — OpenRouter, Anthropic, HuggingFace, Gemini, and LM Studio all report real modality data. Providers without discovery default to text-only.

## v1.73.2 - 2026-06-06

### AI & Editing

- **Improved `ss` edit reliability**: Changed the search/replace separator from `===` to `=======` to avoid collisions with JavaScript code. Entity mode (`ss --entity`) no longer requires a separator — provide the full replacement and the old entity is auto-detected.
- **Fixed `sed` with JS content**: Curly braces and commas in quoted sed expressions are no longer mangled by brace expansion. Backreferences (`\1`, `\2`, `&`) now work correctly in replacements.
- **Fixed shell argument parsing**: Backslashes in double-quoted arguments are preserved correctly, and empty quoted arguments (`""`, `''`) are no longer silently dropped.

## v1.73.1 - 2026-06-06

### Bug Fixes

- **Fixed negative token counts on multi-turn completions**: Token and cost displays now track per-task values directly. Switching projects or resuming a session no longer produces negative or incorrect token counts.
- **Fixed project cost toggling in Server Mode**: The project cost display no longer alternates between correct and inflated values during AI generation.
- **Fixed cross-workspace database errors**: Idle workspace cleanup no longer breaks active workspaces. Database connections recover automatically if interrupted.
- **Fixed workspace setup loop in hosted mode**: New users on hosted instances no longer get stuck in a "Workspace Setup Required" re-login loop. Workspace owners can now complete setup without admin privileges.

## v1.73.0 - 2026-06-04

### Deployment Subdomains

- **Auto-generated subdomain slugs**: Publishing a deployment auto-assigns a memorable 3-word slug (e.g., `sunny-oak-river`). The deployment is accessible at `{slug}.{instance-domain}` as well as the direct `/deployments/{id}/` path.
- **Subdomain URL in deployment card**: The card shows the subdomain URL immediately after publishing. Deployment settings show both the subdomain and direct path.
- **Root-relative asset paths for subdomains**: Deployments served via subdomain or custom domain use root-relative paths, so assets load correctly at the domain root.

### Server Mode

- **Static proxy mode (`STATIC_PROXY`)**: Set `STATIC_PROXY=true` to disable Node.js deployment route handlers when a reverse proxy (e.g., Caddy) serves static files directly. Route handlers remain the default for bare `npm start` setups.
- **Caddy config auto-regeneration**: When static proxy mode is enabled, publishing or deleting a deployment regenerates the proxy config and reloads it automatically.
- **Global error page**: Server-side render failures show a friendly error page with retry and navigation options instead of the raw framework error.
- **Fixed deployment quota enforcement**: Quota now counts actual deployments from the workspace database instead of routing table entries that could be stale.

### AI & Preview

- **Fixed Svelte and Vue multi-file compilation**: The preprocessor was stripping component imports from `.svelte` and `.vue` script blocks. Multi-file SFC projects now compile correctly.
- **Fixed preview white screen on workspace entry**: All compile paths now wait for workspace initialization before running, preventing blank previews from stale or missing files.
- **Fixed stale bundle blocking recompilation**: A `bundle.js` from a previous compile or checkpoint no longer prevents the bundler from running when source files are present.
- **Fixed checkpoints capturing build artifacts**: Generated files like `bundle.js` are excluded from checkpoints and restore handles missing files gracefully.
- **Sanitized malformed tool call arguments**: Truncated streaming can leave invalid JSON in conversation history. These are now repaired before sending to providers.

## v1.72.3 - 2026-06-02

- **Fixed custom_domain migration on existing databases**: SQLite's `ALTER TABLE ADD COLUMN` doesn't support `UNIQUE`. Now adds the column without the constraint and enforces uniqueness via a unique index.

## v1.72.2 - 2026-06-02

- **Fixed custom_domain migration index ordering**: The index creation ran before the column migration, crashing on startup for existing instances.

## v1.72.1 - 2026-06-02

- **Fixed deployment quota counting stale entries**: Quota enforcement was counting entries in the routing table instead of actual deployments, blocking publishing even with 0 deployments. Now counts from the workspace database.
- **Global error page**: Server-side render failures now show a friendly error page with retry and gateway navigation instead of the raw Next.js error.

## v1.72.0 - 2026-06-02

### Deployments

- **Static deployment serving**: Published deployments are now served as true static files instead of going through Node.js route handlers per request. Reduces CPU usage and improves throughput for high-traffic sites.
- **Custom domain routing**: A domain resolution API (`/api/resolve-domain`) enables reverse proxies to route custom domains to the correct deployment. With a compatible proxy (e.g., Caddy with on-demand TLS), custom domains work with just a DNS A record. Domains are registered in the system routing table during publish.

### Preview

- **Fixed white screen on workspace entry**: The preview compiled before checkpoint files were restored, rendering a blank page. All compile paths now wait for workspace initialization to complete.
- **Fixed Svelte and Vue multi-file component imports**: Component imports in `.svelte` and `.vue` files were silently stripped during preprocessing, causing "not defined" errors at runtime. Multi-file SFC projects now compile correctly.
- **Fixed stale bundle blocking recompilation**: A `bundle.js` left over from a previous compile or checkpoint restore could prevent the bundler from running. Source files now always take priority over pre-built bundles.

### Checkpoints

- **Fixed checkpoints capturing build artifacts**: Generated files like `bundle.js` and `bundle.css` were included in checkpoints, causing restore errors. Checkpoints now skip generated files.

### Chat Panel

- **Fixed tool call error status**: Failed tool calls displayed a green checkmark instead of a red error icon. Status is now derived correctly in both live sessions and conversation replay.
- **Fixed read commands mislabeled as writes**: Commands like `cat /file 2>/dev/null` were classified as writes due to the stderr redirect. Classification now correctly identifies stdout redirects only.
- **Fixed "Send" button on runtime errors**: Clicking "Send" dismissed errors without sending them to the AI. Now reads from the displayed errors rather than the live buffer.

## v1.71.0 - 2026-05-31

### Checkpoints

- **Server generation checkpoints**: Server-mode generation now creates pre- and post-generation checkpoints, enabling rollback and retry. The pre-generation snapshot persists across browser sessions.
- **Fixed checkpoint ID collisions**: Rapid checkpoint creation no longer produces duplicate IDs.
- **Fixed server task recovery after tab close**: Returning to a server-mode task that completed while the tab was closed no longer hangs on "Waiting for response...". The client detects completed tasks, replays buffered events, and pulls the changed files.

### Server Mode

- **Standalone mode cleanup**: Users page, Workspace Switcher, and quota enforcement are now hidden in standalone server mode. These features only apply in managed deployments.
- **Fixed re-publish blocked by own quota**: Re-publishing an already-published deployment no longer counts against the deployment quota.

### Chat Panel

- **Fixed SSE event replay**: Returning to a project after SSE disconnection now reconstructs the full conversation from buffered events, including tool calls, reasoning, and results.
- **Fixed background project cost bleed**: Usage events from background projects no longer overwrite the viewed project's cost display.
- **Fixed tool status on replay**: Tools no longer get stuck in 'executing' state when replaying buffered events.

### Generation Shelf

- **Fixed shelf not dismissing after visiting project**: Visiting a completed project now permanently dismisses its shelf entry.
- **Fixed premature shelf auto-dismiss**: Background tasks that complete while the user is on the project list now correctly show "Done" in the shelf instead of disappearing instantly.

## v1.70.0 - 2026-05-27

### AI Orchestration

- **Tool rename: shell → bash**: Renamed the LLM tool from `shell({ cmd })` to `bash({ command })`. Benchmark experimentation showed that models produce significantly better tool calls with `bash`. `shell` still accepted as a backward-compatible alias.
- **Sub-agent rename: delegate → agent**: Renamed the sub-agent command from `delegate` to `agent explore|task|plan`, applying the same principle. `delegate` still accepted as a backward-compatible alias.
- **Fixed duplicate sub-agent spawning**: Models that emit the same agent command as multiple tool calls in one turn no longer run identical sub-agents twice. Consecutive calls with the same prompt set are deduplicated.
- **Fixed sub-agent prompt parser**: Commands like `agent task "A" "B"` no longer spawn 3 sub-agents instead of 2. The parser was doubling the last prompt when the closing quote was the final character.
- **sed/ss substitution feedback**: `sed -i` reports substitution count on success and a diagnostic on zero matches. `ss` reports replacement confirmation. Previously both returned silent success, giving models no signal when an edit didn't apply.

### Benchmark

- **`any_of` assertion type**: Composite assertion that passes if any sub-assertion matches (OR logic). Used for setup tests where models can achieve the same goal through different approaches (e.g. tool command vs prose question).
- **Test progress counter**: Total Tests card shows `completed / expected` while tests are running, replacing the static total that only updated on completion.
- **Errors export**: Export failed tests, failed tool calls, and failed assertions as a markdown report. Shows total error count across all categories, available even when all tests pass overall.
- **Improved assertion accuracy**: Assertions are more model-agnostic — tests accept any tool that achieves the result rather than asserting specific commands, patterns match valid alternatives (URL paths in sitemaps, different grep/find variants), and sub-agent tests accept both `agent` and `delegate` names.
- **Fixed duplicate tool call display**: Each tool call was rendered twice in benchmark output. Removed redundant event emissions from the agent loop.
- **Fixed sequence tool count**: Each sequence step now counts only its own tool calls instead of accumulating from all prior steps, which inflated reported counts.

### VFS Shell

- **grep `-o` flag**: Output only the matched parts of each line, one match per output line. Useful for extracting specific patterns like URLs or attribute values from files.
- **grep `-P` flag**: Accepted as a no-op for PCRE compatibility. The JS regex engine already covers most Perl-compatible patterns that models use.
- **sed `!` negate modifier**: Inverts address matching — e.g. `/pattern/!d` deletes lines that do NOT match the pattern. Works with all address-based commands (delete, print, change, insert, append) and within groups.
- **sed `{...}` command grouping**: Apply multiple sub-commands within an address range — e.g. `/<section>/,/<\/section>/{/<\/section>/!d}` deletes all lines in a range except the closing tag. Sub-commands can have their own addresses and negate modifiers.

## v1.69.0 - 2026-05-25

### AI Orchestration

- **Orchestrator modularization**: Extracted the agent loop into a portable core layer with typed interfaces (`AgentLoop`, `ContextManager`, `ProviderAdapter`, `ToolExecutor`, `CostTracker`), enabling future agent improvements. The orchestrator is now a thin facade wiring OSWS-specific dependencies to the portable core. Public API unchanged.
- **Fixed context compaction**: Compaction is now enabled by default and fires at 60% of the model's context length. Fixed threshold double-application, token tracking semantics, missing usage fallback, compaction responses leaking into the chat stream, and compacted history not persisting across messages. Compaction cost is included in the session total.
- **Improved compaction prompt**: Rewrote the summarization prompt with structured sections (Task, Accomplished, Files, Current State, Remaining). Iterative compactions build on previous summaries instead of re-summarizing from scratch.
- **Fixed reasoning multi-turn replay**: Reasoning content from thinking models (DeepSeek, Gemini, etc.) no longer degrades across conversation turns. The streaming parser merges fragmented reasoning entries and converts to the format each provider expects on replay.
- **System prompt conciseness**: Added directives for shorter prose, action-bias, and self-correction limits to reduce overthinking and repetitive analysis.

### UI

- **Compaction indicator**: Shows a dashed divider with pre/post token counts when compaction occurs during a session.
- **Compaction settings**: Updated descriptions to reflect the 60% threshold and clarified that manual limits are used as-is.

## v1.68.0 - 2026-05-23

### Benchmark

- **Test sequences**: Multiple test steps run on a single orchestrator/project, reducing redundant system prompt cost and setup overhead. 12 sequences with ~51 steps replace 62 standalone tests. Grouped row UI with expandable step details and per-step generation output.
- **Parallel test execution**: Tests run concurrently with a configurable concurrency limit (1–8, default 3).
- **Per-component context breakdown**: Each API call records char counts for system prompt, user messages, assistant text, tool call args, tool results, and reasoning. Exported as per-test tables in benchmark reports.
- **Shell command breakdown**: Export includes per-command usage counts (cat, rg, ss, grep, etc.) across all tests.
- **Reasoning display**: Reasoning/thinking deltas appear in generation output as `[thinking]` blocks with middle-out truncation (300 char cap).
- **Benchmark info panel**: Collapsible info section replaces static banners. Four-line summary visible by default; expandable details on how the benchmark works.
- **Benchmark version label**: Header shows version identifier for tracking configuration changes across runs.
- **Setup agent improvements**: Setup prompt prefers proposing project creation over asking clarifying questions. Agent-type-aware error messages for hallucinated tool calls.
- **Fixed sequence token double-counting**: Steps were adding cumulative totals instead of per-step deltas, inflating reported tokens by ~2x.
- **Fixed export double-counting**: Markdown/JSON export summed both sequence headers and step rows, producing ~2x the real cost.

### Cost Tracking

- **Accurate provider costs**: Reads actual cost from OpenRouter responses (`json.usage.cost` and `x-openrouter-cost` header) instead of computing from static pricing tables. Previously unknown models used a $1/$2-per-million fallback — off by 3–4x for cheap models. Unknown models now report $0 instead of fabricated estimates. Also extracts `cached_tokens` from `prompt_tokens_details` for accurate cache hit reporting.

### AI Orchestration

- **Chained heredoc error reporting**: When multiple heredoc writes are chained and a later one fails, the output reports how many commands succeeded before the error. Also detects heredoc parsing failures (`<<` as file path) and returns actionable guidance.
- **Fixed streaming parser losing tool call arguments**: When a provider omitted `tc.index` on subsequent tool call chunks, argument fragments were routed to an orphaned buffer and silently lost. The parser now tracks the last indexed tool call as fallback.

### UI

- **Reasoning preview**: Joins lines with spaces for a meaningful summary instead of showing just the first word of a reasoning block.

## v1.67.1 - 2026-05-19

### Performance

- **Incremental delta processing**: EventProcessor now tracks fragment counts and only processes new fragments per animation frame, replacing the previous approach of re-concatenating and re-parsing the entire accumulated buffer on every frame. Eliminates O(N²) cumulative work during long streaming responses.
- **Skip redundant JSON.parse during streaming**: Tool parameter deltas no longer attempt JSON.parse on incomplete JSON every frame. The command preview is extracted once via regex and cached; full parsing deferred to tool execution start where it already existed.

### Fixes

- **Generation shelf on foreground tasks**: Completed tasks are now removed from the generation task map when the user is viewing the project, preventing the shelf from showing stale "done" cards after navigating away and back.

## v1.67.0 - 2026-05-18

### Server-Side Generation (Server Mode)

- **Detach-to-server**: When a user closes their browser tab during an active generation in Server Mode, the task continues running on the server backend. On tab reopen, the client reconnects via SSE and receives buffered events — conversation, tool calls, and file changes resume seamlessly.
- **Incremental file sync**: File changes from server-side generation sync back to the client (IndexedDB) after each tool call via `files_changed` SSE events, rather than waiting for the entire task to complete.
- **Soft stop**: Clicking stop during server-side generation cancels only the current LLM inference. The task transitions through a `stopping` state and emits a `stopped` result, preserving all work completed up to that point.
- **Client reconnection**: On page load, the client checks for any running server tasks and reattaches to their SSE streams. Buffered events are replayed so no progress is lost.
- **Build delegation**: Bundled runtimes (React, Svelte, Vue, etc.) defer their build step to the client — the server emits a `build_requested` event and the client runs the compilation locally on reattach.
- **Middleware auth gate**: All `/api/server-generate/*` routes are now auth-protected via middleware, blocking unauthenticated access and Browser Mode requests.

### AI Orchestration

- **Server-safe tool execution**: Python and Lua shell commands return a descriptive error on the server instead of hanging indefinitely waiting for a browser-only runtime (Pyodide/Fengari).
- **Tool abort on stop**: All tool executions now race against the abort signal, so stopping a task interrupts stuck tools immediately instead of waiting for them to complete.

### UI

- **Task completion sound**: A two-note chime plays when a generation completes in the background (hidden tab or generation shelf). A subtle single-note ping plays for in-focus completions.

### Performance

- **Delta event batching**: Assistant text, tool parameter, and reasoning delta events are coalesced in a `requestAnimationFrame` buffer and flushed once per frame, eliminating O(n²) Zustand state updates during large streaming responses.
- **Smarter auto-sync**: The project gallery no longer pulls every project from the server on each navigation. A lightweight timestamp comparison runs once per browser tab; only projects where the server is actually newer get fetched.

### Fixes

- **Generation shelf on reattach**: The shelf now appears on any workspace page (including the projects page) when a server task is running, not only when viewing the project. Task metadata (name, prompt, model) is preserved across tab reloads.
- **Chat history on reconnect**: Reopening a tab during server-side generation now replays the full event buffer, restoring the complete conversation including project context.
- **Binary file content in file sync**: The `/api/server-generate/files` endpoint now correctly extracts file content from VirtualFile objects instead of returning the raw wrapper.
- **HMR singleton safety**: TaskManager and SSEEventBus use `globalThis` singletons to prevent webpack hot-reload from creating duplicate instances during development.
- **Login form loading state**: The admin login page now clears its loading spinner on authentication failure.
- **Cost tracking init**: Projects with partial cost tracking data (missing `providerBreakdown`) no longer throw on update — existing fields are preserved during re-initialization.
- **Skills service on server**: SkillsService guards against missing `localStorage` so it can initialize during server-side generation without throwing.
- **VFS context isolation**: Shell commands and skills use `getActiveVFS()` which returns the per-task server VFS (via `AsyncLocalStorage`) or the browser singleton, preventing cross-task file system access.
- **Project deletion in Server Mode**: Deleting a project now removes it from the server — previously, deleted projects reappeared on page refresh because the server copy was never cleaned up.
- **Deployment quota on delete**: Deleting a deployment now frees the deployment quota slot. Previously, the routing entry was retained and deleted deployments still counted against the workspace limit.
- **Project creation quota**: Project creation now checks the workspace project limit before proceeding. Previously, the limit was only enforced during sync push, so projects could be created locally with no feedback that the quota was exceeded.

## v1.66.0 - 2026-05-16

### Multi-Generation

- **Concurrent project generation**: Multiple projects can now generate simultaneously. Start a task on one project, navigate to another, and start a second task — each runs independently with its own orchestrator instance.
- **Generation shelf upgrade**: The shelf now shows all background tasks with per-card stop, dismiss, and navigation controls.
- **Paused task visibility**: When a background generation hits an API error (e.g. upstream timeout), the shelf turns yellow with "Paused — needs attention" and shows Continue/Cancel buttons directly — no need to navigate back to the project.

### Fixes

- **Chat history lost on navigation**: Leaving a generating project and returning now correctly preserves the full conversation and shelf activity.

## v1.65.0 - 2026-05-14

### AI Generation Survives Navigation

- **Background generation**: Starting a task and navigating to the project gallery no longer kills the generation. The orchestrator continues running and the full conversation — including checkpoints — is intact when you return.
- **Generation shelf**: A floating indicator appears in the bottom-right corner when you navigate away from an active task. Shows the project name, prompt, elapsed time, model, and live activity. Click to jump back to the project.

### Checkpoints

- **Pinned checkpoints**: Pin any checkpoint to prevent it from being pruned. Pinned checkpoints survive indefinitely as full project snapshots — useful for bookmarking a known-good state before experimenting.
- **Per-project pruning**: Each project keeps its 5 most recent unpinned checkpoints. Older ones are automatically deleted when new checkpoints are created.
- **Reliable loading on project entry**: Checkpoints now load correctly on first workspace mount regardless of which project was viewed previously.

### Internal

- **Zustand state management**: Workspace state migrated from 40+ React `useState` calls to a zustand store with three slices (orchestrator, project, layout). Enables generation survival and future SharedWorker execution.

## v1.64.0 - 2026-05-13

### Server Mode

- **Auto-pull fix**: Projects on the server were never pulled to new devices because the VFS lookup threw on missing projects instead of returning null, causing every pull attempt to silently fail.
- **Workspace ID race condition**: Auto-sync API calls could fire before the workspace ID was set, hitting unscoped endpoints that returned 404. The workspace ID is now set explicitly before any sync operation.
- **Sync dialog suppressed in workspace mode**: The manual "Sync Your Projects" dialog no longer appears when auto-pull handles the sync automatically. Non-workspace server mode setups still show it.
- **Pulled projects no longer marked dirty**: Pulling files from the server triggered the save-dirty tracker, making every synced project appear as needing a save immediately on open. File operations during pull are now suppressed from dirty tracking.

### UI

- **Deployment selector cleanup**: Removed the standalone database icon and "Disconnect deployment" button from the workspace header. The deployment dropdown now shows a plain select with "No deployment" as the default.

### Fixes

- **Runtime switch ignored**: Changing a project's runtime in Project Settings (e.g. React → Static) visually reverted immediately because the workspace didn't update its local runtime state after the settings modal saved.

### Mobile UX

- **Bottom bar overflow menu**: Mobile bottom bar now shows Chat, Files, Preview, and a three-dot overflow menu. Overflow contains Editor, Checkpoints, Console, Skills, and Debug panels with labeled entries.
- **Panel headers slimmed on mobile**: Panel headers hide the title, icon, close button, and drag handle on mobile. Only action buttons remain, rendered as pill-shaped buttons with labels (e.g. "Clear chat", "Upload", "Add skill").
- **Panels edge-to-edge on mobile**: Removed border, border-radius, padding, and shadow from mobile panel wrappers so panels fill the viewport.
- **Project name in header**: Mobile workspace header shows the project name left-aligned with the active panel name as a subtitle below it.

## v1.63.0 - 2026-05-08

### Server Mode

- **Auto-sync on project creation**: New projects are pushed to the server immediately after creation, so they appear on other devices without manual sync.
- **Cross-device sync on load**: Opening the project gallery pulls server-side changes before displaying projects. Only projects with newer server timestamps are fetched.
- **Per-project freshness check**: Opening a project in the editor checks the server for updates and pulls if newer.
- **Optimistic concurrency on push**: Server rejects pushes when another device has made changes since the last sync. Conflicts are surfaced instead of silently overwriting.
- **Checkpoint safety net**: A checkpoint is created before pulling server changes, so local work can be recovered if a pull overwrites in-progress edits.
- **Workspace switcher removed from editor**: Workspace switching is handled at the account level.

### Fixes

- **Publish failure in server mode**: Publishing a deployment could fail with a database error ("SQLiteAdapter not initialized") when the build process closed a shared database connection mid-request. Adapter lifecycle is now handled correctly.
- **Project ID mismatch on pull**: Pulling new projects from the server generated random local IDs instead of preserving the server's ID, breaking subsequent sync round-trips.

## v1.62.0 - 2026-05-05

### Built-in Skills

- **Frontend design skill expansion**: Sub-skill catalog grew from 4 to 12 aesthetic directions — added `brutalist`, `retro-futuristic`, `art-deco`, `maximalist`, `playful`, `industrial`, `luxury`, and `terminal`. Wider taxonomy reduces convergence between generations and covers design spaces the previous four couldn't reach.
- **Sub-skills rewritten for variety**: Sub-skills now describe typography character, color logic, spatial principles, and motion intent rather than prescribing specific page sections. Outputs from the same sub-skill no longer look like siblings.

### Skill Groups

- **Skill groups for bulk enable/disable**: Skills can now be bundled into named groups that toggle together. Three built-in groups ship: `Frontend Design` (all 13 aesthetic skills), `Server Mode` (server, functions, database, secrets — disable for browser-only projects), and `Web Standards` (responsive, accessibility). Enabling a group activates all its members; disabling falls through to individual toggles.
- **Multi-membership**: A skill can belong to any number of groups; enabling any one of them makes the skill available.
- **Custom groups**: Create your own groups via the "New Group" dialog — pick a name, optional description, and select member skills. Edit and delete available on custom groups.
- **Skills view redesign**: The Skills view is now tabbed (Skills / Groups) with member-count badges. Groups are collapsed by default; expanding shows member skills with individual toggles. "Enable all" / "Disable all" bulk actions added to the Skills tab.

### Server Mode

- **Account link in sidebar**: In managed mode, the sidebar now shows an "Account" link that navigates back to the managing provider's account page.
- **Fixed stale workspace switcher path**: The "Switch workspace" link in the workspace header pointed to an outdated path.

## v1.61.1 - 2026-05-03

### Server Mode

- **Session redirect fix**: Auth redirects now use `NEXT_PUBLIC_APP_URL` instead of `request.url`, which resolves to `0.0.0.0` in Next.js standalone mode.
- **Admin-only sidebar items**: Users nav item hidden for non-admin users in the sidebar.
- **Database encryption support**: All database connections accept an optional `DB_ENCRYPTION_KEY` pragma for encrypted SQLite. No-op when unset.
- **API key IP allowlist**: Instance API key authentication can be restricted to specific source IPs via `GATEWAY_IPS` env var. Supports IPv4 and IPv6.
- **Deployment type telemetry**: Telemetry now distinguishes deployment types (browser, server, desktop, multi-instance) for usage analytics.

### Desktop

- **Fixed 404 on launch**: Desktop app showed a Next.js 404 after the workspace routing changes in v1.57.0. The app now bootstraps a default workspace on first launch and routes directly to it.

## v1.61.0 - 2026-05-01

### Multitenancy & Server Mode

- **Workspace-scoped browser storage**: Each workspace gets its own IndexedDB database. Projects, files, skills, and templates are isolated per workspace. API keys remain in localStorage (per-browser, not synced). Browser mode unchanged.
- **Session handoff**: External auth providers can establish authenticated sessions on an instance without knowing the user's password.
- **Webhook event system**: Instances can emit lifecycle events to an external URL with signed payloads. Opt-in — zero overhead when unconfigured.
- **External auth redirect**: When an external auth provider is configured, all login and session-expired flows redirect there.
- **Managed mode**: Instances can be configured for external user management, disabling local user creation and routing auth to the managing provider.
- **Legacy data migration**: Standalone instances automatically migrate existing data into workspace databases on first login. Managed instances start workspaces clean.

### UI

- **Discard Changes is now a split button**: Primary click still discards all changes since last save. The chevron opens the Checkpoints panel for browsing and restoring earlier points.
- **Dashboard for non-admin users**: The workspace dashboard shows project counts, storage usage, and recent projects from the workspace sync API instead of requiring admin access.
- **Sync prompt for empty workspaces**: When a workspace-scoped IndexedDB is empty but the server has projects, a "Sync Your Projects" dialog offers to open the sync panel.

### Bug Fixes

- **Preview reload storm on checkpoint restore**: Restoring a checkpoint with hundreds of files triggered dozens of preview recompiles. Now writes silently and dispatches a single event at the end.
- **Conversation deadlock after stopping a streaming tool call**: Interrupted tool calls left orphaned messages that blocked all subsequent turns. The wire payload now drops empty tool calls and synthesizes placeholder results.
- **Mid-stream upstream errors silently swallowed**: OpenRouter upstream errors delivered over 200 SSE connections are now surfaced in the error dialog instead of dropped.
- **Stale workspace cookies**: Workspace-scoped routing (shell commands, deployment schema, IndexedDB selection) now requires server mode to be active — stale cookies from previous server mode sessions no longer affect browser mode. Logout clears the workspace cookie alongside the session cookie. Middleware clears both on invalid/expired sessions before redirecting.

### Security

- **Open redirect in session handoff**: The redirect parameter now only accepts relative paths, preventing redirects to external domains.
- **Handoff workspace ID validated**: Workspace IDs extracted from redirect URLs are validated as UUIDs before being set in cookies.

### Developer Tools

- **Stream debug toggle in the Debug Events panel**: New checkbox next to "Auto-scroll". Emits `llm_request` and `stream_raw_chunk` events for inspecting outgoing payloads and raw SSE traffic. Off by default.

## v1.60.0 - 2026-04-26

### Describe Mode

- **Conversational project setup**: New "Plan the project first" option in the create-project dialog opens a chat with a setup agent. Describe what you want to build; the agent figures out the runtime, template, pages, and any backend capabilities through a short conversation. The project is scaffolded with full context, so the in-project agent doesn't ask the same questions again. Replaces the "AI Project Setup" template shortcut (removed).
- **Live brief sidebar**: Project brief updates in real time as the conversation progresses — name, type, pages, capabilities, direction, plus runtime and template under the hood. Collapsible spec preview shows accumulated context. The "Create now" button enables once the brief has the minimum it needs (name + runtime + template).
- **Tappable chip prompts**: When the agent asks closed-ended questions ("What aesthetic — bold, soft, editorial, minimal?"), it presents tappable options instead of free text. Selecting one sends it as the next message.
- **Creation confirmation**: When the brief is ready the agent proposes creation; the user reviews the brief and clicks "Create project" to confirm or "Not yet" to keep adjusting. Declining attaches a context note to the next message so the agent knows without re-asking.
- **Output files**: Projects from describe mode start with `.PROMPT.md` (terse brief appended to the runtime's domain prompt), `.DESIGN.md` (substantive context from the conversation), and `.DESIGN-CONVERSATION.md` (raw transcript with agent prose, ask prompts, and spec sections).
- **Stack defaults**: Defaults to Handlebars + vanilla HTML/CSS/JS for most websites. Frameworks only when the user names one or a feature requires one.

### AI Orchestration

- **`ask` shell command**: The in-project agent can now present tappable chip options to the user instead of asking in prose — useful when it hits a real either/or choice and wants a single decision before proceeding. `ask [--prompt "Question"] "Option A" "Option B" "Option C"`. The user's selection becomes the next message in the conversation.
- **Live reasoning preview**: The reasoning badge now shows the latest streamed thinking content while the model is still generating, instead of a static `Thinking...` label. Falls back to `Thinking...` only before any content arrives.

### UI

- **Backend status banner improvements**: Refresh button checks server reachability instead of the models API. Dismiss button on both banners. Improved messaging about sync impact and local data safety.
- **Hidden files bar in file explorer**: Bottom bar shows the count of hidden files and folders. Clicking toggles visibility. Tooltip explains that dot-prefixed items are excluded from deployments and ZIP exports but included in backups and templates.
- **Dot-prefix export exclusion**: Any root-level file or directory starting with `.` (e.g. `.PROMPT.md`, `.DESIGN.md`, `.skills/`) is excluded from deployments and ZIP exports, while still being included in backups and templates.
- **Unsaved changes guard**: Back button, logo click, Escape, and browser tab close prompt for confirmation when the AI is generating or there are unsaved changes. Applies to both the workspace and the create-project dialog.
- **Fullscreen preview preserves state**: Entering and exiting fullscreen no longer wipes the chat draft or reloads the preview iframe. Workspace panels stay mounted across the transition.
- **Folder drag-and-drop upload**: Dropping a folder into the file explorer recurses into it, preserving the folder structure and uploading all files inside. A persistent loading toast shows live progress (e.g. `Uploading 17/42 files · 3/3 folders`). Intermediate directories are auto-created. Unsupported files inside folders are silently skipped.
- **Single preview reload when deleting a directory**: Deleting a folder with many files now triggers one preview compile and one file-tree refresh at the end, instead of one per contained file — eliminates flicker on large deletions.
- **Pagination on list views**: Projects, Templates, and Deployments paginate at 24 per page; Skills at 30. Skills also unifies its previously separate Built-in and Custom sections into a single list with toggle chips to hide either group.

### Telemetry

- **New anonymous events**: `project_create` (method: quick/describe, runtime, template), `deployment_publish` (runtime, success/fail, has_custom_domain), `compaction_fired` (tokens before/after, provider/model), `image_attached` (source: drop/paste, count). All categorical — no file contents, prompts, names, or domain values. Disclosure dialog updated with matching bullets.

### Bug Fixes

- **Chained heredocs written to the wrong file**: When a single `shell` call contained multiple back-to-back heredocs (e.g. several `cat > /file << 'EOF' … EOF` blocks), the greedy heredoc regex matched the *last* `EOF` in the input, so the first file received everything in between as its body — including the literal `EOF` lines and the intermediate commands. Subsequent files were silently skipped. The shell executor now splits compound commands into individual statements before parsing each heredoc, so each `EOF` correctly terminates its own block.
- **sed misclassified many real file paths as expressions**: `sed -i 's/old/new/g' /styles/style.css` failed with `sed: unsupported command "style.css"` because the argument parser flagged any path whose basename began with d/p/c/i/a/n/s as a sed address-expression rather than a file. The classifier now requires the command letter to be at a valid terminator, so common paths like `/src/index.ts` and `/public/nav.svg` are correctly treated as files.
- **Empty assistant text bubble**: Reasoning models (e.g. Kimi K2.6) sometimes emit a whitespace-only assistant message between reasoning and the tool call. That rendered as an empty bordered bubble. The chat panel now skips text items whose accumulated content is just whitespace.
- **Spurious `/api/sync/status` 404s in dev**: The sync status dialog hook auto-fetched on mount, hitting a pre-multitenancy URL when no workspace was scoped yet. The fetch now runs only when the dialog opens.
- **Transient rate-limits misreported as "credit limit reached"**: When OpenRouter returned a 429 with a transient upstream rate-limit message (e.g. "deepseek/deepseek-v4-pro is temporarily rate-limited upstream. Please retry shortly"), the error classifier matched the substring "limit" inside "rate-limited" and reported "OpenRouter credit limit reached. Add credits…" — sending users to the wrong fix. The classifier now checks for rate-limit phrasing (or a `Retry-After` header) first and returns a "temporarily rate-limited, try again in a moment" message; the credit-exhaustion path keeps the stricter keyword set.
- **Shell commands with newline-wrapped `cmd` fail as "command not found"**: When models sent `cmd` with leading/trailing newlines (e.g. `"\ncat index.html\n"`), `parseShellCommand` didn't treat `\n` as a word separator — newlines were appended to the command name, producing `"\ncat"` instead of `"cat"`, which missed the switch-case lookup. The parser now splits on `\n` and `\r` alongside spaces and tabs.
- **DeepSeek V4 Pro 400 on multi-turn conversations**: DeepSeek V4 Pro via OpenRouter returned `The reasoning_content in the thinking mode must be passed back to the API` on every follow-up turn. DeepSeek validates the *presence* of a `reasoning_details` field on prior assistant messages — even when no reasoning content was actually streamed back. Assistant messages now always include the field (defaulting to an empty array), so multi-turn replay satisfies the validation.

## v1.59.0 - 2026-04-21

### AI Orchestration

- **Resilient large file writes**: Multiple layers of recovery for when a provider truncates or hangs during a large tool call (e.g., writing a big CSS file via heredoc). The streaming parser times out after 45 seconds of no data instead of hanging indefinitely. Truncated heredoc content is written to the file so the model can continue from where it left off. A fallback heredoc extractor catches cases where the primary parser fails. Commands truncated before the heredoc operator completes are rejected with a clear retry message instead of being misinterpreted.
- **Tool error recovery**: When a tool call fails and the model responds with no content, the orchestrator prompts it to retry instead of nudging for `status --complete`. Previously this led to nudge exhaustion and task termination.

### UI

- **Semantic block drops land at the drop position**: Blocks dropped inside large parent elements now land where you put them instead of drifting elsewhere.
- **Accurate tool badge during streaming**: While a `shell` tool call is still streaming, the badge label and command preview reflect the command that's already arrived — "write", "read", "search", etc. labels and partial command text show up immediately instead of a generic "shell" badge.
- **Backend unreachable banner**: When an API call to OSW Studio's own server fails with a network error or 5xx, a persistent red banner appears. Clarifies why model discovery and AI generation aren't working. Clears automatically on the next successful request.
- **Preview command won't close an open panel**: When the AI runs `preview <path>` and the preview panel is already open, the panel stays open instead of toggling closed.
- **Media file preview in editor**: Image files (png, jpg, gif, webp, bmp, ico) and video files (mp4, webm, ogg) now display inline previews in the editor panel with playback controls for video. Previously video files showed "Unsupported File Type".
- **Upload progress for large files**: Files over 512KB show a loading toast with file name and size during upload.
- **Upload overlay fix**: The "Drop files here to upload" overlay no longer gets stuck when an upload errors.

### Auth & Sync (Server Mode)

- **Rolling session refresh**: Active sessions are extended automatically. When a request hits the middleware past the session's halfway point, a fresh cookie is issued. Active users stay logged in instead of being kicked out at a hard 24-hour wall.
- **Session-expired banner**: When an auth-gated API call returns 401, an amber banner appears with a "Log in" link. Previously auto-sync failures were silent.
- **Auto-sync stops retrying on 401**: Bails immediately on expired session instead of burning through 3 retry attempts.

### Skills

- **Frontend Design skill tree**: The monolithic `frontend-design` skill is now a base skill plus four aesthetic sub-skills. The base covers universal principles (Design Intent block, typography tiers, color construction, spacing, interaction, anti-patterns) and directs the AI to pick the aesthetic that fits the project. Sub-skills teach design thinking — what kinds of fonts to look for, how color relationships should feel, what motion communicates — without hardcoding specific values. Each generation produces different choices within the aesthetic's guardrails.
  - `frontend-design-bold-geometric` — massive type, high contrast, kinetic energy (product launches, brand sites)
  - `frontend-design-soft-organic` — warm, rounded, gentle (SaaS, wellness, consumer products)
  - `frontend-design-editorial` — serif-forward, magazine grids, content-dense (blogs, publications, portfolios)
  - `frontend-design-minimal` — extreme whitespace, monochrome, restrained (luxury, architecture, photography)

### Bug Fixes

- **File sync UNIQUE constraint error**: Publishing or syncing a project to the server could fail with `UNIQUE constraint failed: files.id` when a stale file record survived the delete-then-recreate cycle. Syncs are now idempotent.

## v1.58.0 - 2026-04-19

### ES Module Support

- **Import map injection**: Preview auto-injects `<script type="importmap">` for non-bundled runtimes (Static, Handlebars), mapping VFS JS/TS paths to blob URLs. Enables `<script type="module">` with `import`/`export` between project files — no bundler needed. Preview-only; published sites serve real files and don't need it.
- **Static runtime prompt**: AI guidance for Static projects now covers ES module imports with absolute paths and CDN URLs for third-party libraries.

### AI Orchestration

- **Conversation compaction improvements**: Compaction is now disabled by default — enable per provider in Settings. When enabled, the threshold uses cumulative prompt tokens instead of per-response usage, so it works consistently across all providers. Compaction fires at exactly the configured limit. Anthropic usage fields (`input_tokens`/`output_tokens`) now parse correctly.
- **Truncated tool call recovery**: When a `shell` tool call's JSON is truncated (large `cat` heredoc hitting `max_tokens`), the repaired command executes instead of returning a generic error. Truncated heredocs write truncated content, which the model can detect and continue from.
- **Script timeout no longer hangs**: Script execution timeout (now 60s, was 30s) emits a `complete` event before aborting the worker, so the tool call resolves with a timeout error instead of hanging forever on "executing".
- **Nudge cleanup on follow-up**: When a user sends a follow-up message after nudge exhaustion, stale nudge messages are stripped from the conversation. Previously, consecutive nudge messages remained and caused the model to return empty responses on the next turn.

### UI

- **Login and register theming**: Login and register pages now follow the app's light/dark theme instead of being hardcoded dark. The logo component auto-inverts colors with theme (light: black bg + white letters, dark: white bg + black letters).
- **Live runtime switching**: When the AI changes the project runtime (e.g., `runtime handlebars`), the preview picks it up immediately. Previously the preview kept using the old runtime until the project was saved and reopened, causing raw Handlebars tokens like `{{> nav}}` to appear unprocessed.
- **Monaco editor error boundary**: The editor panel no longer crashes the entire UI when Monaco's internal render fires after disposal (e.g., during panel resize/move). An error boundary catches the error and silently re-mounts the editor.
- **Chat input performance**: Prompt state now lives inside the chat panel. Typing in the textarea no longer re-renders the file explorer, editor, preview, and every other workspace child on every keystroke.
- **Tool call streaming performance**: Tool parameter deltas now emit small fragments instead of cumulative snapshots, fixing O(N²) memory blowup and UI lag during long tool call streaming. Also fixed garbled `_raw` parameters and missing command previews on tool badges.
- **Orphan waiting indicator fix**: Empty-response iterations no longer leave permanent "Waiting for response..." spinners in the chat.
- **SVG files open as text**: SVG files now open in Monaco as editable XML instead of showing the image preview placeholder.
- **SVG output from Python**: Script worker no longer base64-encodes SVG files written to `/output/` — they're treated as text (like HTML/JSON) instead of binary images.
- **Model search auto-focus**: When opening settings with a connected provider, the model search input auto-focuses instead of the provider dropdown — users can start searching models immediately.

## v1.57.0 - 2026-04-14

### Multitenancy & Workspaces (Server Mode)

- **Workspace-based data isolation**: Each workspace gets its own `data/workspaces/{workspaceId}/osws.sqlite` database. Projects, files, deployments, templates, and skills are scoped per-workspace. A separate `data/system.sqlite` manages user accounts, workspaces, and access grants
- **Shared workspace access**: Multiple users can be granted access to the same workspace. An agency can create a workspace for a client, build the site, then invite the client to make their own updates via the AI
- **Workspace-scoped URL routing**: All workspace pages live at `/w/{workspaceId}/projects`, `/w/{workspaceId}/deployments`, etc. API routes under `/api/w/{workspaceId}/sync/`, `/api/w/{workspaceId}/deployments/`, etc. Legacy `/admin/` paths redirect to the user's default workspace
- **Workspace switcher**: Dropdown in the sidebar shows all workspaces the user has access to with role badges. Switching navigates to the same view in the new workspace. Admins can access workspace management directly from the switcher. Workspace name cached in localStorage for instant display on page load
- **User registration and authentication**: New `/api/auth/register` endpoint and `/admin/register` page. Login supports email + password auth against the system database, with admin password fallback for single-user instances
- **Route protection**: All workspace-scoped routes verify the user has access to the workspace. Middleware enforces auth for `/w/` and `/api/w/` paths. Previously unprotected routes secured
- **Quota enforcement**: Each workspace has configurable limits for projects, deployments, and storage. Project count checked at creation, deployment count at publishing, storage checked on file sync. Storage warning banner appears at 80% usage. Sync status API returns full quota info (used/max for projects, deployments, storage)
- **Admin management**: New `/admin/users` and `/admin/workspaces` pages. User creation includes workspace assignment (new workspace, existing workspace, or none). User expansion shows workspace memberships. Workspace management shows members, stats, quotas with create/edit/delete and access grant/revoke. Workspace deletion cleans up filesystem
- **First-user-is-admin setup**: Fresh instances redirect to a registration page on first visit. The first user to register becomes admin with an unlimited workspace. No `ADMIN_PASSWORD` env var needed for new installs. Legacy admin password only works as a bootstrap mechanism when zero users exist
- **Instance configuration**: `REGISTRATION_MODE` (open/closed) controls self-registration. `INSTANCE_API_KEY` enables machine-to-machine admin API auth. `INSTANCE_ID` identifies the instance
- **Legacy data migration**: Upgrading from single-user mode automatically copies projects, deployments, templates, and skills from `data/osws.sqlite` to the default workspace on login. Workspace repair endpoint (`POST /api/admin/workspaces/{id}/repair`) detects and fixes orphaned data, missing deployment routes, and incomplete migrations
- **Workspace-scoped publish pipeline**: Static builder, backend feature extractor, and project swap analyzer all use the workspace adapter. All view components (deployments, database managers, server settings) fetch from workspace-scoped API URLs

### Security

- **Timing-safe comparisons**: API key and admin password comparisons use `crypto.timingSafeEqual`
- **SQL statement blocking**: ATTACH, DETACH, PRAGMA, VACUUM blocked in user-facing SQL execution paths
- **Session validation**: Deactivated users' sessions invalidated on next request via DB check
- **Analytics ownership**: Analytics read/clear endpoints verify deployment ownership
- **Email validation**: Registration validates email format
- **Path validation**: Workspace IDs validated as UUIDs before file path construction

## v1.56.0 - 2026-04-12

### Semantic Blocks

- **Drag-and-drop semantic block placement**: Semantic blocks are implementation descriptions, not pre-built components. A new palette panel in the preview toolbar (36 blocks across 4 categories) lets users drag blocks directly onto the live preview at any DOM depth. The AI receives each block's specification along with the surrounding HTML context and writes code that integrates with the existing implementation. Blocks appear as wireframe placeholders in the preview and as context entries above the chat input
- **36 blocks across 4 categories**: Page Structure (Hero, Header/Nav, Footer, Features Grid, Testimonials, Pricing, FAQ, CTA Banner, Sidebar Nav, Breadcrumbs, Tabs, Pagination), Media & Text (Text Block, Image, Video, Card, List, Accordion, Gallery, Timeline, Profile Card), Forms & Buttons (Button, Form, Contact Form, Search Bar, Modal, Login Form, File Upload, Notification, Dropdown Menu), Numbers & Charts (Table, Chart, Stats Counter, Progress Bar, Metric Cards, Data List)
- **Unified context component**: Focus context, semantic blocks, and attached images are now combined under a single "Included in next message" panel above the prompt input, replacing three separate displays. Each section is independently collapsible with its own clear button. In sent messages, context appears as a collapsed "Context (focus, 2 blocks, 1 image)" line, expandable to show details

### Workspace Panels

- **Panel replace preview uses overlay**: Sidebar hover highlight now uses an absolute-positioned overlay instead of border, avoiding layout shift and working consistently across all panel types (including those with `overflow-hidden`)
- **Insert position indicator**: Hovering a sidebar button for a closed panel now shows an animated indicator at the right edge showing where the panel will appear. New panels always open as the rightmost panel for predictable behavior
- **Per-panel size persistence**: Panel IDs are now identity-based (`panel-chat`, `panel-preview`) instead of position-based (`slot-0`, `slot-1`). Sizes persist per panel across reorders, close/reopen cycles, and sessions
- **Drag reorder preserves panel widths**: Reordering panels via drag now preserves each panel's width instead of resetting all to equal distribution

### UI

- **Rounded loading spinner**: Replaced 7 separate CSS border-based spinners with a unified SVG `Spinner` component (`components/ui/spinner.tsx`) using `stroke-linecap="round"` for smooth rounded line caps, consistent with the app's rounded design language

### Bug Fixes

- **Shell newlines inside quoted strings broke command parsing**: `splitNewlineCommands` split on newlines before checking if they were inside quoted strings, causing commands like `status --done "1. Did X\n2. Did Y"` to break — the `2.` was interpreted as a separate command. Fixed by buffering lines instead of pushing directly, so the next iteration's unbalanced quote check can accumulate them

## v1.55.1 - 2026-04-08

### Bug Fixes

- **Deployment serving routes used stale path**: The route handlers serving published deployment files still referenced the old `public/sites/` directory instead of `public/deployments/`, causing 404s in standalone/production mode (e.g. Hetzner). Dev mode was unaffected because Next.js dynamically serves `public/` files

## v1.55.0 - 2026-04-07

### Model Compatibility

- **Removed tools filter from OpenRouter model listing**: Models without native tool/function calling support (e.g., Gemma 3n, OLMo, Liquid) are no longer hidden from the model selector. All text-output models on OpenRouter now appear (~350 vs ~250 previously)
- **Non-tool-calling model support**: Models that don't support native function calling now work via text-based command extraction. The system prompt instructs these models to write commands in bash code blocks instead of invoking tools. The orchestrator parses ```bash blocks, Gemini-style `tool_code` blocks, and `shell{...}` JSON syntax from text responses and converts them to synthetic tool calls
- **Skip tools param for non-tool models**: `tools` and `tool_choice` are omitted from the API request when the model's `supportsFunctions` is false, preventing OpenRouter "No endpoints found that support tool use" errors
- **Malformed tool call detection scoped**: The "CRITICAL ERROR: You wrote a tool call as TEXT" correction now only fires when tools were actually sent in the request. Models without tool support are no longer scolded for writing commands as text
- **Model capability badges**: Selected model details now show badges for Tools, Vision, Reasoning, or "No native tools" so users can see what the model supports at a glance

### Providers

- **mesh-llm provider**: New provider for distributed p2p inference via the [mesh-llm](https://github.com/michaelneale/mesh-llm) network. Free open model inference from shared compute — no API key needed. Run `mesh-llm --auto` locally to join the public mesh, then select "mesh-llm" in OSW Studio settings. Models are auto-discovered from the mesh. Works on desktop and self-hosted deployments (requires mesh-llm running on the same machine)

### Bug Fixes

- **Stale model on provider switch**: The orchestrator cached the model name at construction time (`this.model`), so switching providers mid-session (e.g. mesh-llm → OpenRouter) would keep sending the old model ID, causing instant "not a valid model ID" errors on every Continue. `getProviderConfig()` now prefers the user's current config selection over the cached value
- **Blind retry on Continue after API error**: Clicking Continue after an `error_paused` API error retried with identical messages, causing the model to produce the same broken output in a loop. The retry now injects a synthetic error message into the conversation so the model sees different input. For JSON parse errors (e.g. heredoc syntax breaking tool call serialization), the guidance specifically steers the model away from the problematic pattern
- **Preview toolbar flicker during typing and generation**: The crosshair and camera icons in the preview panel flickered on every keystroke and generation progress event. Caused by inline arrow functions (`onFullscreen`, `onClose`) defeating `React.memo` on `MultipagePreview`. Extracted to stable `useCallback` handlers

## v1.54.0 - 2026-04-05

### Improved Server Mode Auto-Sync

- **Background sync for projects**: Project saves now automatically push to SQLite in the background (Server Mode only). The existing 2-second debounced `triggerAutoSync` on save is now silent — no toast notifications for routine syncs. Failed syncs retry up to 3 times with backoff (5s, 10s, 15s) before marking the project as error state
- **Background sync for skills**: Custom skill create, update, and delete operations now auto-push to the server in the background via fire-and-forget calls. Built-in skills are excluded
- **Background sync for templates**: Template save (from project), import (`.oswt` file), and delete operations now auto-push to the server in the background
- **Flush on workspace exit**: Leaving the workspace now flushes any pending debounced sync immediately instead of cancelling it. Previously, a save followed by a quick exit would silently drop the sync
- **Flush on tab/window close**: A `beforeunload` handler fires all pending sync timeouts as best-effort before the page unloads

### Skills

- **Skills panel moved up in sidebar**: Skills button now appears above Console in the workspace sidebar, and `DEFAULT_PANEL_ORDER` updated to match
- **Create skill from workspace**: New "+" button in the skills panel header opens a dialog with the skill editor. Created skills are immediately enabled and visible to the AI on the next message

## v1.53.1 - 2026-04-05

### Desktop

- **Desktop CI overhaul**: Rewrote the Electron packaging pipeline. Standalone `.next/` directory was missing due to `cp -r *` not copying dotfiles — switched to `cp -r ./.` syntax. Replaced direct `startServer` API call (which required webpack at runtime) with `require('server.js')` which has the standalone config baked in. Disabled asar packaging to avoid `chdir` failures inside the archive. Excluded sharp from the bundle to fix universal (x64+arm64) build conflicts
- **Desktop auth bypass**: Admin API routes (`/api/admin/*`) were still checking for session tokens despite `OSW_DESKTOP=true`. Added desktop bypass to `getSession()` in `lib/auth/session.ts` — returns a synthetic admin session when running as desktop app. Covers all routes that use `requireAuth()` or `getSession()`
- **Hide logout in desktop mode**: Logout button in the sidebar is now hidden when `NEXT_PUBLIC_DESKTOP=true` since the desktop app has no authentication

## v1.53.0 - 2026-04-04

### Preview

- **Full size preview mode**: New Maximize button in the preview panel's device-size toolbar (next to mobile/tablet/desktop). Hides the workspace header, sidebar, panel header, and all other panels — the preview fills the entire viewport edge-to-edge (no padding, rounded corners, or shadow). Minimize button in the same toolbar position exits back to the normal workspace layout. All panel state is preserved across transitions

### Templates

- **Create template from project saves to instance**: "Export as Template" renamed to "Create a Template" in the project card menu. Instead of downloading an `.oswt` file, the template is saved directly to the instance's template storage (IndexedDB). Users can then export/download templates from the Templates page

### Fixes

- **Dashboard timestamp removed**: Removed "Updated {time}" text below the Dashboard heading
- **Dashboard recent projects card width**: Recent Projects card in browser mode now takes 50% width on desktop instead of stretching to 100%
- **Preview device size persisted**: The selected device size (mobile/tablet/desktop) in the preview panel is now saved to `localStorage` and restored when the panel is reopened or the page is refreshed
- **New project modal persisting after navigation**: Fixed the "New Project" dialog staying open when navigating back from the workspace to the projects page. The `autoCreateProject` flag (set by dashboard's "New Project" button) was not cleared when entering the workspace, so returning would re-trigger the dialog. Now reset on project select
- **Desktop app crash on launch**: Fixed `Cannot find module 'electron-updater'` error in packaged Electron app. Moved `electron-updater` from `external` to `noExternal` in tsup config so it's bundled into `main.js` instead of relying on runtime module resolution inside the asar

## v1.52.0 - 2026-04-04

### Misc

- **Desktop app**: OSW Studio is now available as a desktop application (Electron) for macOS, Windows, and Linux. The desktop app runs the full Next.js server locally with SQLite support (Server Mode). GitHub Actions CI builds installers for all platforms on `desktop-v*` tags. Auth bypass for desktop via `OSW_DESKTOP` env var — local single-user app doesn't need login
- **Security**: Resolved all npm audit vulnerabilities (22 → 0). Updated handlebars, next, js-yaml, mdast-util-to-hast, minimatch, picomatch, and removed leftover development dependencies

## v1.51.0 - 2026-04-03

### Skills Panel

- **Workspace skills panel**: New resizable panel in the workspace for toggling skills on/off without leaving the editor. Toggled from the left sidebar (purple Sparkles icon). Shows global enable/disable toggle, built-in skills section, and custom skills section — each with individual switches. Toggling a skill immediately reloads transient VFS files so the AI sees the change on the next message

### Panel System Overhaul

- **Shared panel components**: Extracted `PanelContainer` and `PanelHeader` into `components/ui/panel.tsx`. All 8 panels (Chat, File Explorer, Editor, Console, Preview, Checkpoints, Debug, Skills) now use the shared header component with consistent icon, title, actions, and X close button. Eliminates ~20 lines of duplicated header markup per panel
- **Max 3 panels visible**: Opening a 4th panel automatically closes the rightmost visible panel. Keeps the workspace usable instead of cramming 4+ panels into a narrow viewport. The `togglePanel()` function handles the constraint for all panel sources (sidebar buttons, programmatic opens like file click → editor)
- **Slot-based layout**: Panels are assigned to slots (`slot-0`, `slot-1`, `slot-2`) instead of panel-specific IDs. When a panel swaps for another, the new panel inherits the slot's width instead of resetting to its default size. Slot widths persist across swaps via `autoSaveId`
- **Drag-to-reorder panels**: Each panel header has a grip handle for reordering. During drag, dashed drop zones appear between panels and at the edges — the closest zone highlights as the mouse moves (lazy matching, no precision required). The dragged panel gets an orange dashed border that fades when hovering a drop zone. If the mouse stays near the panel's original position, it stays put. Mouse can leave the container freely — only releasing outside cancels. Panel order persists to `localStorage`. Resize handles stay enabled (hidden with CSS, not `disabled` prop) during drag to avoid breaking the library's internal state
- **Replace preview on sidebar hover**: When 3 panels are open and a sidebar button is hovered, the rightmost panel that would be replaced gets an orange dashed border — making it clear which panel will close before clicking
- **Panel state persistence**: Which panels are open/closed and their order are saved to `localStorage` and restored on next visit. Runtime-aware defaults preserved as fallback (preview on for visual runtimes, console on for terminal runtimes)
- **Unified close button**: All panels have an X button on the right side of the header (same size as the panel icon). Replaced the previous hover-to-X icon transition pattern
- **Checkpoint panel restyled**: Updated from gradient backgrounds, smaller text, and plain X button to the standard `bg-card` container with `PanelHeader`
- **Debug panel icon colored**: Bug icon now uses `text-foreground` to match its sidebar button styling
- **Checkpoint tooltip removed**: Removed orange tooltip on checkpoint description hover
- **Tool call preview truncation**: Shell command previews in the chat panel now truncate with ellipsis on a single line instead of wrapping to multiple lines. Uses CSS `truncate` instead of `substring(0, 50)` so the preview fills available width
- **Fix heredoc stdin in chained commands**: `mkdir -p /dir && cat > /file << 'EOF'` failed with "cat: missing file path" because heredoc stdin was passed to the first segment (`mkdir`) instead of the last (`cat`). Fixed by routing stdin to the last segment in `&&`/`||`/`;` chains. This was a significant source of shell failures — every `mkdir && cat > file` pattern was broken

## v1.50.1 - 2026-04-02

### Telemetry Improvements

- **Task ID linking**: Each task now gets a random UUID (`task_id`) passed through `task_started`, `task_complete`, `task_fail`, and `api_error` events. Enables tracing the full lifecycle of a single task including how many API errors occur before completion or failure
- **Error category classification**: `api_error` events now include an `error_category` enum: `credit_exhausted`, `rate_limited`, `model_not_found`, `context_too_long`, `tool_not_supported`, `auth_expired`, `server_error`, `invalid_request`, `unknown`. Classified from status code and response keywords without leaking error body text
- **Task fail reasons**: `task_fail` reason changed from generic `'error'` to `'api_error'` for provider failures. `'stopped'` already existed for user cancellation
- **Task complexity metrics**: `task_complete` and `task_fail` events now include `tool_count`, `turn_count`, and `api_error_count` — tracked by the orchestrator throughout the task lifecycle
- **Provider selection context**: `provider_selected` now includes `has_api_key` (boolean). `model_selected` now includes `previous_model` when the selection changes

## v1.50.0 - 2026-04-01

Error recovery, provider error handling overhaul, and default model change.

### Error Recovery

- **Task pause on API errors**: When an API call fails mid-task, the orchestrator pauses instead of killing the task. The chat shows "Task paused" with the error message and **Continue** / **Cancel** links. The user can fix the issue (wait for rate limits, add credits, fix API key) and click Continue to retry from where the task left off. Multiple consecutive errors each pause independently — the user can keep retrying. When re-opening a project where the last event was an error pause, it renders as a regular "Error" since there's no active task to continue
- **Recursive retry on continue**: Clicking Continue retries the same LLM call with the existing conversation state. If the retry also fails, it pauses again. The Stop button works at any point during a pause — resolves the pending promise and exits the loop cleanly. A fresh AbortController is created on each continue to avoid stale abort signals

### Provider Error Handling

- **Retry on transient server errors**: `fetchWithRetry` now retries 502, 504 (transient server errors) and 529 (Anthropic overloaded) in addition to 429 rate limits. 503 is not retried — OpenRouter uses it for "no provider available" which is a routing issue, not transient. Same exponential backoff (1s, 2s, 4s) with Retry-After header support. Retry toast now shows the actual error type ("Server error (502)" vs "Rate limited")
- **Auth errors across all providers**: 401/403 responses now show actionable messages for all providers — OAuth providers prompt reconnecting, API key providers prompt checking the key in Settings. Previously only showed generic "API error: Unauthorized"
- **Credit/quota exhaustion across providers**: Detected via status 402 or 429 with usage-related keywords. HuggingFace shows pricing info, OpenRouter shows credits link, others get generic billing guidance. Previously only HuggingFace had custom handling
- **Model not found**: 400/404 with "not found"/"does not exist" keywords now shows "Model not available — try selecting a different model" across all providers
- **Tool support missing**: 400 with tool-related errors shows actionable message suggesting MiniMax M2.7. Local providers still fall back to JSON-based tool calling
- **Anthropic 529 overloaded**: Specific message ("temporarily overloaded, will be retried automatically") and added to retry loop
- **OpenRouter 503**: Specific message ("no provider currently available for this model") instead of generic server error

### Default Model Update

- **MiniMax M2.7 as default**: OpenRouter default model changed from `deepseek/deepseek-chat` to `minimax/minimax-m2.7`. MiniMax direct provider default updated from `MiniMax-M2.5` to `MiniMax-M2.7`

### Fixes

- **Fix "New Project" dialog re-opening**: The `?action=create` URL parameter is now consumed and cleared via `router.replace()` after opening the create dialog, preventing it from re-triggering on subsequent navigations to the projects page

## v1.49.0 - 2026-03-31

### `runtime` Shell Command

- **Runtime switching from AI**: New `runtime <name>` shell command lets the AI change the project's runtime programmatically. Validates against the 8 supported runtimes (`static`, `handlebars`, `react`, `preact`, `svelte`, `vue`, `python`, `lua`). Updates `project.settings.runtime` via VFS and replaces `.PROMPT.md` with the new runtime's domain prompt if the current one is a default (leaves custom prompts untouched). Registered in the system prompt, tool registry, tool analytics whitelist, and known shell commands list

### AI Project Setup

- **AI-bootstrapped projects**: New "AI Project Setup" template available in the create project dialog. Instead of manually choosing a runtime and template, the user describes what they want and the AI handles everything — picks the best runtime via the `runtime` command, writes a tailored `.PROMPT.md` with project-specific instructions, creates the folder structure, and proceeds to build. The setup-phase `.PROMPT.md` includes a concise runtime guide and a draft-then-finalize workflow for the project prompt
- **Template UI**: "AI Project Setup" appears as the first option in the template dropdown for all runtimes. An "AI Project Setup" link in the template label row provides a shortcut. Selected template description shown in a bordered box below the dropdown

### Fixes

- **Fix dashboard "New Project" button**: Clicking "New Project" on the dashboard navigated to the projects page but didn't open the create dialog — both "New Project" and "Projects" buttons triggered the same action. Now passes an `autoCreate` flag through the component chain so the create dialog opens automatically on arrival

## v1.48.1 - 2026-03-30

- **Vendor Codex utilities**: Replaced `@spmurrayzzz/opencode-openai-codex-auth` package dependency with vendored `codex-utils.ts` containing only the 5 functions we use (`decodeJWT`, `createCodexHeaders`, `handleErrorResponse`, `getReasoningConfig`, `getNormalizedModel`). The package's module graph pulled in `fs`, `path`, `fileURLToPath`, and prompt-caching logic that baked absolute local paths (`file:///Users/otto/Desktop/...`) into the Next.js standalone build — breaking HuggingFace deployments where those paths don't exist

## v1.48.0 - 2026-03-30

Automatic conversation compaction for long-running agentic sessions, Codex vision support, and provider test harness improvements.

### Conversation Compaction

Long-running agentic sessions accumulate unbounded conversation history — every message, tool call, and tool result is sent to the LLM on each turn. Sessions regularly exceed 200K tokens, which many models don't support. The orchestrator now automatically compacts the conversation when it approaches the model's context limit.

- **Auto-compaction**: After each orchestrator iteration, if the API-reported `promptTokens` exceeds 80% of the compaction limit, the older portion of the conversation is sent for summarization. The summary replaces the older messages while recent turns are kept verbatim. The model continues working with full awareness of what was accomplished
- **Turn-boundary splitting**: Messages are grouped into turns (assistant message + its tool results) before splitting. The most recent ~20% of turns by token budget are preserved verbatim; older turns are summarized. This ensures tool results are never orphaned from their parent assistant message
- **Message flattening for summarization**: Tool-role messages and tool call arguments are converted to plain text before the summarization request. This prevents models from hallucinating tool calls when they see tool patterns in the history without tool definitions. Large file contents in tool arguments are truncated to 500 chars
- **Proportional summary cap**: Summary output is capped at 10% of the compaction limit (max 16K tokens), preventing oversized summaries that leave no headroom for continued work
- **Compaction limit resolution**: Priority chain — user override (per-provider setting) → provider registry `contextLength` → models API `contextLength` (for dynamically discovered models like OpenRouter) → 128K fallback
- **Settings**: "Auto-compact" toggle (default: on) and "Compaction limit (tokens)" field in provider settings. When disabled, no compaction occurs regardless of conversation size
- **Chat divider**: A dashed line with pre/post token counts appears in the chat panel at each compaction point (e.g. "Context compacted — 15K → ~7K tokens"). All pre-compaction messages remain visible above the divider for inspection
- **Fresh context on compaction**: System prompt is re-gathered from current VFS state (file tree, `.PROMPT.md`, server context) on each compaction, ensuring the model sees the latest project structure
- **Sub-agent exemption**: Only the parent orchestrator compacts. Sub-agents (`explore`, `task`, `plan`) are exempt — their iteration caps keep conversations short
- **Reasoning detail stripping**: `reasoning_details` (potentially large encrypted blobs from thinking models) are stripped from the summarization request to avoid wasting tokens
- **Cost tracking continuity**: Compaction LLM call costs are accumulated into `totalUsage` and `totalCost`. Loop detection state is reset after compaction (stale after context change). Iteration counter is not reset (prevents runaway sessions)

### Models API Enrichment

- **Context length passthrough**: The `/api/models` endpoint now returns `{ id, contextLength }` objects for OpenRouter models (previously returned bare ID strings). The model selector caches this metadata, enabling automatic compaction limit resolution for dynamically discovered models without hardcoded registry entries

### Codex Vision Support

- **Image inputs passed through to Responses API**: The Codex adapter (`codex-adapter.ts`) converted all user message content to text-only via `getTextFromContent()`, silently discarding `image_url` blocks. Users sending screenshots or images through Codex (ChatGPT subscription) received responses as if no image was attached. Fix: added `contentToCodexContent()` that maps Chat Completions `image_url` blocks to the Responses API `input_image` format (`{ type: 'input_image', image_url: '<url>' }`), preserving multimodal content alongside text

### Benchmark

- **Compaction test scenarios**: Two benchmark scenarios (`compaction-multipage-site`, `compaction-iterative-expansion`) that generate enough context to trigger compaction at reasonable limits. Assertions verify files created after compaction maintain brand names and navigation links from before compaction — proving context continuity through summarization


## v1.47.0 - 2026-03-27

Sub-agent delegation via the `delegate` shell command, Vue SFC compilation fixes, build command reliability, stop propagation, and project manager performance.

### Sub-Agent Delegation

The orchestrator can now spawn focused sub-agents that run isolated LLM conversations with their own system prompts and iteration limits.

- **`delegate` command**: Three agent types — `explore` (read-only, 5 turns, capped exploration), `task` (full edit, 30 turns, focused coding), `plan` (read-only, 10 turns, structured analysis). Inline and heredoc syntax supported
- **Multi-prompt parallelism**: Multiple quoted prompts in a single command run as parallel agents — `delegate task "edit A" "edit B" "edit C"` spawns 3 concurrent sub-agents from one tool call. Quote parser handles nested quotes in HTML/code content and heredoc boundaries. Hard cap of 8 concurrent delegates per command
- **Cost aggregation**: Sub-agent token usage and costs accumulate into the parent orchestrator's totals
- **Agent isolation**: Each sub-agent gets its own orchestrator instance with fresh conversation, loop counters, and state. Sub-agents start with project context (file tree, `.PROMPT.md`) but no parent history. Nested delegation blocked. Skill evaluation skipped for sub-agents
- **Stop propagation**: Parent `.stop()` cascades to all running sub-agents and aborts in-flight `fetch()` calls via `AbortController`
- **Sub-agent visibility**: Real-time sub-agent activity shown in chat UI via `delegate_progress` events with tool call counts. Tool call healing rewrites bare `delegate` tool calls into proper shell calls for conversation history
- **Event filtering**: Only meaningful sub-agent events (`tool_status`, `tool_result`, `error`, `stopped`, etc.) are forwarded to the parent — streaming deltas are excluded
- **Agent-specific system prompts**: Each agent type gets a dedicated prompt — explore (search-first, no speculation), plan (structured what-exists/what-changes/approach output), task (full edit with ss/cat/sed/build/status). All include `.PROMPT.md` and server context
- **Explore/plan exit**: Read-only agents finish when they stop calling tools — no status command or nudging required
- **UI**: Delegate commands show purple bot icon in chat tool badges. `delegate` added to shell command whitelist in tool analytics

### Vue SFC Compilation Fixes

Two bugs in the Vue SFC compilation pipeline that caused Vue projects to silently fail to render.

- **Template-only SFC support**: `.vue` files without a `<script>` block (like the Vue starter template's `App.vue`) previously produced empty JavaScript — `scriptCode` stayed `''` because `compileScript()` was skipped, so `import App from './App.vue'` got `undefined` and `createApp(undefined).mount("#root")` silently failed. Fix: when no script block exists but a template does, `compileTemplate()` compiles the template into a render function with `compilerOptions: { mode: 'module' }` (for ES module imports), then appends `export default { render }` to produce a valid component module
- **TypeScript in `<script setup lang="ts">`**: The CDN-loaded `@vue/compiler-sfc` leaves TypeScript annotations in `compileScript()` output (e.g. `defineProps<{...}>()`, `defineEmits<{...}>()`) which esbuild rejects when the loader is `'js'`. Fix: after `compileScript()`, if `scriptBlock.lang === 'ts'`, the output is passed through `esbuild.transform()` with `loader: 'ts'` to strip type annotations — the same technique already used for Svelte's `preprocessSvelteTS()`

### Build Command Reliability

- **Own compilation**: The `build` shell command previously piggybacked on the preview's debounced compilation — `waitForCompilation(2000)` listened for the preview's `compilationComplete` event. This caused a race condition: when the AI writes 3+ files in sequence, the preview may compile after the first file (with incomplete project state), commit that partial result, and `build` immediately drains it — reporting "0 errors" while the bundle wasn't generated. Fix: `build` now creates its own `VirtualServer` instance with the project's `settings.runtime` and calls `compileProject()` directly. The compilation always sees the current VFS state regardless of preview timing. Blob URLs created during compilation are cleaned up immediately since `build` only needs the error output

### Event System

- **ID-based event tracking**: The chat panel's incremental event processor previously used an array index (`lastProcessedIndexRef`) to track which debug events had been processed. When `MAX_DEBUG_EVENTS` was exceeded and events were pruned from the front, the index became stale — pointing past the array boundary or at the wrong event — causing new events to be silently skipped. Fix: replaced with `lastProcessedEventIdRef` which stores the `id` of the last processed event and uses `findIndex()` to locate it after pruning. If the last processed event was pruned, the processor resets and reprocesses all current events
- **Debug event capacity**: `MAX_DEBUG_EVENTS` increased from 500 to 2000 to accommodate delegate sub-agent event volume without triggering frequent front-pruning

### Performance

- **Project manager typing lag**: Typing in the "Create New Project" dialog was extremely laggy because every keystroke on the project name input re-rendered the entire `ProjectManager` component, including all `ProjectCard` components behind the dialog. Fix: `ProjectCard` wrapped in `React.memo()` to skip re-renders when props haven't changed. Action callbacks (`deleteProject`, `duplicateProject`, `exportProject`, `exportProjectAsZip`) wrapped in `useCallback` with stable dependencies. Inline `onUpdate` handler extracted to a `useCallback`-wrapped `handleProjectUpdate` that uses functional state update (`setProjects(prev => ...)`) instead of closing over `projects`. `filteredBuiltInTemplates` memoized with `useMemo` keyed on `newProjectRuntime`

### Stop & Cancellation

- **Immediate stop**: Clicking "Stop" now immediately aborts in-flight LLM calls via `AbortController` instead of waiting for the current response to complete. The abort signal propagates through the response stream reader, so both the parent orchestrator and any running sub-agents halt mid-stream
- **Upstream cancellation**: The API route (`/api/generate`) now passes `request.signal` to all upstream provider `fetch()` calls. When the client disconnects, the server-side connection to the provider is also closed — stopping inference and billing for providers that support it (OpenAI, Anthropic, Ollama, LM Studio, HuggingFace TGI). Providers that don't support server-side cancellation (Google Gemini, Groq, MiniMax, SambaNova) will continue generating regardless — this is a provider-side limitation
- **Codex adapter**: `handleCodexGeneration` now accepts and forwards an `AbortSignal` to the upstream Codex fetch

### Chat UX

- **Per-task usage summary**: Token count, cost, and duration are now shown once per task (on the last turn) instead of after every LLM call. Multi-turn tasks that previously showed 5+ usage lines now show one collated summary with the total
- **Task duration**: Usage line now includes elapsed time (e.g. `Tokens: 12,400 • Cost: $0.0041 • 8s`)
- **Turn boundaries**: User follow-up messages now start a new turn, so the previous task's Restore/Retry buttons stay attached to the assistant's last output instead of appearing under the next user prompt

### Code Cleanup

- **Dead code removal**: Removed `Agent.systemPrompt`, `Agent.name`, `Agent.description` fields (stored but never read), `getOrchestratorPrompt()` method, `extractToolCallSummary()` method and unused `toolCallSummary` return value, `stableStringify()` method (unreachable in single-tool architecture), `waitForCompilation()` and its tracking variables from `compile-errors.ts`, dead `providerConfig` from `getProviderConfig()` return
- **Prompt deduplication**: `.PROMPT.md` loading logic (triplicated across `buildExplorePrompt`, `buildPlanPrompt`, `buildDynamicContent`) consolidated — explore/plan now call `buildDynamicContent()`. `ss` editing docs extracted to shared `SS_EDITING_DOCS` constant
- **Sub-agent server context**: Explore and plan sub-agents now receive `serverContext` and call `buildDynamicContent()`, gaining awareness of backend features (sqlite3, edge functions) and Browser Mode fallback text. Previously hardcoded `hasServerContext: false`
- **Sub-agent chatMode inheritance**: Task sub-agents now inherit parent's `chatMode`, preventing writes when parent is in read-only mode
- **ss entity detection**: `ssAutoDetectEntityType` (5 return values, only 1 distinguished) simplified to `ssIsHtmlEntity` returning boolean. HTML tag regex updated to handle `>` inside quoted attributes. Depth tracking no longer goes negative on malformed HTML
- **VirtualServer constructor**: Refactored from 6 positional params (3 commonly `undefined`) to options object. All 7 call sites updated
- **Quote parser fix**: `extractTopLevelQuotedStrings` now captures unterminated trailing prompts regardless of prior successful parses
- **ss regex `$$` escape**: `$$` in `ss --regex` replacement now produces a literal `$` (previously no escape mechanism)
- **Analytics whitelist**: Added `preview`, `python`, `python3`, `lua` to `SHELL_COMMAND_WHITELIST` in tool analytics
- **Project tree fix**: `buildProjectContext` now renders `scheduled-functions/` directory when present; skill connector logic accounts for `fileTree` presence
- **Miscellaneous**: `agentType` parameter typed as `AgentType` instead of `string`, pre-compiled `/\s/` regex in fuzzy match, removed redundant bounds checks and unreachable guards, `AgentRegistry.register()` made private


## v1.46.0 - 2026-03-23

`ss` (supersed) shell command for multiline editing. The shell-only approach from v1.44.0 improved tool call reliability but limited edits to full file rewrites (`cat >`) or single-line substitutions (`sed`). `ss` adds targeted multiline search-and-replace without re-introducing a separate tool.

- **`ss` command**: Four modes via heredoc (`ss /file << 'EOF'`): literal (exact match), `--entity` (give opening line, auto-finds closing boundary), `--fuzzy` (whitespace-normalized), `--regex` (multiline regex with `$1` backreferences). Entity detection supports JS/TS functions, HTML elements, and CSS rules with bracket/depth tracking
- **Editing strategy**: System prompt and workflow skill updated — `ss` for edits, `cat >` for creation/full rewrites, `sed` for single-line regex. `build` and `status` shown with explicit `shell()` wrapper for consistency
- **Harmony format filtering**: Tool calls containing `<|...|>` tokens (internal channel artifacts from GPT-OSS and other harmony-format models) silently discarded before execution. No impact on non-harmony models

## v1.45.0 - 2026-03-22

Single-tool architecture — the `evaluation` tool is removed and the AI's tool surface is reduced to 1 (`shell` only). Benchmarking across models showed that the `status` shell command produces better task completion and tool use than a separate evaluation tool. Shell reliability improvements across the board.

### Status-Only Evaluation

Benchmark analysis confirmed structural problems with the other evaluation modes: the separate `evaluation` tool acted as an escape hatch (models call `goal_achieved: true` after failed work), and the unified `evaluation done` command front-loaded the decision before reasoning. The `status` command forces reasoning-first — `--task`, `--done`, `--remaining` before `--complete` — producing better completion rates across models. Status is now the sole evaluation approach.

- **Removed `evaluation` tool**: Tool definition, executor, `ToolId` union member, shell command handler, and analytics extractor all deleted. Tool surface: 2 → 1
- **Removed `EvaluationMode` type**: The `'standard' | 'unified' | 'status'` type and all mode-branching logic removed from system prompt, orchestrator, and benchmark UI
- **Simplified orchestrator**: Removed evaluation tool state, capture, detection, and rejection intercept. Status detection and nudging run unconditionally
- **Simplified benchmark**: Mode selector buttons removed. Tests always run with status mode

### Explicit Build Command

Added `build` as a shell command for explicit compilation feedback. Returns `"Build successful — 0 errors"` or a formatted error list. Replaces the previous automatic compile error injection between orchestrator iterations — the AI now controls when it checks compilation. Uses event-based synchronization (`compilationComplete` event) instead of fixed delays, so compile errors are never missed on slower framework builds (React/Svelte/Vue)

### Error Handling Improvements

- **Runtime errors deferred to completion**: Runtime errors are no longer injected between iterations (where they cause false positives during multi-file rewrites). Now deferred to the completion gate at `status --complete` — the orchestrator waits for compilation to settle, then blocks completion if errors exist
- **Preview blindness guidance**: System prompt and workflow skill now explicitly state the AI cannot see the preview, directing it to use `build` instead of diagnostic loops

### VFS Shell Improvements

- **Glob expansion**: `*` and `?` patterns in file arguments are expanded against the VFS file listing for commands like `wc`, `ls`, `cat`, `rm`, `cp`, `mv`, `touch`
- **`wc` multi-file output**: Per-file counts with a `total` line, matching real `wc` behavior
- **`ls -l` / `-la` / `-lh`**: Long format with file size, modification date, human-readable sizes, and multi-file/directory support
- **`rg`/`grep` no-match**: Returns empty stdout instead of an error-framed stderr message
- **`sleep` no-op**: Silent pass-through instead of "command not found" error
- **File extension whitelist removed**: `createFile` no longer blocks files with uncommon extensions (`.bak`, `.env`, `.toml`, etc.)

### Shell Parsing Fixes

- **Heredoc greedy matching**: Fixed heredocs truncating when content contains the delimiter word
- **Trailing command after redirect**: Fixed successful `cat > /file` being treated as failure
- **Quote-aware line splitting**: Fixed multiline quoted strings being split into broken fragments

### Skills Restructure

- **`workflow`** (new): Merged from `osw-planning` + `osw-one-shot`. Covers the full project lifecycle, runtime-agnostic. References `build` for post-write verification
- **`responsive`** (new): Dedicated responsive design skill — mobile-first CSS, breakpoints, nav collapse patterns, common mobile failures, touch targets
- **`frontend-design`** (new): Visual design quality — typography, color systems, spatial composition, motion, avoiding generic AI aesthetics
- **Deleted**: `osw-planning`, `osw-one-shot` (content merged into the above)

### Other Changes

- **Runtime-aware domain prompts**: `.PROMPT.md` auto-updates when the project runtime changes. Confirmation dialog if user has customized it
- **Browser Mode awareness**: AI system prompt states backend features are unavailable and suggests client-side alternatives
- **Shell tool visual classification**: Tool call badges now show distinct icons — write (orange), status (orange), shell (blue) — parsed from the `cmd` string
- **Reasoning display fixes**: Fixed coalesced reasoning events dropped during React batching; replaced content-length streaming heuristic with explicit `complete` flag

### Bug Fixes

- **Skills not loading**: `reloadTransientSkills()` was never called from the SkillsManager component — added calls to all 5 mutation paths
- **Backend settings tabs inaccessible**: Server feature tabs had `disabled` prop preventing access to the Browser Mode notice. Now always clickable

## v1.44.0 - 2026-03-16

Unified shell-only file editing — the structured `write` tool is removed in favor of standard shell commands (`cat >`, `sed -i`). Major `sed` enhancements to support the expanded role of shell-based editing.

### Shell-Only File Editing

A/B benchmarking across multiple models (Grok Code Fast, Qwen 3.5 Flash, MiMo v2 Flash) showed that shell-only editing (`cat >`, `sed -i`) was 6-9% cheaper in tokens and eliminated the #1 source of tool call failures (malformed JSON in structured write operations). The structured `write` tool is now removed — the AI edits files exclusively via shell commands.

- **Removed `write` tool**: The JSON-based write tool (update, rewrite, replace_entity operations), its executor `string-patch.ts`, and `ContinuationHandler` are deleted. Tool surface simplified from 3 tools to 2 (`shell`, `evaluation`)
- **Removed `ToolMode` plumbing**: The `'standard' | 'unified'` mode type, mode-conditional system prompts, and write tool rejection logic are removed. There is now only one mode
- **Cleaned up `json-repair.ts`**: Removed write-specific functions (`analyzeOperationType`, `generateContinuationMessage`, `generateUnsafeOperationError`). General repair utilities retained for orchestrator use

### sed Enhancements

With file editing fully reliant on shell commands, the virtual `sed` implementation received a major upgrade to support real-world editing patterns that AI models produce.

- **BRE-to-ERE conversion**: New `breToEre()` function converts sed's Basic Regular Expression syntax to JavaScript ERE — fixes patterns like `darken(var(--primary), 10%)` being treated as regex groups
- **Address-based commands**: Line number addresses (`6s/old/new/`), pattern addresses (`/pattern/d`), and range addresses (`/start/,/end/d`)
- **New commands**: Delete (`d`), change (`c\`), insert (`i\`), append (`a\`), and print (`p`) with full address and range support
- **`-n` flag support**: Enables the suppress-and-print idiom (`-n '/pattern/p'`)
- **`-i` variant handling**: Supports GNU (`-i`), BSD/macOS (`-i ''`), and backup (`-i.bak`) syntax

### Codebase Cleanup

- **Deleted dead files**: `generation-api.ts` (superseded by pricing-cache), `database.ts` (legacy VFS class superseded by `indexeddb-adapter.ts`), `validation.ts` (every export unused)
- **Purged stale write tool references**: Replaced write tool JSON examples in domain prompts, skill content, system prompts, and guided tour with shell equivalents
- **Removed dead code**: Unused types, ConfigManager methods, component props, analytics handlers, and orchestrator plumbing left behind by the write tool removal and earlier refactors

### Benchmark Infrastructure

- **New file editing stress scenarios**: 6 scenarios validating shell-based file editing (special characters, multiline, sequential edits, JSON/CSS files)
- **Updated tracks**: "Write tool" track renamed to "File Editing"

## v1.43.0 - 2026-03-12

Python & Lua scripting runtimes, a unified interactive Console, and a runtime split separating pure static sites from Handlebars-powered templates.

- **Handlebars Runtime Split**: The existing `static` runtime has been renamed to `handlebars` to reflect its Handlebars templating capabilities (partials, data.json, helpers). A new `static` runtime provides pure HTML/CSS/JS with no template engine — `{{mustache}}` syntax in HTML is rendered literally, not compiled. Existing projects are automatically migrated. New projects default to `static`
- **Python Runtime**: Full Python 3 support via Pyodide (CPython compiled to WebAssembly). Supports the Python standard library, `import` between project files, and output file generation (e.g. matplotlib plots written to `/output/`). Pyodide loads from CDN on first execution and is cached by the browser
- **Lua Runtime**: Lua 5.4 support via wasmoon (Lua VM compiled to WebAssembly). Supports `require()` for multi-file projects and standard library modules (string, table, math, io)
- **Interactive Console**: A unified terminal panel replacing the previous output-only Terminal. Combines a VFS shell (commands with pipes, redirects, chaining) and script execution (`exec main.py`) in one xterm.js instance. Command history with Up/Down arrows, Ctrl+C to cancel, Ctrl+L to clear. For Python/Lua projects, auto-runs the entry point on file changes. Available for all project types via the sidebar toggle
- **File Explorer: Run in Console**: Right-click any `.py` or `.lua` file to execute it in the Console
- **Starter Templates**: Handlebars Starter (partials + data.json), Python Starter, and Lua Starter — each with entry points and framework-specific `.PROMPT.md` for the AI
- **Runtime Error Feedback**: JS runtime errors from the preview iframe (uncaught exceptions, unhandled rejections, `console.error()`) now feed back to the AI for auto-correction. Post-completion errors surface as a card above the chat input with "Send" (auto-sends to AI) and "Clear" actions
- **ZIP Export**: Python and Lua projects export raw source files with a README containing run instructions. No compilation step
- **Server Publish: Bundled Runtimes**: Publishing React, Preact, Svelte, and Vue projects in Server mode now compiles bundles client-side before syncing — the server detects pre-compiled `bundle.js`/`bundle.css` and skips the esbuild step
- **Server Publish: Terminal Runtimes Blocked**: Python and Lua projects cannot be published as static deployments. Attempting to publish shows a clear error directing users to ZIP export instead
- **Publish Cleanup**: `.PROMPT.md` excluded from both ZIP exports and published deployments. Preview-only scripts (VFS Asset Interceptor, Console Capture) stripped from published HTML
- **Bug Fix**: Fixed duplicate console messages in the preview caused by React StrictMode double-mounting

## v1.42.0 - 2026-03-08

Multi-framework support — Svelte, Vue, and Preact join React as first-class project runtimes with in-browser SFC compilation, starter templates, and AI domain prompts. Plus publish output cleanup.

- **Svelte 5 Support**: `.svelte` single-file components compiled in-browser via the Svelte 5 compiler loaded from CDN (`esm.sh/svelte@5/compiler`). TypeScript in `<script lang="ts">` blocks is preprocessed — esbuild strips type annotations before the Svelte compiler sees the code, and the `lang="ts"` attribute is removed from the opening tag. CSS uses `css: 'injected'` mode so component styles are bundled automatically. Runes API (`$state()`, `$derived()`, `$effect()`, `$props()`) documented in the domain prompt
- **Vue 3 Support**: `.vue` single-file components compiled in-browser via `@vue/compiler-sfc@3` loaded from CDN. The compiler parses the SFC descriptor, compiles `<script setup>` blocks with inline templates, and injects `<style>` blocks as runtime `<style>` elements via a self-executing function. Bare `import { ... } from 'vue'` statements are rewritten to CDN URLs. Composition API (`ref()`, `reactive()`, `computed()`, `watch()`) documented in the domain prompt
- **Preact Support**: Lightweight React alternative (~3KB) with the same JSX pipeline as React — `jsxImportSource` set to `preact` for automatic JSX transform. Supports Preact signals (`@preact/signals`) for reactive state. Hooks imported from `preact/hooks`. No SFC compilation needed — uses standard `.tsx`/`.jsx` files
- **Runtime Registry**: New centralized `lib/runtimes/registry.ts` replaces scattered if/else chains. Each runtime declares its label, description, bundling config, JSX/SFC settings, source extensions, badge styling, and starter template ID. Helper functions: `getRuntimeConfig()`, `getProjectRuntimes()`, `getRuntimeBadge()`, `isRuntimeBundled()`. Badge colors: React sky-blue, Preact purple, Svelte orange, Vue green, Static gray
- **New Templates**: Three starter templates — Preact (`preact-starter`), Svelte (`svelte-starter`), and Vue (`vue-starter`). Each includes an `index.html` shell with `bundle.js`/`bundle.css` references, a framework-specific entry point (`main.tsx` or `main.ts`), a root component with a counter example, and a `.PROMPT.md` with framework-specific AI instructions
- **Template Registry**: New `lib/vfs/templates/registry.ts` consolidates all built-in template metadata (10 templates across 5 runtimes) into a single registry with `BuiltInTemplateMetadata` interface. Helper functions `getBuiltInTemplate()`, `getBuiltInTemplateIds()`, and `getBuiltInTemplatesForRuntime()` replace the previous ad-hoc template lookups
- **Domain Prompts**: New `getDomainPrompt(runtime)` function in `lib/llm/prompts/index.ts` returns framework-specific AI instructions. Each prompt covers the framework's component model, state management, template syntax, file structure conventions, and CDN import patterns. Used to seed `.PROMPT.md` when creating blank projects
- **VFS Type Support**: `.svelte` and `.vue` added to `SUPPORTED_EXTENSIONS` and `getSpecificMimeType()` — without this, VFS rejects file creation for these extensions. `isBundleableSource()` updated to recognize both extensions for bundle filtering
- **CDN Compiler Loading**: Shared `loadCdnCompiler()` utility with in-memory cache ensures each framework compiler is fetched from esm.sh only once per session. Uses a `new Function('url', 'return import(url)')` wrapper to bypass Next.js bundler interception of dynamic imports
- **esbuild Build Error Piping Fix**: `esbuild.build()` throws an exception on build failures instead of returning errors in the result. Previously this exception propagated up through `bundleProject()` → `runBundleStep()` → `compileProject()`, where it was caught by the preview component — but `commitCompilation()` never ran, so the compile-errors buffer stayed empty and the AI never got feedback. Fix: `bundleProject()` now catches the thrown error, extracts structured errors from `buildError.errors`, and returns them in the `BundleOutput`. Additionally, `compileProject()` wraps its body in `try/finally` so `commitCompilation()` is guaranteed to run even on unexpected exceptions
- **TypeScript IntelliSense**: Updated to be runtime-aware — JSX language service configuration only activates when the runtime has a `jsxImportSource` (React, Preact), not unconditionally for all bundled runtimes
- **Cleaner Published Bundles**: esbuild module boundary comments (`// vfs:/src/App.tsx`, `// ../src/main.tsx`) are stripped from compiled `bundle.js` output. CSS source files under `src/` are excluded from published deployments since they're already compiled into `bundle.css`. `shouldExcludeFromExport()` extended to also exclude `.svelte` and `.vue` source files
- **Conditional Edge Function Interceptor**: The fetch/XHR interceptor script that routes requests to edge function endpoints is now only injected into published HTML when the project actually has enabled edge functions — previously it was injected unconditionally for all deployments
- **Vision Detection from Model Discovery**: Vision/image support detection now checks cached model data from provider APIs (OpenRouter, HuggingFace) before falling back to name-based heuristics. Models like Qwen3.5 that support vision natively without "VL" in the name are now correctly detected, enabling image drop/paste in the chat panel
- **Starter Template Rename**: Framework starter templates renamed to "Starter (React + TypeScript)", "Starter (Preact + TypeScript)", "Starter (Svelte)", "Starter (Vue)" for clarity. Counter examples removed from Svelte and Vue starters — all starters now provide just the minimal correct structure (Hello World)
- **Bug Fix: curl VFS Command Protocol**: `curl localhost:3000` now works without requiring `http://` — the protocol is auto-prepended when missing
- **Bug Fix: LLM "read" Tool Calls**: Models that assume a `read` tool exists (common with tool-use-trained models) no longer get "Unknown tool" errors. `read`, `read_file`, `file_read`, `view`, and `view_file` are automatically routed to `cat` via the shell, eliminating wasted round trips

## v1.41.0 - 2026-03-07

React/TypeScript support via in-browser esbuild-wasm bundling, Server Mode deployment for React projects, runtime badges, and sync dialog UX improvements.

- **React + TypeScript Support**: Projects with `.tsx`/`.ts`/`.jsx` source files are now automatically bundled via esbuild-wasm in the browser. The bundler lazy-loads only when a project contains a recognized entry point (`/src/main.tsx`, `/src/index.tsx`, etc.) — existing HTML/CSS/JS projects never load it. Bare npm imports (e.g. `import { useState } from "react"`) are rewritten to esm.sh CDN URLs and fetched by the browser at runtime — no npm or node_modules needed
- **New Template: React + TypeScript**: Minimal starter — `index.html` shell, `src/main.tsx` entry point, and a bare `App.tsx` with just a Hello World component. Designed as a blank canvas so the AI builds from scratch instead of reworking demo code. Includes `.PROMPT.md` that guides the AI to write TSX components, use CDN imports for npm packages, and follow the `/src/` directory structure
- **New Template: React Demo — Task Tracker**: Interactive task tracker showcasing React components, state, and props — `App.tsx` with `useState`, `TaskForm.tsx` (controlled input + form submit), `TaskItem.tsx` (checkbox toggle, delete), and `App.css`. Ships with 3 sample tasks so users see a working app immediately. Demonstrates component composition, typed props, event handling, and conditional rendering in a compact package
- **esbuild-wasm Integration**: New `lib/preview/esbuild-bundler.ts` module encapsulating all esbuild-wasm interaction — lazy WASM initialization (singleton, browser-cached), VFS resolver plugin with extension probing, and CSS/JSON import support. The bundler produces `/bundle.js` and optionally `/bundle.css` which the existing 3-pass preview pipeline processes unchanged. On Node.js (Server Mode publish), esbuild-wasm auto-initializes without `initialize()` — the browser-only `wasmURL`/`wasmModule` options are skipped
- **Server Mode: React Deployment**: React projects now deploy correctly in Server Mode. Three fixes: (1) `detectBundleEntryPoint()` no longer returns `null` server-side — the `typeof window === 'undefined'` guard that blocked server-side bundling was removed; (2) `esbuild-wasm` added to `serverExternalPackages` in `next.config.ts` so Next.js doesn't bundle it into server chunks (which broke esbuild's internal path resolution); (3) `replaceAssetPathsWithDeploymentPrefix()` now rewrites root-level asset references (`/bundle.js`, `/bundle.css`) — previously only files in known subdirectories (`/styles/`, `/scripts/`, etc.) were prefixed with the deployment path
- **VFS Type Support**: `.ts` and `.tsx` added to `SUPPORTED_EXTENSIONS` (under the `js` category) and `getSpecificMimeType()`. This is the gate-keeper change — without it, VFS rejects `.tsx` file creation entirely. Monaco editor already had ts/tsx syntax highlighting
- **Build Error Feedback**: esbuild errors flow through the existing `pushCompileError()` → `drainCompileErrors()` pipeline so the AI receives build error feedback and can self-correct. `formatCompileErrors()` detects `[esbuild]`-prefixed errors and uses a build-specific message instead of the Handlebars-oriented one
- **ZIP Export for React Projects**: Exported ZIPs include both compiled output (`bundle.js`, `bundle.css`, `index.html`) and raw source files (`.tsx`, `.css`). A `package.json` (with react, vite, typescript deps) and `vite.config.ts` are injected so users can continue development locally with `npm install && npm run dev`
- **Runtime Badges**: Project cards and template cards now show a runtime badge indicating "Static" or "React". On project cards: overlaid on the thumbnail in grid view, next to the title in list view. On template cards: in the tags row alongside the existing "Backend" badge. React badges use a sky/blue color scheme; Static badges use a neutral gray with visible border
- **Template Card: Backend Badge Relocated**: The "Backend" badge on template cards moved from the title row to the tags/footer area for visual consistency with the new runtime badge
- **Sync Dialog: Non-Disruptive Refresh**: After push/pull operations in the Server Sync dialog, the item list no longer flashes. Initial load still shows a full-screen spinner; subsequent refreshes keep the list visible with a semi-transparent overlay spinner. Prevents the jarring content replacement that occurred after every sync operation
- **Bug Fix: Publish Button State**: The publish API response was missing `lastPublishedVersion`, so the deployment card always showed "Publish Deployment" instead of "Republish" after a successful publish. The field is now included in the response
- **TypeScript IntelliSense for React Projects**: New `useTypescriptIntelliSense` hook configures Monaco's TypeScript language service when `runtime === 'react'`. Three concerns: (1) compiler options (`jsx: ReactJSX`, `target: ES2020`, `moduleResolution: NodeJs`, etc.), (2) React 19 type definitions fetched from jsdelivr CDN and cached per session via `Promise.allSettled`, (3) project file sync — all `.ts/.tsx/.js/.jsx` files registered as extra libs for cross-file import resolution, updated on `filesChanged` events (debounced 300ms). `MultiTabEditor` now receives a `runtime` prop and uses the `path` prop on `@monaco-editor/react` to create per-tab models with proper URIs for import resolution. All IntelliSense state cleans up automatically when switching to a static project
- **Bug Fix: Analytics CORS**: Replaced `navigator.sendBeacon()` with `fetch()` + `keepalive: true` in both the telemetry tracker and the deployment analytics script. `sendBeacon` implicitly sends with `credentials: 'include'`, which is incompatible with the server's `Access-Control-Allow-Origin: *` header — causing CORS preflight failures on HF Spaces
- **Project Settings Modal**: The "Backend" button in the workspace header is now "Project" and opens a "Project Settings" modal. A new "General" tab (always accessible, even in browser mode) lets users change the project runtime (Static / React) and preview entry point after creation. The 5 backend tabs (Functions, Helpers, Secrets, Schedules, Schema) remain but are individually gated — in browser mode each shows a "Server Mode Required" message instead of a single lock screen blocking the entire modal. The backend enabled/disabled toggle only appears in Server Mode

## v1.40.0 - 2026-03-07

Local inference improvements and code cleanup.

- **New Provider: llama.cpp**: Run GGUF models locally with `llama-server`. OpenAI-compatible at `localhost:8080`, supports streaming, tool use, and vision (via multimodal projector). No API key required — model discovery via `/v1/models`
- **Local Tool Fallback**: When a local model doesn't support native function calling, the tool-use fallback (JSON-based prompting) now applies to all local providers (Ollama, LM Studio, llama.cpp) — previously only triggered for Ollama
- **Default Model Consolidation**: The per-provider default model mapping was duplicated between the API route and config manager with stale values drifting apart (`claude-3-5-haiku` vs `claude-haiku-4-5`, `gemini-1.5-flash` vs `gemini-2.5-flash`). Extracted to a single `getDefaultModel()` in the provider registry
- **Telemetry Version Fix**: `getAppVersion()` was returning a hardcoded fallback string that went stale each release. Now reads directly from `package.json` — single source of truth, no manual bump needed

## v1.39.0 - 2026-03-05

Two new providers (MiniMax, Zhipu AI), Gemini rebuilt from scratch, and streaming parser improvements for thinking/reasoning display.

- **New Provider: MiniMax**: 5 models — M2.5, M2.5 Highspeed (~100 tps), M2.1, M2.1 Highspeed, and M2. All have 200K context, 128K max output, streaming, and tool calling. Built-in reasoning (always-on, no toggle). Pay-as-you-go from $0.30/$1.20 per 1M tokens, or coding plans from $10/mo
- **New Provider: Zhipu AI (GLM)**: 6 models — GLM-5, GLM-4.7, GLM-4.7 Flash (free), GLM-4.6, GLM-4.6V (vision), and GLM-4.6V Flash (vision, free). Up to 200K context. Supports streaming, tool calling, vision, and thinking mode. Pay-as-you-go from $0.60/$2.20 per 1M tokens, or coding plans from $3/mo
- **Streaming: Thinking/Reasoning Display**: The streaming parser now handles three provider-specific reasoning formats — `reasoning_content` field (Zhipu), inline `<think>` tags in content (MiniMax, Ollama thinking models), and `reasoning` field (DeepSeek via OpenRouter). All are routed to the collapsible thinking section instead of appearing as regular assistant text. A state machine handles `<think>` tags split across chunks, and auto-closes unclosed blocks when tool calls arrive
- **Gemini: Full Rebuild**: The Gemini provider was non-functional — the server was sending OpenAI-format requests to Gemini's native API. Rebuilt with a dedicated transformation layer: messages converted to Gemini's `contents`/`parts` structure, system messages extracted to `system_instruction`, vision content mapped to `inline_data`, and streaming routed to the correct `streamGenerateContent?alt=sse` endpoint. Generation, streaming, vision, tool use, and thinking all work correctly now
- **Gemini: Dynamic Model Discovery**: The model selector now queries Gemini's live API instead of returning a hardcoded list. Fallback models updated from retired 1.5-era to current: Gemini 2.5 Flash (1M context, 65K output), 2.5 Pro, and 2.0 Flash
- **Default Model Updates**: Retired model defaults replaced — Gemini 1.5 Flash → 2.5 Flash, Claude 3.5 Haiku → Claude Haiku 4.5
- **Bug Fix: Zhipu/MiniMax Default Model**: `getProviderDefaultModel()` in ConfigManager was missing cases for the new providers, falling through to the default which returned a DeepSeek model ID
- **Bug Fix: Stream End ThinkTag Flush**: If a stream ended while the `<think>` tag parser had buffered a partial tag prefix (e.g. `<th`), that text was silently lost. Now flushed as content or reasoning on stream end
- **Bug Fix: Error Recovery Tool Call**: The stream parser's error recovery guard required at least one finalized tool call before attempting to salvage an in-progress tool call. Removed the guard so the first tool call is also recovered
- **Bug Fix: Ollama Fallback Headers**: Variable shadowing caused the Ollama tool-calling fallback to send an empty headers object instead of the properly built auth headers
- **Dead Code Removal**: Deleted the `LLMClient` class (~590 lines) — the entire class was unused except for two static methods (`validateApiKey`, `getAvailableModels`), which are now standalone exports. Also removed unused `ProviderSettings` type, unused `icon` field on `ProviderConfig`, unused `DEBUG_TOOL_STREAM` variable, and unused `projectId` from stream parser options

## v1.38.0 - 2026-03-04

Shell `curl` command for inspecting compiled preview output, shell robustness improvements, new benchmark scenarios, and dead code cleanup.

- **Shell: `curl` Command**: New `curl localhost/[path]` command lets the AI (and users in the shell) fetch compiled HTML from the preview engine. Handlebars templates are compiled with partials and data.json resolved, so the output reflects what the browser preview shows. Supports `-s` (silent), `-I` (headers only), `-o FILE` (write to file). Path resolution follows preview conventions: `/` → `/index.html`, `/about` → `/about.html`, `/products/` → `/products/index.html`. The VFS Asset Interceptor script is stripped from output to keep it clean. Only localhost URLs are accepted. Plain `curl` is read-only (works in Chat mode); `curl -o` is a write operation (Code mode only). Listed in the system prompt under Shell commands for both modes
- **Shell: `||` Operator**: The shell now supports the `||` (OR/fallback) operator — `cmd1 || cmd2` runs the second command only if the first fails. Complements the existing `&&` (AND/chain) operator
- **Shell: Durable Redirect Stripping**: Replaced the inline regex filter (`/^2>/`) with a dedicated `stripBashRedirects()` function that walks the args array with an index. Handles both fused (`2>/dev/null`) and split (`2>` `/dev/null`) token forms — the split form previously left an orphaned `/dev/null` argument interpreted as a filename. Covers `2>`, `1>`, `&>`, their `>>` append variants, and `2>&1`. Won't false-positive on path arguments like `/2>file.txt`
- **Shell: Auto-Routing for Misrouted Tool Calls**: When the AI calls a shell command (like `cat`, `curl`, `grep`) as a standalone tool instead of routing through the shell tool, the tool registry now auto-detects this and executes the command through the shell. Previously this was a wasted round-trip with an "Unknown tool" error followed by a retry
- **Bug Fix: Token Estimate in Write Healing**: `estimateTokenCount(String(originalLength))` converted a char count like `5000` to the 4-character string `"5000"`, yielding `~1 token` regardless of content size. Replaced with direct `Math.ceil(originalLength / 4)`. The now-unused `estimateTokenCount` function was removed
- **Code Cleanup**: Removed dead `onCostUpdate` callback (25-line closure passed to streaming parser but never invoked), unused imports (`GenerationAPIService`, `GenerationUsage`, `VirtualFile`, `StreamResponse`), write-only `lastCheckpointId` field, vestigial `fileTree` parameter on `buildShellSystemPrompt`, 4 trivial pass-through wrappers in `string-patch.ts`, `generateSummary()` stub, no-op ternaries in `cp`, redundant `as string` casts, and dead `grep -r` flag. Fixed `||` operator re-executing the last command unnecessarily and variable shadowing in `stableStringify`
- **Benchmark: Preview Scenarios**: Three new test scenarios (`shell-curl`, `shell-curl-path`, `shell-curl-pipe`) under the `shell-preview` category validate that the AI can discover and use `curl` to inspect compiled Handlebars output. Setup includes templates with partials and data.json so assertions verify actual compilation, not raw source

## v1.37.0 - 2026-02-27

System prompt compression and reorganization of how project context reaches the AI model.

- **System Prompt Compression**: Base system prompt reduced from ~5,000 tokens to ~1,800 tokens (~48% reduction including tool definitions). Chat and code mode prompts no longer duplicate the preamble — shared sections extracted into `buildSharedPreamble(isReadOnly)`. File reading flowchart compressed to a 5-line preference list. Write tool section cut from 8 JSON examples to 3 examples + 7 rules; tool schema description reduced from 30 lines to compact one-liners. Evaluation section reduced from ~450 tokens to 3 lines; tool description updated from "Required before finishing work" to "Not needed for simple tasks". Shell tool description reduced from 40 lines to 3 lines. Server context sqlite3 examples reduced from 7 to 3, "COMMON MISTAKES" block removed, backend feature creation patterns compressed to 1-line-each with a `cat /.server/README.md` pointer. Emoji markers and prescriptive language (MUST/NEVER/CRITICAL) softened to direct instructions
- **Project Context in User Message**: Skills list and project file tree moved from the system prompt to the first user message. LLMs weight user messages more heavily than system prompts — these are project state, not behavioral instructions, so they belong closer to the user's request. The system prompt now contains only behavioral content: tool mechanics, `.PROMPT.md` domain instructions, and server context creation patterns. New `buildProjectContext()` export generates the context string; `buildDynamicContent()` consolidates the duplicated `.PROMPT.md` reading and server context loading that was previously copy-pasted between chat and code mode builders
- **Collapsible Project Context UI**: The injected project context no longer appears as raw text in the user's chat bubble. The orchestrator stores clean `displayContent` (user's actual prompt) and `projectContext` separately in `ui_metadata`. The chat panel renders a collapsed "Project context" indicator (click to expand) above the user message. Follows the same collapsible pattern used by tool calls, reasoning, and synthetic errors
- **File Creation Guidelines → Domain Prompt**: The 55-line "CREATE THESE / DON'T CREATE THESE" block moved from the base system prompt to `WEBSITE_DOMAIN_PROMPT` in `lib/llm/prompts/website.ts`. Base prompt retains only "Prefer editing existing files over creating new ones" — the domain-specific guidance now lives where it belongs
- **Bug Fix: Stream Usage Clobbering Header Cost**: When OpenRouter returned actual cost via the `x-openrouter-usage` header, a subsequent `json.usage` chunk in the SSE stream would overwrite `usageInfo` with a fresh object — silently dropping the `cost` and `isEstimated` fields. Now merges stream usage into the existing object with spread (`...usageInfo`) so header-derived cost data is preserved
- **Bug Fix: Noisy Cost Estimation Warnings**: The `[CostCalculator] Using estimated cost based on normalized tokens for OpenRouter` warning fired on every OpenRouter call where cost wasn't in headers — which is most calls. Downgraded to `debug`. The old message also referenced "Generation API for native token counts," a feature that was designed but never wired up
- **Log Level: VFS readFile**: `VFS: File not found for read` downgraded from `error` to `debug`. A missing file is an expected condition (e.g., write tool checks if a file exists before creating it) — callers decide whether it's a problem
- **Shell: Heredoc Support**: The shell tool now supports heredoc syntax (`cat > /file << 'EOF'\ncontent\nEOF`). The heredoc body is extracted before command parsing and piped as stdin to the command — works with `cat` + redirect for writing large files. Supports bare (`EOF`), single-quoted (`'EOF'`), and double-quoted (`"EOF"`) delimiters. This gives LLMs a reliable fallback when the write tool's JSON encoding struggles with large or quote-heavy content. Shell tool description and system prompt updated to document the syntax
- **Handlebars Error Feedback**: Handlebars template compilation errors from the preview now feed back to the LLM asynchronously. New `compile-errors.ts` accumulator module with begin/push/commit/drain lifecycle — VirtualServer pushes errors during `compileProject()` (both pattern-detected and runtime errors like `options.fn is not a function`), and the orchestrator drains them before the next LLM call with a 300ms wait for the debounced preview compilation to finish, injecting a synthetic user message so the LLM can self-correct. Errors are collated per-compilation: rapid recompiles replace rather than accumulate, so the LLM always sees the latest state. Replaces the earlier synchronous post-write `validateTemplate()` approach, which missed cross-file errors and added latency to every write
- **Write Tool: Double-Encoding Healing**: When the LLM sends `operations` as a stringified JSON string that fails to parse, the write tool now attempts 4 healing strategies before giving up: (1) direct parse, (2) fix literal newlines/tabs and retry, (3) JSON structure repair via `attemptJSONRepair()` for truncated brackets, (4) regex content extraction via `extractPartialContent()` for rewrite operations. Previously this was an immediate hard failure that left the LLM stuck in a retry loop. The final error message now also suggests the heredoc fallback

## v1.36.0 - 2026-02-26

Comprehensive benchmark overhaul with assertion-based validation, tool usage analytics, and self-evaluation tracking. Plus `wc` command for the shell.

- **Benchmark Rename**: "Model Tester" renamed to "OSWS Benchmark" across all UI — header, sidebar, project manager button, and info banners reworded to benchmark framing
- **Benchmark: Assertion System**: New programmatic assertion framework replaces the old validation approach. 11 assertion types: `file_exists`, `file_not_exists`, `file_contains`, `file_not_contains`, `file_matches`, `valid_json`, `tool_used`, `tool_args_match`, `output_matches`, `tool_output_matches`, and `judge` (LLM-evaluated). Test pass/fail is now determined by assertions, not just the model's self-evaluation
- **Benchmark: Tool Usage Analytics**: Top-level stats card shows total/successful/failed/invalid tool calls with a per-tool breakdown table (shell, write, evaluation). Invalid tool calls (model hallucinating tools like `read` or `cat` as standalone tools) counted separately
- **Benchmark: Cost & Token Tracking**: Stats cards show running totals for cost (USD), prompt tokens, completion tokens, and total tokens alongside pass rate, timing, and tool stats
- **Benchmark: Self-Evaluation Accuracy**: Tracks whether the model's `goal_achieved` self-assessment matches the assertion-determined result. Displayed as "Self-eval accuracy: X/Y" in track reports and exports — surfaces calibration issues where the model thinks it succeeded but assertions say otherwise
- **Benchmark: Tool Call Details**: Completed tests show an itemized list of every tool call — tool name, success/failure status, and argument preview. Failed tests show specific assertion failure details (e.g. "New title present — still contains Test App") instead of a generic message
- **Benchmark: Live Tool Output**: Generation output stream shows specific tool arguments in real-time (e.g. `[tool] shell — cat /index.html`) instead of the generic `[tool] shell ...`
- **Benchmark: Track Reports & Export**: Track reports include total cost, total tokens, per-tool breakdown, assertion pass rates, and self-eval accuracy. JSON and Markdown exports include the same
- **Shell: `wc` Command**: New `wc` command for counting lines, words, and characters. Supports `-l`, `-w`, `-c` flags and works with stdin via pipes — `find / -type f | wc -l` now works. Documented in system prompt for both Chat and Code modes

## v1.35.0 - 2026-02-25

Decoupled the AI system prompt from website-only output, added per-project `.PROMPT.md` for domain instructions, made the preview entry point configurable, and improved the AI shell tooling.

- **System Prompt Separation**: The monolithic system prompt is now split into a base prompt (tool mechanics, stays in code) and a domain prompt (website knowledge, lives in `.PROMPT.md` per-project). The base prompt no longer contains any website-specific instructions — platform constraints, Handlebars docs, and routing rules all moved out
- **`.PROMPT.md` Loading**: Both Code and Chat mode prompts now read `/.PROMPT.md` from the project's VFS at conversation start. If the file exists, its content is appended as domain instructions; if not, the AI operates with the base prompt only
- **Templates Include `.PROMPT.md`**: All 4 built-in templates (Barebones, Example Studios, Landing Page, Blog) now ship with `/.PROMPT.md` containing the website domain prompt — new projects get full website instructions out of the box
- **Missing `.PROMPT.md` Notification**: Existing projects without a `.PROMPT.md` file show a subtle amber banner at the bottom of the file explorer — click "Add" to create the default website prompt, or "Dismiss" to hide (persisted per-project in localStorage)
- **Configurable Entry Point**: New `previewEntryPoint` project setting — right-click any file in the explorer and choose "Set as Entry Point" to change which file the preview loads first. Defaults to `/index.html` when unset
- **File Explorer Indicators**: Entry point file shows a green Home icon with "(entry)" badge; `.PROMPT.md` shows an amber ScrollText icon with "(AI prompt)" badge
- **Template Rename: "Blank" → "Website Starter"**: The Blank template has been renamed to "Website Starter" to better describe its purpose. Internal ID (`blank`) is unchanged.
- **Tool Rename: `json_patch` → `write`**: The file editing tool presented to LLMs is now named `write` instead of `json_patch`. This is a pure identifier rename — all parameters, operation types (update, rewrite, replace_entity), and internal behavior are unchanged. The rename improves tool selection behavior by using a universally understood name that LLMs naturally gravitate toward, reducing wasted generation cost from incorrect tool choices.
- **Shell Pipes**: Commands can now be chained with `|` — stdout from the left command becomes stdin for the right. Supports multi-stage pipes: `cat /file.txt | grep pattern | head -n 5`. Commands that accept stdin: cat, head, tail, grep, rg, sed.
- **Generic Redirects**: All commands now support `>` (overwrite) and `>>` (append) to write stdout to a file. Previously only `echo` supported `>`. Now `grep -n div /index.html > /results.txt` and `sed 's/old/new/' /f.txt > /out.txt` work as expected.
- **sed Command**: New `sed` command for text substitution. Supports `s/pattern/replacement/[g]` syntax, `-i` for in-place editing, `-e` for multiple expressions, and stdin via pipes. Delimiters: `/`, `|`, `#`, `@`.
- **Repeat Helpers**: Added `{{#times N}}`, `{{#repeat N}}`, and `{{#for N}}` block helpers — all equivalent, repeat content N times with `index`, `first`, `last` context variables. Fixes persistent LLM-generated `{{#for}}` errors (e.g., star ratings). Documented in website prompt and handlebars-advanced skill.
- **Tool Call Analytics**: Expanded `tool_call` telemetry events with safe, whitelisted operation details — shell events now include the command name, pipe/redirect flags; write events include file extension and operation types; evaluation events include goal/continue status. All values are whitelisted to prevent accidental capture of file contents or user code.

## v1.34.0 - 2026-02-22

Major architectural restructure: backend features are now **project-scoped** and "Sites" have been renamed to **"Deployments"** throughout.

- **Sites → Deployments**: The "Site" concept is now "Deployment" everywhere — UI, API routes (`/api/sites/*` → `/api/deployments/*`), URL paths (`/sites/{id}/` → `/deployments/{id}/`), and admin views. Existing databases migrate automatically
- **Project-Scoped Backend**: Edge functions, server functions, secrets, and scheduled functions are now managed at the project level instead of per-deployment. On publish, features are extracted into the deployment's runtime — so one project can power multiple deployments
- **Per-Project Database**: Each project can have its own SQLite database for user-defined tables. Template schemas are applied on project creation; on publish, schema + data are extracted to the deployment runtime
- **Split Deployment Databases**: The old unified database is now split into `runtime.sqlite` (functions, secrets, user tables) and `analytics.sqlite` (pageviews, sessions) per deployment. Automatic migration on first access
- **"Server Features" → "Backend"**: The umbrella term renamed to "Backend" in all UI labels, toolbar buttons, template badges, and docs
- **Project Backend Panel**: New tabbed modal for managing backend features at the project level — edge functions, server functions, secrets, scheduled functions, and a rewritten schema editor with Tables, SQL, and DDL tabs
- **Deployment Selector**: New dropdown in the workspace header to choose which deployment's runtime context the AI should be aware of
- **Project Swap**: When repointing a deployment to a different project, a conflict analysis dialog shows added/removed/changed features so you can review before confirming
- **Template Unification**: Removed the separate "Site template" type — all templates now use a single format with an optional `backendFeatures` field. Older `.oswt` files with the legacy `serverFeatures` key still import correctly
- **Security**: Sync API no longer returns secret values in GET responses; deployment ID format validated before database path interpolation

**Upgrading (Server Mode):** Back up your `data/` and `sites/` directories before updating. This release runs automatic migrations that rename `sites/` to `deployments/` and split unified databases into `runtime.sqlite` + `analytics.sqlite`. Browser Mode users are unaffected.

## v1.33.0 - 2026-02-19
- **Checkpoint System Rework**: New checkpoint panel and redesigned checkpoint lifecycle
  - New "Checkpoints" panel in the workspace — view, jump to, and restore any checkpoint from the session
  - Opening a project creates an immutable "Starting point" checkpoint (`system` kind) that persists for the entire session
  - Multiple manual save checkpoints now supported — saves accumulate instead of replacing each other
  - "Discard Changes" always reverts to the session starting point, not the last save
  - Global limit (50) applies only to auto-checkpoints; manual and system checkpoints are never evicted
- **QoL**: Default provider configurable via `NEXT_PUBLIC_DEFAULT_PROVIDER` env var (used by HF deployment)
- **QoL**: Chat input disabled when no credentials configured; model selector button highlights to guide setup

## v1.32.0 - 2026-02-18
- **Anonymous Telemetry**: Client-side usage analytics via [osw-analytics](https://github.com/o-stahl/osw-analytics)
  - Events: session, pageview, heartbeat, provider/model selection, task lifecycle, tool calls, API errors
  - Random anonymous visitor ID (localStorage) for unique visitor counts — no cookies, no fingerprinting
  - Batched payloads via `fetch` with `sendBeacon` fallback on page unload
  - Opt-out toggle in Settings, first-run disclosure dialog, env kill switch (`NEXT_PUBLIC_TELEMETRY_ENABLED=false`)

## v1.31.2 - 2026-02-16
- **Fix**: HF OAuth switched to client-side PKCE via `@huggingface/hub` — no server routes, no cookies, token exchange happens entirely in browser
- **Cleanup**: Removed server-side OAuth routes (login, callback, status, disconnect) and cookie helper

## v1.31.1 - 2026-02-16
- **Bug Fix**: Fixed HF OAuth 401 — HttpOnly cookies silently dropped on HF Spaces; tokens now stored in localStorage via URL fragment
- **Bug Fix**: Fixed OAuth redirect using internal container hostname instead of public URL
- **Improvement**: Token exchange uses Basic auth header; callback validates inference scope before storing
- **Improvement**: HTML error responses from providers sanitized to clean messages
- **Security**: Codex provider hidden on HF Spaces (refresh token too sensitive for localStorage)

## v1.31.0 - 2026-02-15
- **HuggingFace Provider**: New AI provider with free inference tier ($0.10/month free credits)
  - Two auth methods: OAuth (HF Spaces only) and API key (everywhere)
  - Dynamic model discovery — 120+ models with metadata (context length, tool support, vision, pricing)
  - Full cost tracking integrated with session and project cost calculations
  - Credit exhaustion detection with friendly error message
- **UI Overhaul — Model Settings & Settings Popups**: Visual refresh of both settings popups
  - Model Settings: inline model list with search, separate chat model toggle, cleaner section layout
  - Settings: segmented theme selector, streamlined cost tracking, card-style data management
  - Unified connection badge for all providers — HuggingFace, Codex, and API key providers all show a consistent connected/disconnected state
  - API key providers (OpenRouter, OpenAI, Anthropic, Google, Groq, SambaNova) now validate keys on connect instead of saving on every keystroke
- **Bug Fix**: Fixed model selector dropdown extending beyond viewport

## v1.30.0 - 2026-02-14
- **Codex Generation**: The "Codex (ChatGPT Sub)" provider now supports full generation — streaming responses, tool calls (shell, json_patch), and usage-limit error handling
  - Server-side adapter (`lib/llm/codex-adapter.ts`) converts between Chat Completions and Codex Responses API formats
  - Uses `@spmurrayzzz/opencode-openai-codex-auth` for JWT decode, header construction, model normalization, and error parsing
  - No client-side changes — the streaming parser, orchestrator, and UI work unchanged
- **Model List**: Available models: `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1`, `gpt-5-codex`, `codex-mini-latest`; future model IDs are passed through without normalization
- **Codex Error Handling**: Usage limit errors show a clear message with estimated retry time
- **UI**: Codex auth panel layout tightened — "Disconnect" button inline with connection status; security/stability warning banner added
- **Codex Auth**: Refresh token stored in HttpOnly cookie (`osw_codex_rt`), not localStorage — JS never has access to it
  - Server routes handle connect, disconnect, status check, and token refresh (`/api/auth/codex/*`)
  - Client stores only `access_token`, `expires_at`, and `user_email` in localStorage
  - `CLIENT_ID` and refresh token kept server-side only
- **Bug Fix**: Fixed parallel tool call status indicators going to the wrong tool (spinners stuck on completed tools)
  - Root cause: batch-based tracking assumed one `toolCalls` event per batch, but the streaming parser emits one event per tool — so `tool_status` looked up the wrong tool
  - Replaced batch/index Map with a flat per-iteration array; `tool_status` and `tool_result` now use direct index lookup
- **Bug Fix**: Fixed `tool_param_delta` events not coalescing when parallel tools stream interleaved with `toolCalls` events
  - Coalescing now searches backward through the last 4 events for a matching type instead of only checking the last event

## v1.29.0 - 2026-02-13
- **User-Managed Thumbnails**: Replaced automatic screenshot capture with user-initiated controls
  - Camera button (capture) and upload button on project cards, site cards, and the workspace preview toolbar
  - Remove button (X) on hover for cards that already have a thumbnail
  - Removed fire-and-forget screenshot on project save
  - Removed automatic thumbnail capture after site publish
- **New Component**: `ThumbnailArea` — reusable thumbnail widget with capture, upload, and remove states (`sm`/`md` sizes)
- **New Utility**: `captureProjectScreenshot()` — compiles project in a hidden iframe and captures a screenshot on demand
- **Refactored**: `captureSiteScreenshot()` now returns a base64 data URL instead of uploading directly; callers handle persistence
- **New Utility**: `compressImage()` — resizes uploaded images to max 640×360 JPEG, retries at lower quality if over 100KB
- **API**: Site thumbnail endpoint now accepts `null` to clear thumbnails
- Thumbnail area stops event propagation so button clicks don't navigate to the workspace
- **Bug Fix**: Fixed edge function calls from the preview not being intercepted when a site is selected after initial render
- **Bug Fix**: Fixed `ls /.server/` returning empty — transient subdirectories were not synthesized as directory entries
- **Bug Fix**: Added missing scheduled function handlers to `createServerContextFile()` and `updateServerContextFile()`
- **Improvement**: Server context in the file explorer now auto-refreshes after AI operations
- **Improvement**: Edge function route now resolves sites by slug in addition to UUID
- **Improvement**: AI system prompt and skills now instruct the AI to use simple fetch paths in client code
- **Improvement**: File explorer race condition guard for concurrent `loadFiles` calls

## v1.28.0 - 2026-02-10
- **Scheduled Functions**: Run edge functions on cron schedules via the new Schedules tab in Server Settings
  - Create, edit, enable/disable, and delete scheduled functions from the admin UI
  - Standard 5-field cron expressions with timezone support
  - Custom JSON config passed as request body to the linked edge function
  - Execution tracking: next run time, last status (success/error), last run time
  - AI integration: scheduled functions visible in `/.server/scheduled-functions/` context and documented in the `server-functions` skill
- **Server Context**: AI system prompt now includes scheduled function count and creation instructions

## v1.27.0 - 2026-02-06
- **Site Templates**: New template type that bundles frontend files AND backend infrastructure
  - Edge functions, server functions, database schema, and secrets metadata in one `.oswt` file
  - Template format v2.0 with `siteFeatures` object for backend definitions
  - Type filter (All, Project, Site) and badges in template browser
- **Built-in Site Templates**: Two new site templates:
  - **Landing Page with Contact Form** - Professional landing page with Resend email integration, contact form edge functions, and message database
  - **Blog with Comments** - Blog platform with static HTML posts, Handlebars partials, comment system edge functions, and content moderation
- **Automatic Backend Provisioning** (Server Mode): Creating a project from a site template automatically syncs to server, creates a site, and provisions all backend features (database schema, edge functions, server functions, secret placeholders) in one bulk request
- **Export from Sites**: Export any published site as a site template from the Sites view; backend features are automatically captured
- **Graceful Degradation**: Site templates work in Browser Mode (frontend files only); toast notification about Server Mode for backend features
- **Improved Blog Template**: Blog posts are now static HTML pages with Handlebars partials instead of dynamically loaded from the database; post links work correctly under `/sites/{siteId}/`
- **Async Edge Functions**: Edge functions now support `await` (async IIFE wrapper in QuickJS executor) for calling external APIs
- **Improved Edge Function Errors**: Proper error message extraction from QuickJS error objects instead of generic failures
- **Bug Fix**: Static builder missing `fileExists()` in VFS wrapper — Handlebars `data.json` context not loaded during publish
- **Bug Fix**: IndexedDB `init()` race condition — async function was not returning its promise, causing "not initialized" errors

## v1.26.1 - 2026-02-06
- **Bug Fix**: Fixed server sync pull failing when project doesn't exist locally
  - `vfs.getProject()` threw instead of returning null, crashing the pull flow
  - New projects pulled from server were created with a new ID, orphaning synced files
  - `createProject` now accepts an optional ID parameter to preserve server project IDs

## v1.26.0 - 2026-02-04
- **Improved Screenshot Reliability**: Thumbnails now capture fully-loaded content
  - New resource-waiting layer: waits for fonts, images, and browser idle before capture
  - Site publish thumbnails wait ~2.5s minimum (up from 500ms) for resources to load
  - Project save no longer blocks on screenshot — save completes instantly, thumbnail updates in background
  - Spinner overlay shown on site card thumbnail during publish
- **Change Source Project** (Server Mode): Site settings now allow swapping the source project via a dropdown on the General tab, with a warning that it may break the published site
- **Sidebar Version Display**: Application version and mode now shown in sidebar below the app name

## v1.25.2 - 2026-02-03
- **Bug Fix**: Fixed binary file sync and serving in Server Mode
  - Sync now properly serializes ArrayBuffer content to base64 before JSON transport
  - Sites route correctly serves binary files without UTF-8 corruption
  - Handles data URL format (`data:image/...;base64,...`) in both SQLite adapters
- **Bug Fix**: Fixed Model Tester link not navigating correctly from sidebar
- **Docs**: Added comprehensive VPS Deployment Guide with security hardening

## v1.25.1 - 2026-02-03
- **Bug Fix**: Fixed binary files (JPG, PNG, GIF, etc.) not publishing correctly in Server Mode
  - SQLite adapter now properly decodes base64 content back to ArrayBuffer when reading image/video files

## v1.25.0 - 2026-02-02
- **(Optional) Skill Evaluation Pass**: Pre-flight relevance check on the user message before main LLM call
  - Non-streaming call using the selected model determines which skills match the user's prompt
  - Matched skills are injected as explicit directives in the user message for higher adoption
  - 5s timeout with silent fallback on any failure
  - New `skill_evaluation` debug event in the debug panel
  - Toggle in Skills tab (disabled by default)
- **Non-Streaming API Support**: `/api/generate` route now respects `stream: false` parameter
  - Returns JSON response directly instead of SSE stream when streaming is disabled
  - Enables lightweight API calls without stream parsing overhead

## v1.24.0 - 2026-01-26
- **Vision/Image Input Support**: Drop or paste images into the chat input on supported models
  - Supported formats: PNG, JPEG, WebP, GIF
  - Multi-provider support: OpenRouter, OpenAI, Anthropic, Gemini, Ollama (llava models)
  - Image thumbnails shown in chat input with remove button
  - Visual drop indicator when dragging images
  - Automatic model capability detection (GPT-5.x, Claude Opus 4.5, Gemini 3, GLM-4.7V, llava, etc.)
  - Images displayed in chat history at 60px height in a flex container
- **Dismissable Toasts**: All toast notifications now have a close button
- **Bug Fix**: Fixed orchestrator exiting prematurely without evaluation due to stale state
- Updated Next.js to 15.5.9
- Added defensive null checks in sync API routes

## v1.23.0 - 2026-01-18
- **Enhanced Server Sync Modal** (Server Mode): Redesigned sync dialog with granular control
  - Tabbed interface for Projects, Skills, and Templates (previously only projects synced)
  - Per-item sync status badges showing: Synced, Local Newer, Server Newer, Conflict, Local Only, Server Only
  - Hover tooltips explaining each status and recommended actions
  - Individual push/pull buttons per item for precise control
  - Bulk selection with "Select All" and batch push/pull operations
  - Summary bar showing status counts per category
- **Skills & Templates Sync** (Server Mode): Full sync support for custom skills and templates
  - New API endpoints: `/api/sync/skills`, `/api/sync/templates` with individual item routes
  - Skills (localStorage) and templates (IndexedDB) now sync with SQLite server storage
  - Sync metadata tracking: `lastSyncedAt`, `serverUpdatedAt` for three-way comparison
- **Security**: Updated Next.js to 15.3.8 (CVE-2025-55182)

## v1.22.1 - 2026-01-11
- Fixed Server Mode setup docs to match `.env.example`
- Removed unused bcryptjs dependency
- Fixed redirect on new version going to What's New instead of Dashboard

## v1.22.0 - 2026-01-10
- **QuickJS WASM Sandbox**: Upgraded function executor from Node.js VM to QuickJS WebAssembly
  - Edge and server functions now run in isolated WASM sandbox
  - Memory limits enforced by WASM (64MB default)
  - Execution time limits with interrupt handler
  - No access to Node.js APIs (process, require, fs, etc.)
  - Same API surface: `db`, `secrets`, `Response`, `console`, `server`, `fetch`, `atob`, `btoa`
- **Fetch API with Security Controls**: External HTTP requests from functions
  - Max 10 requests per execution
  - 10 second timeout per request
  - 5MB max response body
  - Protocol allowlist: only `http://` and `https://`
  - Private IP blocking in production (localhost, 10.x, 172.16-31.x, 192.168.x, 169.254.x)
  - Development mode allows local requests for testing
- **Base64 Encoding**: Added `atob()` and `btoa()` functions for base64 encode/decode

## v1.21.0 - 2026-01-10
- **Dashboard for Browser Mode**: Dashboard now available in browser mode (previously server mode only)
- **Dashboard as Landing Page**: Dashboard is now the default landing page for both modes
- **Quick Actions Bar**: Create projects, start guided tour, join Discord, and access docs from dashboard
- **What's New Component**: Shows latest version highlights with link to full changelog
- **Recent Projects**: Quick access to recently updated projects from dashboard

## v1.20.0 - 2026-01-08
- **Admin Dashboard** (Server Mode): New landing page after login with server stats and traffic metrics
  - System info: OSWS version, Node.js version, uptime, memory usage
  - Content stats: Projects, templates, skills, total files counts
  - Hosting stats: Published sites, sites with databases, storage used
  - Traffic monitoring: Requests per hour/day, error counts, top sites, recent errors
  - Manual refresh button (no polling overhead)
- **Request Logging**: Lightweight server-side logging for published site traffic
  - Logs site requests to `request_log` table in core database
  - Anonymized IP hashing for privacy
  - Fire-and-forget async inserts (no response latency impact)
  - Automatic 7-day log retention cleanup
- Fixed admin routes (`/admin/*`, `/api/admin/*`) being accessible in Browser mode

## v1.19.5 - 2026-01-07
- Fixed binary file sync causing "Too few parameter values" error (ArrayBuffer becomes {} in JSON)

## v1.19.4 - 2026-01-07
- Fixed VPS deployment docs missing standalone mode static file copy step
- Fixed "Too few parameter values" error in SiteDatabase (mimeType/size null coalescing)

## v1.19.3 - 2026-01-07
- Fixed static site path rewriting for navigation links and root "/" href

## v1.19.2 - 2026-01-07
- Fixed admin login not redirecting after successful authentication
- Fixed file sync failing with "Too few parameter values" error for legacy files

## v1.19.1 - 2026-01-06
- System prompt now recommends `json_patch` over `echo` for creating server functions/edge functions
- Added `SECURE_COOKIES` environment variable to allow insecure cookies for pre-SSL VPS setup

## v1.19.0 - 2026-01-03
- **Server Mode Backend Features**: Complete backend functionality for published sites
  - **Edge Functions**: REST API endpoints with JavaScript runtime
    - Create JavaScript API endpoints for published sites (GET, POST, PUT, DELETE, ANY)
    - Database access via `db.query()` and `db.run()` with parameterized queries
    - External API calls with `fetch()`
    - Isolated execution via Node.js VM contexts with configurable timeouts (1-30 seconds)
    - Access to secrets via `secrets.get()`, `secrets.has()`, `secrets.list()`
  - **Server Functions (Helpers)**: Reusable JavaScript code callable from edge functions
    - Define shared logic once, use across edge functions via `server.functionName()`
    - Same security model as edge functions with full `db` and `fetch` access
  - **Secrets Management**: Encrypted storage for API keys and tokens
    - AES-256-GCM encryption with unique IVs per secret
    - Admin-only access, values never logged or returned in API responses
    - AI can create secret entries, user sets values via admin UI
  - **SQL Editor**: Execute raw SQL queries with Monaco editor and query history
  - **Schema Viewer**: Browse database structure with expandable table/column tree
  - **Execution Logs**: Automatic logging of function invocations with status, duration, timestamps
- **Server Context Integration** (Experimental): AI awareness of site backend features
  - Site Selector dropdown in workspace header to choose site context
  - `/.server/` hidden folder with transient files containing server context
  - AI receives edge functions, database schema, server functions, and secret names
  - Hidden folder icons: purple book for `/.skills/`, orange server for `/.server/`
- **AI Read-Write Access to Backend Features**:
  - `sqlite3` shell command for executing SQL queries on site database
    - Supports `-json` and `-header` output flags
    - System tables protected from modification
  - Edge functions writable via `json_patch` on `/.server/edge-functions/*.json`
  - Server functions writable via `json_patch` on `/.server/server-functions/*.json`
  - Function files use JSON format with metadata (name, method, enabled, code, etc.)
- **Edge Function Routing for Published Sites**: Automatic client-side routing
  - Lightweight interceptor script (~1.5KB) injected into published HTML
  - Intercepts `fetch()` and `XMLHttpRequest` calls to paths without file extensions
  - Routes requests to `/api/sites/{siteId}/functions/{path}` automatically
  - Form submissions with edge function actions intercepted and sent as JSON
  - Custom events: `edge-function-response` and `edge-function-error`
  - Zero server overhead for static files - only edge function calls hit the server
- **Preview Edge Function Support**: Test edge functions in preview before publishing
  - VirtualServer accepts optional siteId parameter
  - VFS interceptor routes edge functions in preview iframe
- **System Prompt Enhancements**: Comprehensive server feature guidance
  - sqlite3 usage examples with proper quoting and common mistakes to avoid
  - Function creation, editing, and deletion patterns
  - JSON format documentation for edge and server functions
- **Bug Fix**: Fixed system prompt being appended on every follow-up message (~8k extra tokens per message)

## v1.18.0 - 2025-12-11
- **SQLite Migration**: Replaced PostgreSQL with SQLite (better-sqlite3) for Server Mode
  - No external database setup required - just `npm install && npm start`
  - Simpler self-hosting with zero configuration
- **Per-Site Database Architecture**: Each site now has its own SQLite database
  - `data/osws.sqlite` - Core database (projects, templates, skills)
  - `sites/{siteId}/site.sqlite` - Per-site database (files, settings, analytics)
- **Memory Leak Fix**: Reduced memory usage during long AI sessions
- **Removed**: PostgreSQL support - `DATABASE_URL` environment variable no longer used
- **Breaking Change**: Existing PostgreSQL Server Mode deployments must migrate data manually

## v1.17.0 - 2025-12-03
- **Reasoning Token Support**: Display reasoning/thinking from compatible models
  - Anthropic extended thinking, DeepSeek R1, Gemini thinking models
  - Separate reasoning tracking with `reasoning_delta` events and coalescing
  - Collapsible reasoning display in chat panel
- **Reasoning Toggle**: Enable/disable reasoning per model in settings
- **Malformed Tool Call Detection**: Auto-detect and correct when model writes tool syntax as text instead of using function calling
- **UI Improvements**:
  - Renamed "Thinking..." to "Waiting for response..." for clarity
  - Fixed "Thinking..." indicator persisting after response completes

## v1.16.0 - 2025-11-23
- **Server Mode (Optional)**: PostgreSQL-backed deployment mode for persistent storage and multi-device access
  - Browser Mode remains the default (IndexedDB, client-side only, no backend required)
  - Server Mode adds PostgreSQL persistence, admin authentication, and sites publishing
  - Automatic database setup (no manual migrations)
  - Bookmarkable URLs for all pages (`/admin/projects`, `/admin/sites`, etc.)
  - Admin login with password protection (24-hour sessions)
- **Published Sites Management**: Create and host static sites directly from your projects
  - New dedicated "Sites" view with search, sort, and filtering
  - Publish projects to live URLs with one click
  - 6 configuration tabs: General, Scripts, CDN, Analytics, SEO, Compliance
  - Custom domain support with automatic HTTPS URLs
  - "Under Construction" mode with placeholder page
  - Status badges: "Live", "Pending Changes", "Under Construction", "Compliance Enabled"
  - Copy site URL to clipboard from context menu
  - Automatic sitemap.xml and robots.txt generation
- **Compliance/Cookie Consent**: GDPR-ready cookie consent banners
  - Opt-in or opt-out consent modes
  - Customizable position (6 locations), button style (pill/rounded/square), and text
  - Privacy policy and cookie policy links
  - Dark mode support and responsive design
- **Sites Publishing Features**: Configure published sites with advanced options
  - Inject custom scripts (head/body) for analytics, tracking, or functionality
  - Add external CDN resources (stylesheets, scripts)
  - Privacy-focused analytics (no cookies, IP anonymization, LocalStorage consent)
  - SEO metadata (title, description, keywords, Open Graph, Twitter Cards)
- **UI/UX Improvements**:
  - Sites view matches modern Projects/Templates/Skills layout
  - Improved modal sizing for better readability
  - Sidebar no longer shifts content when unpinned
  - Site cards display thumbnails, status badges, and quick actions
  - Analytics dashboard shows page views, unique visitors, and referrers
- **Performance**: Sites view loads in <3 seconds for 50 projects
- **Documentation**: Comprehensive docs added for all features (12 guides including Server Mode, Sites Publishing, Deployment, Architecture, and more)
  - Fixed version display showing "-" instead of version number
  - Fixed compliance settings not persisting
  - Fixed site thumbnails not updating
  - Fixed analytics tracking issues
- **Gemini Thinking Model Support**: Full compatibility with Gemini thinking models via OpenRouter
  - Automatic `reasoning_details` preservation for multi-turn tool use conversations
  - Enables reliable function calling with thinking models (previously failed with 400 errors)
- **Skills System Enhancements**: Reorganized built-in skills for better AI guidance
  - Split `osw-workflow` into focused skills: `osw-planning` (multi-page site planning) and `osw-one-shot` (landing page generation)
  - Improved skill descriptions to be more action-oriented
  - Skills now appear in Project Structure shown to AI (previously only listed separately)
- **Debug Panel Improvements**: Enhanced debugging experience
  - The mini terminal can be used to test out or perform VFS operations 
  - Easier troubleshooting of AI file operations

## v1.15.0 - 2025-11-04
- Added Agent Skills System (Anthropic-inspired, compatible with prompt-only skills) with integrated Skills tab (Projects | Templates | Skills)
- Global enable/disable toggle for entire skills system with per-skill enable/disable controls
- Built-in skills: OSW Workflow (comprehensive website building guide), Handlebars Advanced, Accessibility (WCAG 2.1 AA)
- Create custom skills with markdown-based editor (YAML frontmatter + content, follows Anthropic SKILL.md convention)
- Import/export skills as .md files or .zip archives
- Skills automatically injected into AI system prompt when enabled (prompt-only approach)
- Expandable/collapsible skill cards with content preview
- Dual-mode skills editor (form view + raw markdown view)
- Moved hidden files toggle from file explorer header to right-click context menu
- Hidden files now only show enabled skills in `/.skills/` folder
- AI interacts with transient files (skills, temp files) via shell commands

## v1.14.1 - 2025-11-02
- Fixed Cmd/Ctrl+S triggering project save when Monaco editor has focus (now lets Monaco handle file saves internally)
- Enhanced directory-based routing: paths ending with `/` now correctly resolve to `index.html` (e.g., `/about/` → `/about/index.html`)
- Added fallback routing logic: `/about` tries `/about.html` first, then `/about/index.html` as fallback
- Updated system prompt documentation to clarify directory index resolution and clean URL support
- Smart JSON repair for truncated tool calls: auto-repairs and executes safe operations (rewrite), fails gracefully with guidance for unsafe operations (update/replace_entity)
- Removed duplicate naive JSON repair from streaming parser to prevent malformed JSON
- Fixed LLM message rendering: normalizes excessive whitespace in LLM output that caused ReactMarkdown to incorrectly render plain text as indented code blocks
- Fixed guided tour compatibility with v1.14.0 event-driven architecture: tour events now properly convert to debug events for ChatPanel display
- Enhanced guided tour reliability: always creates fresh "Example Studios (Tour)" demo project with correct file structure
- Improved tour UX: automatically navigates to project page after completion when demo project is deleted (if other projects exist)

## v1.14.0 - 2025-10-23
- Event-driven chat architecture replacing message-based system
- Real-time event streaming with chronological display and improved UI responsiveness
- Chat panel with event-driven UI, per-batch tool tracking, green color scheme, and hover-transition close button
- Debug panel with real-time event monitoring, automatic event coalescing, filtering, auto-scroll, and improved close interaction
- Debug event persistence: debounced IndexedDB writes prevent duplicates during rapid streaming
- IndexedDB schema v3: added `debugEvents` object store for persistent debug event storage
- Mobile workspace updated to use event-driven chat architecture
- Refactored architecture: modular tool and agent systems with declarative tool registry
- Enhanced error messages: comprehensive usage hints for shell commands to improve LLM self-correction
- Handlebars partial subdirectory support: organize templates in `/templates/components/`, `/templates/partials/`, etc. with automatic multi-name registration
- Fixed file explorer not refreshing after `json_patch` operations
- Enhanced system prompt with improved Handlebars templating guidance: workflow-first approach, 3-step tutorial, working examples, and common LLM anti-patterns
- Added platform constraints to system prompt: emphasizes static-only websites, Handlebars is build-time not runtime, automatic routing

## v1.13.4 - 2025-10-19
- Enhanced Handlebars with `limit` helper for displaying subset of array items
- Improved json_patch error messages to detect and guide LLMs when operations are incorrectly stringified
- Simplified loop detection logic for more accurate duplicate tool call prevention

## v1.13.3 - 2025-10-19
- Fixed "New Project" dialog to show custom imported templates in dropdown
- Refactored built-in template definitions into centralized registry

## v1.13.2 - 2025-10-19
- Fixed duplicate tool call detection producing false positives for different json_patch operations

## v1.13.1 - 2025-10-17
- Fixed streaming response parser breaking early on `finish_reason` before tool calls arrive
- Fixed "No actions were taken" error appearing despite successful tool call execution
- Fixed success determination to use accumulated tool calls instead of steps completed
- Fixed SSE comment filtering to skip lines starting with `:` (removes "OPENROUTER PROCESSING" messages)
- Enhanced json_patch error messages with detailed format guide, operation types, and examples
- Cleared accumulated tool calls at start of new execution

## v1.13.0 - 2025-10-15
- Added Templates system for creating, managing, and sharing reusable project templates
- Export any project as a template (.oswt file) with customizable metadata (name, description, author, version, tags, license)
- Import templates to quickly start new projects
- Template browser with grid/list views, search, and sorting by name, author, or file count
- Project cards now display preview screenshots automatically captured from live preview
- Redesigned project list view with improved 3-column desktop layout
- Added pill-toggle navigation between Projects and Templates pages

## v1.12.0 - 2025-10-04
- Switch between read-only exploration (Chat) and full coding mode (Code)
- Chat mode: Read-only commands for codebase exploration and planning
- Code mode: Full file modification capabilities with json_patch and evaluation tools
- Write commands (touch, echo >, mkdir, rm, mv, cp) blocked in chat mode with helpful error messages
- Optional separate model selection per mode for cost optimization (e.g., use cheaper models for chat/planning)
- Mode state persists across sessions
- Renamed from DeepStudio to Open Source Web Studio (OSW Studio)
- Updated all UI text, database names, storage keys, and API headers
- Maintained full backward compatibility with DeepStudio .osws backup files
- Integrated new OSW Studio logo with theme-aware SVG (automatic light/dark mode support)
- Added outlined favicon design for visibility on all backgrounds
- Established brand naming convention: "Open Source Web Studio" (full), "OSW Studio" (short)
- Consolidated IndexedDB architecture from 3 separate databases to 1 unified database
- Atomic transactions now possible across all data types (projects, files, conversations, checkpoints)
- Improved import/export performance with single database connection
- Fixed backup import hanging issues with proper timeout handling and blocked connection detection
- Added DeepStudio → OSW Studio migration support via backup import
- Enhanced error handling and logging for all database operations
- Enhanced error handling: API errors now show toast notifications and remove thinking indicator
- Error messages persist in chat history with visual styling for easy troubleshooting
- Mobile save button indicator in workspace header appears when unsaved changes exist
- Added "Thinking..." indicator for LLM response wait times
- Early tool call visibility with streaming parameter updates
- Fixed chat auto-scroll during streaming (instant scroll instead of competing animations)
- Fixed preview button flashing during streaming (memoized component and callbacks)
- Subtle retry notifications
- Fixed double JSON encoding in API error responses for cleaner error messages
- Fixed 'echo' and 'touch' commands missing from structural commands for file explorer refresh
- Fixed evaluation tool showing premature status
- Fixed project name input validation
- Fixed metadata URLs (oswstudio → osw-studio) in layout and CLAUDE.md
- Added finish_reason handling for OpenRouter streaming
- Request evaluation when tool calls stop instead of blind retries
- Added runtime validation for tool definitions to prevent malformed tools
- Added loop detection: prevents LLM from repeating the same failing command consecutively
- Added progressive Handlebars rendering: missing partials show inline error stubs instead of failing entire page
- Codebase cleanup: removed 8 unused files and 9 unused dependencies
- Removed tw-animate-css dependency (Tailwind v4 includes built-in animations)
- Removed DeepStudio logo files (deepstudio-logo-dark.svg, app/favicon.ico)
- Updated demo template and GitHub repository links
- Updated theme storage and cost settings event naming

## v1.11.0 - 2025-10-03
- Enhanced evaluation tool with goal-oriented progress tracking (progress_summary, remaining_work, blockers)
- Improved orchestrator loop to properly enforce evaluation after meaningful work (3+ steps)
- Fixed evaluation state handling: now correctly respects should_continue flag
- Added comprehensive error messages with examples for all tool call failures
- Unified error message format across shell, json_patch, and evaluation tools
- Added file creation guidelines to system prompt for cleaner project structure

## v1.10.0 - 2025-10-02
- Added token-efficient shell commands: `rg` (ripgrep), `head`, `tail`, `tree`, `touch`, and `echo >` redirection
- Removed redundant commands: `sed`, `nl`, `rmdir`
- Enhanced system prompt to discourage `cat` usage with decision flowchart and token cost warnings

## v1.9.1 - 2025-09-30
- Fixed Handlebars navigation links being converted to blob URLs instead of remaining as routes

## v1.9.0 - 2025-09-29
- Added complete data backup and restore functionality
- Export all projects, conversations, and checkpoints to .dstudio file
- Import data with merge or replace options
- Fixed changelog versioning to follow semantic versioning (major.minor.patch)

## v1.8.0 - 2025-09-28
- Enhanced system prompt with directory tree structure and file sizes
- Major VFS improvements: Added comprehensive image loading interceptor for dynamic content
- VFS now transparently handles JavaScript-generated images and assets via blob URLs
- Fixed image resolution issues in templates with automatic innerHTML processing
- Refactored template system with self-contained asset definitions
- Unified createProjectFromTemplate function with optional assets parameter

## v1.7.0 - 2025-09-27
- Modularized the monolithic template file
- Removed Handlebars template
- Added step counter to guided tour overlay

## v1.6.0 - 2025-09-27
- Fixed binary file persistence in checkpoint system
- Images and other binary files now properly persist across page reloads
- Added base64 encoding/decoding for binary content in checkpoints
- Updated VFS updateFile to support ArrayBuffer content

## v1.5.0 - 2025-09-26
- Fixed TypeScript compilation error with shell tool oneOf parameter support  
- Enhanced Handlebars error handling with detection of invalid LLM-generated syntax
- Added helpful error messages for common Handlebars pattern mistakes

## v1.4.0 - 2025-09-26
- Improved LLM shell tool compatibility with natural command format support
- Shell tool now accepts both string ("ls -la /") and array (["ls", "-la", "/"]) formats
- Fixed system prompt confusion about model tool-calling capabilities
- Added automatic string-to-array conversion for better first-call success rates

## v1.3.0 - 2025-09-26
- Enhanced demo project with Handlebars templating for navigation and footer
- Added minimal Handlebars component to barebones template
- Improved template organization and maintainability

## v1.2.0 - 2025-09-26
- Fixed mobile streaming disconnection issue in workspace chat panel
- Mobile now properly displays real-time AI responses with tool calls
- Added missing scroll management for mobile chat during streaming
- Aligned mobile and desktop chat rendering behavior

## v1.1.0 - 2025-09-24
- Added Handlebars templating support (.hbs/.handlebars files)
- Templates automatically compile to static HTML on export
- LLM can now create reusable components with partials
- Improved code generation capabilities

## v1.0.0 - 2025-09-23
- Initial public release
- Multi-provider AI support (8 providers)
- Browser-based development environment
- Project management with checkpoints
- Session recovery and persistence