import { useCallback, useEffect, useRef, useState } from 'react';

import { type BackendStatus, checkBackendStatus } from '@/lib/backend-status.ts';

const LABELS: Record<BackendStatus['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  offline: 'Backend offline',
  error: 'Connection error',
};

export function ConnectionStatus() {
  const [status, setStatus] = useState<BackendStatus>({ state: 'connecting' });
  const controllerRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus({ state: 'connecting' });
    try {
      const result = await checkBackendStatus(controller.signal);
      if (!controller.signal.aborted) setStatus(result);
    } catch {
      if (!controller.signal.aborted) {
        setStatus({ state: 'error', detail: 'Unexpected error' });
      }
    }
  }, []);

  useEffect(() => {
    void check();
    return () => controllerRef.current?.abort();
  }, [check]);

  const failed = status.state === 'offline' || status.state === 'error';

  return (
    <section className="connection" aria-live="polite">
      <div className="connection-row">
        <span className={`connection-dot ${status.state}`} aria-hidden="true" />
        <span className="connection-label">{LABELS[status.state]}</span>
        {failed && (
          <button type="button" className="retry" onClick={() => void check()}>
            Retry connection
          </button>
        )}
      </div>
      {status.detail && <p className="connection-detail">{status.detail}</p>}
    </section>
  );
}
