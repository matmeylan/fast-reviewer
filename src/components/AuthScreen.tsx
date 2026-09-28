import { createSignal, Show } from "solid-js";
import logoUrl from "../../assets/logo.svg";
import { errorMessage, type AppStore } from "../lib/store";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

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

  const code = "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground";

  return (
    <div class="grid flex-1 place-items-center overflow-auto p-6" data-testid="auth">
      <form class="w-full max-w-md select-text" onSubmit={submit}>
        <Card data-size="lg">
          <CardHeader>
            <img class="mb-2 block" src={logoUrl} alt="" width="64" height="64" draggable={false} />
            <CardTitle class="text-lg">Sign in to GitHub</CardTitle>
            <CardDescription>
              Fast Reviewer needs a token to read pull requests and mark files as viewed. It looks for one
              automatically, in this order:
            </CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-4">
            <ol class="flex list-decimal flex-col gap-1.5 pl-5 marker:text-muted-foreground">
              <li>
                <code class={code}>GH_TOKEN</code> or <code class={code}>GITHUB_TOKEN</code> environment variable
              </li>
              <li>
                GitHub CLI: run <code class={code}>gh auth login</code>, then retry
              </li>
              <li>A token saved here earlier (stored in the system keychain)</li>
            </ol>
            <p class="text-muted-foreground">
              Or paste a personal access token: classic with the <code class={code}>repo</code> scope, or fine-grained
              with <em>Pull requests: read &amp; write</em> and <em>Contents: read</em>.
            </p>
            <div class="flex flex-col gap-2">
              <Input
                type="password"
                class="font-mono"
                placeholder="ghp_… or github_pat_…"
                value={token()}
                onInput={(e) => setToken(e.currentTarget.value)}
                autofocus
                spellcheck={false}
                autocomplete="off"
                aria-invalid={error() ? true : undefined}
                data-testid="token-input"
              />
              <Show when={error()}>
                <div class="text-sm text-destructive">{error()}</div>
              </Show>
            </div>
          </CardContent>
          <CardFooter class="justify-end gap-2">
            <Button variant="outline" onClick={() => void props.store.init()}>
              Retry detection
            </Button>
            <Button type="submit" disabled={busy() || !token().trim()}>
              {busy() ? "Signing in…" : "Save token"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
