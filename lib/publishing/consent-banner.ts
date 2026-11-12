/**
 * Consent Banner Generator
 *
 * Generates a self-contained consent banner with inline CSS and JS.
 * Features:
 * - LocalStorage persistence
 * - Accept/Decline buttons
 * - Customizable position, style, and message
 * - Can block analytics until consent
 */

import { ComplianceConfig } from '../vfs/types';

export interface ConsentBannerOptions {
  deploymentId: string;
  compliance: ComplianceConfig;
}

/** Where the visitor's answer to a deployment's banner is kept. */
const consentKey = (deploymentId: string) => `osw_consent_${deploymentId}`;

/**
 * Reads the visitor's answer to the banner and sets `window.oswAnalyticsBlocked` while analytics may
 * not run: until a yes in opt-in mode, and after a no. It goes in the head, ahead of every analytics
 * script, which each check the flag; the banner's own script comes at the end of the body.
 */
export function generateConsentState(deploymentId: string, mode: ComplianceConfig['mode']): string {
  return `<script>
(function() {
  var consent = null;
  try {
    consent = localStorage.getItem(${JSON.stringify(consentKey(deploymentId))});
  } catch (e) {}
  if (consent === 'declined' || (consent !== 'accepted' && ${JSON.stringify(mode)} === 'opt-in')) {
    window.oswAnalyticsBlocked = true;
  }
})();
</script>`;
}

/**
 * Generate the consent banner HTML, CSS, and JS
 */
export function generateConsentBanner(options: ConsentBannerOptions): string {
  const { deploymentId, compliance } = options;

  if (!compliance.enabled) {
    return '';
  }

  const {
    bannerPosition,
    bannerStyle,
    message,
    acceptButtonText,
    declineButtonText,
    privacyPolicyUrl,
    cookiePolicyUrl,
    blockAnalytics,
  } = compliance;

  // Position styles
  const positionStyles = bannerPosition === 'top'
    ? 'top: 0; border-bottom: 1px solid rgba(0,0,0,0.1);'
    : 'bottom: 0; border-top: 1px solid rgba(0,0,0,0.1);';

  // Style variations
  let containerStyles = '';
  let maxWidth = 'none';

  if (bannerStyle === 'bar') {
    containerStyles = `
      ${positionStyles}
      left: 0;
      right: 0;
      width: 100%;
    `;
  } else if (bannerStyle === 'modal') {
    containerStyles = `
      ${positionStyles}
      left: 50%;
      transform: translateX(-50%);
      max-width: 600px;
      border-radius: 8px;
      margin: ${bannerPosition === 'top' ? '20px' : '20px'} auto;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    maxWidth = '600px';
  } else if (bannerStyle === 'corner') {
    containerStyles = `
      ${bannerPosition === 'top' ? 'top: 20px;' : 'bottom: 20px;'}
      right: 20px;
      max-width: 400px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    maxWidth = '400px';
  }

  return `
<!-- OSW Studio Consent Banner -->
<style>
#osw-consent-banner {
  position: fixed;
  ${containerStyles}
  background: #ffffff;
  color: #333333;
  padding: 1.25rem;
  z-index: 999999;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  display: none;
  box-sizing: border-box;
}

#osw-consent-banner * {
  box-sizing: border-box;
}

#osw-consent-banner.osw-show {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
  ${bannerStyle === 'bar' ? 'justify-content: center;' : ''}
}

#osw-consent-content {
  flex: 1 1 auto;
  min-width: 250px;
}

#osw-consent-message {
  margin: 0;
  font-size: 14px;
  color: #333333;
}

#osw-consent-links {
  margin: 0.5rem 0 0 0;
  font-size: 12px;
}

#osw-consent-links a {
  color: #0066cc;
  text-decoration: underline;
  margin-right: 1rem;
  transition: color 0.2s;
}

#osw-consent-links a:hover {
  color: #0052a3;
}

#osw-consent-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  flex-shrink: 0;
}

#osw-consent-actions button {
  padding: 0.625rem 1.5rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
  white-space: nowrap;
}

#osw-consent-actions button:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}

#osw-consent-actions button:active {
  transform: translateY(0);
}

#osw-consent-accept {
  background: #0066cc;
  color: #ffffff;
}

#osw-consent-accept:hover {
  background: #0052a3;
}

#osw-consent-decline {
  background: #f5f5f5;
  color: #333333;
  border: 1px solid #e0e0e0;
}

#osw-consent-decline:hover {
  background: #e8e8e8;
}

/* Responsive Design */
@media (max-width: 768px) {
  #osw-consent-banner.osw-show {
    flex-direction: column;
    align-items: stretch;
  }

  #osw-consent-content {
    min-width: 100%;
  }

  #osw-consent-actions {
    width: 100%;
    justify-content: stretch;
  }

  #osw-consent-actions button {
    flex: 1 1 auto;
  }
}

@media (max-width: 600px) {
  #osw-consent-banner {
    left: 0 !important;
    right: 0 !important;
    transform: none !important;
    max-width: none !important;
    border-radius: 0 !important;
    margin: 0 !important;
    padding: 1rem;
  }

  #osw-consent-actions {
    flex-direction: column;
  }

  #osw-consent-actions button {
    width: 100%;
  }
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  #osw-consent-banner {
    background: #1e1e1e;
    color: #e0e0e0;
    border-color: rgba(255,255,255,0.1) !important;
  }

  #osw-consent-message {
    color: #e0e0e0;
  }

  #osw-consent-links a {
    color: #4d9fff;
  }

  #osw-consent-links a:hover {
    color: #6bb0ff;
  }

  #osw-consent-decline {
    background: #2a2a2a;
    color: #e0e0e0;
    border-color: #404040;
  }

  #osw-consent-decline:hover {
    background: #353535;
  }
}
</style>

<div id="osw-consent-banner">
  <div id="osw-consent-content">
    <div id="osw-consent-message">${escapeHtml(message)}</div>
    ${(privacyPolicyUrl || cookiePolicyUrl) ? `
    <div id="osw-consent-links">
      ${privacyPolicyUrl ? `<a href="${escapeHtml(privacyPolicyUrl)}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>` : ''}
      ${cookiePolicyUrl ? `<a href="${escapeHtml(cookiePolicyUrl)}" target="_blank" rel="noopener noreferrer">Cookie Policy</a>` : ''}
    </div>
    ` : ''}
  </div>
  <div id="osw-consent-actions">
    <button id="osw-consent-accept">${escapeHtml(acceptButtonText)}</button>
    <button id="osw-consent-decline">${escapeHtml(declineButtonText)}</button>
  </div>
</div>

<script>
(function() {
  'use strict';
  var STORAGE_KEY = ${JSON.stringify(consentKey(deploymentId))};
  var BLOCK_ANALYTICS = ${blockAnalytics};

  function getConsent() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function setConsent(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      // Silently fail if localStorage is disabled
    }
  }

  function hideBanner() {
    var banner = document.getElementById('osw-consent-banner');
    if (banner) {
      banner.classList.remove('osw-show');
    }
  }

  function showBanner() {
    var banner = document.getElementById('osw-consent-banner');
    if (banner) {
      banner.classList.add('osw-show');
    }
  }

  function handleAccept() {
    setConsent('accepted');
    hideBanner();

    // If analytics was blocked, reload to allow it
    if (BLOCK_ANALYTICS && window.oswAnalyticsBlocked) {
      window.location.reload();
    }
  }

  function handleDecline() {
    setConsent('declined');
    hideBanner();
  }

  // Show the banner until the visitor answers. Whether analytics may run was settled in the head,
  // by the script generateConsentState writes, before any of it loaded.
  var consent = getConsent();

  if (consent === 'accepted' || consent === 'declined') {
    hideBanner();
  } else {
    showBanner();
  }

  // Attach event listeners
  var acceptBtn = document.getElementById('osw-consent-accept');
  var declineBtn = document.getElementById('osw-consent-decline');

  if (acceptBtn) {
    acceptBtn.addEventListener('click', handleAccept);
  }

  if (declineBtn) {
    declineBtn.addEventListener('click', handleDecline);
  }
})();
</script>
`.trim();
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}
