import { PublishSettings } from '../vfs/types';
import { generateTrackingScript } from '../analytics/tracking-script';
import { generateConsentBanner } from './consent-banner';
import { generateReviewWidget, REVIEW_WIDGET_MARKER } from './review-widget';
import { escapeHtml } from './escape-html';
import { pageAddress } from './seo-generator';

export interface HtmlProcessingOptions {
  publishSettings: PublishSettings;
  projectId: string;
  baseUrl: string;
  deploymentId: string;
  hasEdgeFunctions?: boolean;
  /** The page's path in the build (`about.html`), for its og:url. Without it og:url is the site's root. */
  pagePath?: string;
  /** Set only by the review build pass. See step 8 in processHtml. */
  reviewWidget?: boolean;
}

/**
 * Injects scripts, CDN links, SEO meta tags, analytics, compliance banner, and — on the review
 * build pass only — the review comment widget into HTML
 *
 * Note: Under construction mode is handled separately by serving a dedicated page,
 * not by overlaying content
 */
export function processHtml(html: string, options: HtmlProcessingOptions): string {
  const { publishSettings, projectId, baseUrl, deploymentId, hasEdgeFunctions } = options;

  let processed = html;

  // 1. Inject SEO meta tags into <head>
  processed = injectSeoMetaTags(processed, publishSettings, baseUrl, options.pagePath);

  // 2. Inject CDN links into <head>
  processed = injectCdnLinks(processed, publishSettings);

  // 3. Inject head scripts into <head>
  processed = injectHeadScripts(processed, publishSettings);

  // 4. Inject edge function interceptor into <head> (only if project has edge functions)
  if (hasEdgeFunctions) {
    processed = injectEdgeFunctionInterceptor(processed, deploymentId);
  }

  // 5. Inject body scripts before </body>
  processed = injectBodyScripts(processed, publishSettings);

  // 6. Inject analytics tracking (if enabled and builtin)
  processed = injectAnalytics(processed, deploymentId, publishSettings);

  // 7. Inject compliance banner (if enabled)
  processed = injectComplianceBanner(processed, deploymentId, publishSettings);

  // 8. Review comment widget. Opt-in per build pass, never conditional on runtime state, so the
  //    public build cannot emit it by misconfiguration.
  if (options.reviewWidget) {
    processed = injectReviewWidget(processed, deploymentId);
  }

  return processed;
}

/** A head tag the SEO settings can set: the title, a <meta> by name or property, or a <link> by rel. */
type HeadTag = { title: true } | { meta: 'name' | 'property'; key: string } | { link: string };

/** The tag's pattern, whatever the order of its attributes and whichever quotes they use. */
function headTagPattern(tag: HeadTag): RegExp {
  if ('title' in tag) return /<title\b[^>]*>[\s\S]*?<\/title>[ \t]*\n?/gi;
  const [el, attr, value] = 'meta' in tag ? ['meta', tag.meta, tag.key] : ['link', 'rel', tag.link];
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${el}\\b[^>]*\\s${attr}\\s*=\\s*["']?${v}["']?(?=[\\s/>])[^>]*>[ \\t]*\\n?`, 'gi');
}

/** Removes these tags from the document's <head>, leaving the body alone. */
function removeHeadTags(html: string, tags: HeadTag[]): string {
  const end = html.search(/<\/head>/i);
  if (end === -1 || tags.length === 0) return html;
  let head = html.slice(0, end);
  for (const tag of tags) head = head.replace(headTagPattern(tag), '');
  return head + html.slice(end);
}

/** The href of the head's <link rel="canonical"> as a browser reads it (references decoded), or null. */
function headCanonical(html: string): string | null {
  const end = html.search(/<\/head>/i);
  const tag = headTagPattern({ link: 'canonical' }).exec(html.slice(0, end === -1 ? html.length : end));
  const href = tag && /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
  return href ? decodeReferences(href[1] ?? href[2] ?? href[3]) : null;
}

const NAMED_REFERENCES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Numeric character references and the five XML named ones (`&amp;`, `&quot;`, `&apos;`, `&lt;`, `&gt;`), decoded. */
function decodeReferences(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|quot|apos|lt|gt));/gi, (match, dec, hex, name) => {
    if (name) return NAMED_REFERENCES[name.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** `href` as an absolute URL: resolved against `base` when relative, as written when it cannot be. */
function absoluteUrl(href: string, base: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Whether the document's <head> already carries this tag. */
function headHasTag(html: string, tag: HeadTag): boolean {
  const end = html.search(/<\/head>/i);
  return headTagPattern(tag).test(html.slice(0, end === -1 ? html.length : end));
}

/**
 * Injects SEO meta tags into <head>
 *
 * A page's own tag wins over the setting for anything written per page: the title, the description,
 * keywords, the social image and the canonical URL. The settings are one set for the whole
 * deployment, so overriding those would give every page in a site the same title and description.
 * Where the page has no such tag the setting fills it in, and a page that carries one is left with
 * one rather than two.
 *
 * `og:type` and `twitter:card` describe the deployment rather than the page, and `noindex` /
 * `nofollow` are a deliberate switch over the whole deployment, so those do replace whatever the
 * page set. `og:url` is replaced too, with the page's own address: its canonical link (the page's,
 * else the setting's), so a shared link and a search result name the same URL, and otherwise where it
 * is served. Open Graph wants it absolute, so a relative canonical is resolved against that address.
 */
function injectSeoMetaTags(html: string, settings: PublishSettings, baseUrl: string, pagePath?: string): string {
  const { seo } = settings;
  if (!seo || Object.keys(seo).length === 0) {
    return html;
  }

  const metaTags: string[] = [];
  const replaced: HeadTag[] = [];

  /** The setting is a default: used only where the page did not set this tag itself. */
  const fill = (tag: HeadTag, markup: string) => {
    if (!headHasTag(html, tag)) metaTags.push(markup);
  };

  /** The setting is deployment-wide: it replaces the page's tag. */
  const replace = (tag: HeadTag, markup: string) => {
    replaced.push(tag);
    metaTags.push(markup);
  };

  // Basic meta tags
  if (seo.title) {
    fill({ title: true }, `<title>${escapeHtml(seo.title)}</title>`);
  }
  if (seo.description) {
    fill({ meta: 'name', key: 'description' }, `<meta name="description" content="${escapeHtml(seo.description)}">`);
  }
  if (seo.keywords && seo.keywords.length > 0) {
    fill({ meta: 'name', key: 'keywords' }, `<meta name="keywords" content="${escapeHtml(seo.keywords.join(', '))}">`);
  }

  // Open Graph and Twitter. `ogTitle` / `ogDescription` are the social wording where they are set,
  // which is what the OG Title and OG Description fields offer; otherwise the page's own meta text
  // is reused. Twitter reads the same values, so setting one does not leave the other disagreeing.
  const socialTitle = seo.ogTitle || seo.title;
  const socialDescription = seo.ogDescription || seo.description;

  if (socialTitle) {
    fill({ meta: 'property', key: 'og:title' }, `<meta property="og:title" content="${escapeHtml(socialTitle)}">`);
    fill({ meta: 'name', key: 'twitter:title' }, `<meta name="twitter:title" content="${escapeHtml(socialTitle)}">`);
  }
  if (socialDescription) {
    fill({ meta: 'property', key: 'og:description' }, `<meta property="og:description" content="${escapeHtml(socialDescription)}">`);
    fill({ meta: 'name', key: 'twitter:description' }, `<meta name="twitter:description" content="${escapeHtml(socialDescription)}">`);
  }
  if (seo.ogImage) {
    fill({ meta: 'property', key: 'og:image' }, `<meta property="og:image" content="${escapeHtml(seo.ogImage)}">`);
    fill({ meta: 'name', key: 'twitter:image' }, `<meta name="twitter:image" content="${escapeHtml(seo.ogImage)}">`);
  }

  const address = pagePath ? pageAddress(pagePath) : '';
  const served = `${baseUrl}${address ? '/' + address : ''}`;
  const canonical = headCanonical(html) || seo.canonical;
  // The root page is the deployment's folder, so a relative link on it resolves inside that folder.
  const pageUrl = canonical ? absoluteUrl(canonical, address ? served : `${served}/`) : served;
  replace({ meta: 'property', key: 'og:url' }, `<meta property="og:url" content="${escapeHtml(pageUrl)}">`);
  replace({ meta: 'property', key: 'og:type' }, `<meta property="og:type" content="website">`);
  replace({ meta: 'name', key: 'twitter:card' }, `<meta name="twitter:card" content="${seo.twitterCard === 'summary' ? 'summary' : 'summary_large_image'}">`);

  // Canonical URL
  if (seo.canonical) {
    fill({ link: 'canonical' }, `<link rel="canonical" href="${escapeHtml(seo.canonical)}">`);
  }

  // Robots directives
  const robotsDirectives: string[] = [];
  if (seo.noIndex) robotsDirectives.push('noindex');
  if (seo.noFollow) robotsDirectives.push('nofollow');
  if (robotsDirectives.length > 0) {
    replace({ meta: 'name', key: 'robots' }, `<meta name="robots" content="${robotsDirectives.join(', ')}">`);
  }

  return injectIntoHead(removeHeadTags(html, replaced), metaTags.join('\n    '));
}

/**
 * Injects CDN links (CSS and JS) into <head>
 */
function injectCdnLinks(html: string, settings: PublishSettings): string {
  const enabledCdnLinks = settings.cdnLinks.filter(cdn => cdn.enabled);
  if (enabledCdnLinks.length === 0) {
    return html;
  }

  const links: string[] = [];

  for (const cdn of enabledCdnLinks) {
    if (cdn.type === 'css') {
      links.push(`<link rel="stylesheet" href="${escapeHtml(cdn.url)}" ${cdn.integrity ? `integrity="${escapeHtml(cdn.integrity)}"` : ''} crossorigin="anonymous">`);
    } else if (cdn.type === 'js') {
      links.push(`<script src="${escapeHtml(cdn.url)}" ${cdn.integrity ? `integrity="${escapeHtml(cdn.integrity)}"` : ''} crossorigin="anonymous"></script>`);
    }
  }

  return injectIntoHead(html, links.join('\n    '));
}

/**
 * Injects head scripts into <head>
 */
function injectHeadScripts(html: string, settings: PublishSettings): string {
  const enabledHeadScripts = settings.headScripts.filter(script => script.enabled);
  if (enabledHeadScripts.length === 0) {
    return html;
  }

  const scripts: string[] = [];

  for (const script of enabledHeadScripts) {
    if (script.type === 'inline') {
      scripts.push(`<script>\n${script.content}\n</script>`);
    } else if (script.type === 'external') {
      scripts.push(`<script src="${escapeHtml(script.src!)}" ${script.async ? 'async' : ''} ${script.defer ? 'defer' : ''}></script>`);
    }
  }

  return injectIntoHead(html, scripts.join('\n    '));
}

/**
 * Injects body scripts before </body>
 */
function injectBodyScripts(html: string, settings: PublishSettings): string {
  const enabledBodyScripts = settings.bodyScripts.filter(script => script.enabled);
  if (enabledBodyScripts.length === 0) {
    return html;
  }

  const scripts: string[] = [];

  for (const script of enabledBodyScripts) {
    if (script.type === 'inline') {
      scripts.push(`<script>\n${script.content}\n</script>`);
    } else if (script.type === 'external') {
      scripts.push(`<script src="${escapeHtml(script.src!)}" ${script.async ? 'async' : ''} ${script.defer ? 'defer' : ''}></script>`);
    }
  }

  const bodyCloseTag = '</body>';
  const bodyCloseIndex = html.lastIndexOf(bodyCloseTag);

  if (bodyCloseIndex === -1) {
    // No </body> tag, append at the end
    return html + '\n' + scripts.join('\n') + '\n';
  }

  return (
    html.slice(0, bodyCloseIndex) +
    '    ' + scripts.join('\n    ') + '\n' +
    html.slice(bodyCloseIndex)
  );
}

/**
 * Helper to inject content into <head>
 */
function injectIntoHead(html: string, content: string): string {
  const headCloseTag = '</head>';
  const headCloseIndex = html.indexOf(headCloseTag);

  if (headCloseIndex === -1) {
    // No </head> tag, try to inject after <head> or at the beginning
    const headOpenTag = '<head>';
    const headOpenIndex = html.indexOf(headOpenTag);
    if (headOpenIndex !== -1) {
      return (
        html.slice(0, headOpenIndex + headOpenTag.length) +
        '\n    ' + content + '\n' +
        html.slice(headOpenIndex + headOpenTag.length)
      );
    }
    // No <head> at all, prepend
    return content + '\n' + html;
  }

  return (
    html.slice(0, headCloseIndex) +
    '    ' + content + '\n' +
    html.slice(headCloseIndex)
  );
}

/**
 * Inject analytics tracking script (if enabled and provider is builtin)
 */
function injectAnalytics(html: string, deploymentId: string, settings: PublishSettings): string {
  if (!settings.analytics.enabled || settings.analytics.provider !== 'builtin') {
    return html;
  }

  // Get analytics config with token and features
  const { analytics } = settings;
  const trackingOptions = {
    deploymentId: deploymentId,
    token: analytics.token,
    features: {
      basicTracking: analytics.features?.basicTracking !== false, // Default to true
      heatmaps: analytics.features?.heatmaps === true,
      sessionRecording: analytics.features?.sessionRecording === true,
      performanceMetrics: analytics.features?.performanceMetrics === true,
      engagementTracking: analytics.features?.engagementTracking === true,
      customEvents: analytics.features?.customEvents === true,
    },
  };

  // If compliance is enabled and blocks analytics, wrap in consent check
  if (settings.compliance.enabled && settings.compliance.blockAnalytics) {
    const wrappedScript = `
<script>
if (!window.oswAnalyticsBlocked) {
  ${generateTrackingScript(trackingOptions).replace(/<\/?script>/g, '')}
}
</script>
    `.trim();

    return injectBeforeBodyClose(html, wrappedScript);
  }

  // Otherwise, inject directly
  const trackingScript = generateTrackingScript(trackingOptions);
  return injectBeforeBodyClose(html, trackingScript);
}

/**
 * Inject compliance/consent banner (if enabled)
 */
function injectComplianceBanner(html: string, deploymentId: string, settings: PublishSettings): string {
  if (!settings.compliance.enabled) {
    return html;
  }

  const banner = generateConsentBanner({
    deploymentId,
    compliance: settings.compliance,
  });

  return injectBeforeBodyClose(html, banner);
}

/**
 * Inject the review comment widget (review build pass only). Idempotent: a second host would be
 * found first by the script instance the second copy carries, and attachShadow on an element that
 * already has a shadow root throws, taking the whole widget down.
 */
function injectReviewWidget(html: string, deploymentId: string): string {
  if (html.includes(REVIEW_WIDGET_MARKER)) return html;
  return injectBeforeBodyClose(html, generateReviewWidget(deploymentId));
}

/**
 * Helper to inject content before </body>
 */
function injectBeforeBodyClose(html: string, content: string): string {
  const bodyCloseTag = '</body>';
  const bodyCloseIndex = html.lastIndexOf(bodyCloseTag);

  if (bodyCloseIndex === -1) {
    // No </body> tag, append at the end
    return html + '\n' + content + '\n';
  }

  return (
    html.slice(0, bodyCloseIndex) +
    content + '\n' +
    html.slice(bodyCloseIndex)
  );
}

/**
 * Inject edge function interceptor script into <head>
 * Routes fetch/form requests to edge function API endpoints
 *
 * `/review/` is excluded alongside `/api/`: the whole prefix is reserved for the review copy and
 * its comment API (lib/review/api-base.ts), so on a published page nothing under it is ever a call
 * the customer meant for an edge function. The widget addresses that API absolutely and so already
 * passes the check above, but a relative call added there later must not be silently re-routed.
 */
function injectEdgeFunctionInterceptor(html: string, deploymentId: string): string {
  if (!deploymentId) {
    return html;
  }

  // Minified interceptor script for production
  const interceptorScript = `<script>
(function(){var s="${deploymentId}";function e(u){if(!u||typeof u!=="string")return false;if(u.startsWith("http://")||u.startsWith("https://")||u.startsWith("blob:")||u.startsWith("data:")||u.startsWith("//")||u.startsWith("#"))return false;if(u.startsWith("/api/")||u.startsWith("/review/"))return false;var p=u.split("?")[0].split("#")[0];var l=p.split("/").pop()||"";if(l.includes("."))return false;return true}function a(u){var p=u;if(!p.startsWith("/"))p="/"+p;return"/api/deployments/"+s+"/functions"+p}var f=window.fetch;window.fetch=function(i,o){var u=typeof i==="string"?i:i.url;if(e(u))return f(a(u),o);return f(i,o)};var X=window.XMLHttpRequest;window.XMLHttpRequest=function(){var x=new X();var op=x.open;x.open=function(m,u){if(e(u))return op.call(this,m,a(u));return op.apply(this,arguments)};return x};document.addEventListener("submit",function(ev){var fm=ev.target;if(!(fm instanceof HTMLFormElement))return;var ac=fm.getAttribute("action")||"";if(!e(ac))return;ev.preventDefault();var m=(fm.method||"POST").toUpperCase();var fd=new FormData(fm);var d={};fd.forEach(function(v,k){d[k]=v});fetch(a(ac),{method:m,headers:{"Content-Type":"application/json"},body:m!=="GET"?JSON.stringify(d):undefined}).then(function(r){return r.json().catch(function(){return r.text()})}).then(function(r){var ev=new CustomEvent("edge-function-response",{detail:{action:ac,result:r}});fm.dispatchEvent(ev);document.dispatchEvent(ev)}).catch(function(err){console.error("[Edge Function]",err);var ev=new CustomEvent("edge-function-error",{detail:{action:ac,error:err.message}});fm.dispatchEvent(ev);document.dispatchEvent(ev)})},true)})();
</script>`;

  return injectIntoHead(html, interceptorScript);
}
