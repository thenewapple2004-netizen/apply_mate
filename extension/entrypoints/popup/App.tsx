import { ConnectionStatus } from '@/components/ConnectionStatus.tsx';
import { Onboarding } from '@/features/onboarding/Onboarding.tsx';

function App() {
  return (
    <main className="popup">
      <header className="brand">
        <img src="/icon/48.png" alt="" className="brand-icon" />
        <h1>Job Fellow</h1>
      </header>

      <Onboarding />

      <ConnectionStatus />

      <footer className="status">v{browser.runtime.getManifest().version}</footer>
    </main>
  );
}

export default App;
