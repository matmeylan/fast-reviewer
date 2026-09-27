import { createSignal, getOwner, Match, onCleanup, onMount, runWithOwner, Show, Switch } from "solid-js";
import { getBackend, type Backend } from "./lib/api";
import { isTypingTarget, keyToAction, type Action } from "./lib/keys";
import { createAppStore, storage, type AppStore } from "./lib/store";
import AuthScreen from "./components/AuthScreen";
import HelpOverlay from "./components/HelpOverlay";
import MainPane from "./components/MainPane";
import Picker from "./components/Picker";
import Sidebar from "./components/Sidebar";
import Toasts from "./components/Toasts";

const KEY_SIDEBAR = "fr.sidebarWidth";
const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 720;
/** Actions that make sense to auto-repeat while a key is held. */
const REPEATABLE = new Set<Action>(["next", "prev", "skip", "nextHunk", "prevHunk"]);
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export default function App(props: { backend?: Backend }) {
  const [store, setStore] = createSignal<AppStore | null>(null);
  // The store creates memos, so it must be owned by this component even after the await.
  const owner = getOwner();

  onMount(async () => {
    const backend = props.backend ?? (await getBackend());
    const s = runWithOwner(owner, () => createAppStore(backend))!;
    setStore(s);
    void s.init();
  });

  return (
    <Show when={store()} fallback={<div class="app" />}>
      {(s) => <Shell store={s()} />}
    </Show>
  );
}

function Shell(props: { store: AppStore }) {
  const s = props.store;
  const initial = Number(storage.get(KEY_SIDEBAR));
  const [width, setWidth] = createSignal(initial >= MIN_SIDEBAR ? initial : 300);

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || s.phase() !== "ready") return;
    const action = keyToAction(e, isTypingTarget(e.target));
    if (!action || (e.repeat && !REPEATABLE.has(action))) return;
    e.preventDefault();
    s.dispatch(action);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  function startResize(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = width();
    const move = (ev: PointerEvent) =>
      setWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w0 + ev.clientX - x0)));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      storage.set(KEY_SIDEBAR, String(width()));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  return (
    <div class="app" classList={{ mac: isMac }}>
      <div class="titlebar" data-tauri-drag-region>
        <Show when={s.phase() === "ready"}>
          <button class="title-btn" onClick={() => s.dispatch("picker")} title="Open pull request">
            <Show when={s.pr()} fallback="Open pull request">
              {(p) => (
                <>
                  {p().owner}/{p().repo}#{p().number}
                </>
              )}
            </Show>
            <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <div class="title-spacer" data-tauri-drag-region />
          <button class="icon-btn" onClick={() => s.dispatch("help")} title="Keyboard shortcuts (?)">
            ?
          </button>
          <Show when={s.auth()?.login}>
            <span class="login" title={`Signed in via ${s.auth()?.source}`} data-tauri-drag-region>
              {s.auth()?.login}
            </span>
          </Show>
        </Show>
      </div>
      <Switch>
        <Match when={s.phase() === "loading"}>
          <div class="placeholder">
            <div class="spinner" />
          </div>
        </Match>
        <Match when={s.phase() === "auth"}>
          <AuthScreen store={s} />
        </Match>
        <Match when={s.phase() === "ready"}>
          <div class="workspace" style={{ "--sidebar-w": `${width()}px` }}>
            <Sidebar store={s} />
            <div class="resizer" onPointerDown={startResize} onDblClick={() => setWidth(300)} />
            <MainPane store={s} />
          </div>
          <Show when={s.pickerOpen()}>
            <Picker store={s} dismissable={!!s.pr() || !!s.prLoading()} />
          </Show>
          <Show when={s.overlay() === "help"}>
            <HelpOverlay store={s} />
          </Show>
        </Match>
      </Switch>
      <Toasts store={s} />
    </div>
  );
}
