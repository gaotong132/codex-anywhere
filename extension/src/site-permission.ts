import { browserOrigin } from '../../src/browser-control/contracts.js';

// Chrome match patterns omit ports. Runtime authorization still requires the
// exact origin (including port) and document identity for every managed tab.
export function sitePattern(origin: string) {
  const url = new URL(browserOrigin(origin));
  return `${url.protocol}//${url.hostname}/*`;
}
