import { createSignal, Show } from "solid-js";
import logoUrl from "../../assets/logo.svg";
import { errorMessage, type AppStore } from "../lib/store";

export default function AuthScreen(props: { store: AppStore }) {
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (!token().trim() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.store.signIn(token().trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="auth" data-testid="auth">
      <form class="auth-card" onSubmit={submit}>
        <img class="auth-logo" src={logoUrl} alt="" width="64" height="64" />
        <h1>Sign in to GitHub</h1>
        <p class="muted">Fast Reviewer needs a token to read pull requests and mark files as viewed. It looks for one automatically, in this order:</p>
        <ol>
          <li>
            <code>GH_TOKEN</code> or <code>GITHUB_TOKEN</code> environment variable
          </li>
          <li>
            GitHub CLI: run <code>gh auth login</code>, then retry
          </li>
          <li>A token saved here earlier (stored in the system keychain)</li>
        </ol>
        <p class="muted">
          Or paste a personal access token: classic with the <code>repo</code> scope, or fine-grained with{" "}
          <em>Pull requests: read &amp; write</em> and <em>Contents: read</em>.
        </p>
        <input
          type="password"
          placeholder="ghp_… or github_pat_…"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          autofocus
          spellcheck={false}
          autocomplete="off"
          data-testid="token-input"
        />
        <Show when={error()}>
          <div class="auth-error">{error()}</div>
        </Show>
        <div class="auth-actions">
          <button type="button" class="btn" onClick={() => void props.store.init()}>
            Retry detection
          </button>
          <button type="submit" class="btn primary" disabled={busy() || !token().trim()}>
            {busy() ? "Signing in…" : "Save token"}
          </button>
        </div>
      </form>
    </div>
  );
}
