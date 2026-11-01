/**
 * How many projects the demo holds, in a cookie on the demo's own host. Safari keeps IndexedDB apart
 * for each top-level origin, so the bridge, framed on an instance page, finds none of the projects
 * there; a cookie is shared with a same-site frame, so the bridge can still tell projects it cannot
 * read from no projects at all. The demo's own top-level pages write it (`DemoProjectCount`), and the
 * bridge after removing projects it can see.
 */
export const DEMO_PROJECTS_COOKIE = 'osws_demo_projects';

export function writeDemoProjectCount(count: number): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  // 400 days, the longest any browser keeps a cookie; Safari cuts one written by script to 7.
  document.cookie = `${DEMO_PROJECTS_COOKIE}=${Math.max(0, Math.floor(count))}; Path=/; Max-Age=34560000; SameSite=Lax${secure}`;
}

export function readDemoProjectCount(): number {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${DEMO_PROJECTS_COOKIE}=(\\d+)`));
  return match ? Number(match[1]) : 0;
}
