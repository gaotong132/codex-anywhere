import { useEffect, useRef } from 'react';
import { SIDEPANEL_MESSAGE, SIDEPANEL_VERSION, sidePanelTarget, type SidePanelSession } from '../../src/shared/sidepanel';
import { BROWSER_LINK_REQUEST, BROWSER_LINK_RESPONSE, browserLinkContext, parseBrowserLinkRequest } from '../../src/shared/browser-link';
import { createDeviceAuthProof } from '../../src/shared/device-auth';
import { loadOrCreateBrowserDeviceIdentity } from './device-identity';

// Only the exact embedding parent receives metadata and a challenge-bound
// association proof. Neither private keys nor page commands cross this bridge.
export function useSidePanelSession(session: SidePanelSession, authenticated = false) {
  const sequence = useRef(0);
  useEffect(() => {
    const target = sidePanelTarget(location);
    if (!target || window.parent === window) return;
    const publish = () => window.parent.postMessage({ type: SIDEPANEL_MESSAGE, version: SIDEPANEL_VERSION,
      channel: target.channel, sequence: ++sequence.current, ...session, authenticated, linkSupported: true }, target.origin);
    const link = (event: MessageEvent) => {
      if (!authenticated || event.source !== window.parent || event.origin !== target.origin
        || event.data?.type !== BROWSER_LINK_REQUEST || event.data?.channel !== target.channel) return;
      const request = parseBrowserLinkRequest(event.data.request);
      if (!request || request.extensionOrigin !== target.origin) return;
      const sponsor = createDeviceAuthProof(loadOrCreateBrowserDeviceIdentity(), {
        challenge: request.challenge, role: 'client', authProof: browserLinkContext(target.origin, request.device),
      });
      window.parent.postMessage({ type: BROWSER_LINK_RESPONSE, channel: target.channel,
        requestId: request.requestId, sponsor }, target.origin);
    };
    window.addEventListener('message', link);
    publish();
    const timer = setInterval(publish, 1000);
    return () => { clearInterval(timer); window.removeEventListener('message', link); };
  }, [session.environmentId, session.threadId, session.title, session.online, authenticated]);
}
