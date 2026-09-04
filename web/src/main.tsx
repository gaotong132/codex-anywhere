import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { takePairingInput } from './pairing-input';
import './styles.scss';

void removeObsoleteWorkers().catch(() => undefined);

let pairingStorage: Storage | undefined;
try { pairingStorage = sessionStorage; } catch { /* blocked store */ }
const initialPairingInput = takePairingInput(location, history, pairingStorage);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialPairingInput={initialPairingInput} />
  </StrictMode>,
);

async function removeObsoleteWorkers() {
  try { localStorage.removeItem('codex-anywhere.notifications.enabled'); } catch { /* blocked storage */ }
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}
