import { useEffect, useRef } from 'react';
import { SIDEPANEL_MESSAGE, SIDEPANEL_VERSION, sidePanelTarget, type SidePanelSession } from '../../src/shared/sidepanel';

// Only the allowlisted embedding extension receives selection metadata. No
// credentials, conversation contents, or commands cross this boundary.
export function useSidePanelSession(session: SidePanelSession) {
  const sequence = useRef(0);
  useEffect(() => {
    const target = sidePanelTarget(location);
    if (!target || window.parent === window) return;
    const publish = () => window.parent.postMessage({ type: SIDEPANEL_MESSAGE, version: SIDEPANEL_VERSION,
      channel: target.channel, sequence: ++sequence.current, ...session }, target.origin);
    publish();
    const timer = setInterval(publish, 1000);
    return () => clearInterval(timer);
  }, [session.environmentId, session.threadId, session.title, session.online]);
}
