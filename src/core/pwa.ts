export type PwaState = 'ready' | 'updating' | 'updated' | 'error' | 'unsupported';

export interface PwaStatus {
  state: PwaState;
  message: string;
}

export function installPwaLifecycle(onStatus: (status: PwaStatus) => void): void {
  if (!('serviceWorker' in navigator)) {
    onStatus({ state: 'unsupported', message: 'App cache unavailable' });
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    onStatus({ state: 'updated', message: 'App updated' });
  });
  navigator.serviceWorker.addEventListener('error', () => {
    onStatus({ state: 'error', message: 'App cache unavailable' });
  });

  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new Error('service worker timeout')), 8000);
  });
  void Promise.race([ready, timeout]).then((registration) => {
    onStatus({ state: 'ready', message: '' });
    observeRegistration(registration, onStatus);
  }).catch(() => {
    onStatus({ state: 'error', message: 'App cache unavailable' });
  });
}

function observeRegistration(
  registration: ServiceWorkerRegistration,
  onStatus: (status: PwaStatus) => void,
): void {
  const observeWorker = (worker: ServiceWorker | null): void => {
    if (!worker) return;
    if (worker.state === 'installing') onStatus({ state: 'updating', message: 'Updating app…' });
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        onStatus({ state: 'updating', message: 'Updating app…' });
      }
      if (worker.state === 'activated') onStatus({ state: 'updated', message: 'App updated' });
      if (worker.state === 'redundant') onStatus({ state: 'error', message: 'App update failed' });
    });
  };
  observeWorker(registration.installing);
  registration.addEventListener('updatefound', () => observeWorker(registration.installing));
}
