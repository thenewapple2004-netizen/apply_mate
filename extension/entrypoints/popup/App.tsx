function App() {
  return (
    <main className="popup">
      <header className="brand">
        <img src="/icon/48.png" alt="" className="brand-icon" />
        <h1>ApplyMate</h1>
      </header>

      <section className="welcome">
        <h2>Welcome!</h2>
        <p>
          ApplyMate will help you fill out job applications faster, using your
          saved profile and AI-drafted answers you review before submitting.
        </p>
      </section>

      <section className="profile">
        <label htmlFor="profile-select">Application profile</label>
        <select id="profile-select" disabled defaultValue="">
          <option value="">No profiles yet</option>
        </select>
        <p className="hint">Profile setup is coming in a future update.</p>
      </section>

      <footer className="status">
        v{browser.runtime.getManifest().version} · Setup coming soon
      </footer>
    </main>
  );
}

export default App;
