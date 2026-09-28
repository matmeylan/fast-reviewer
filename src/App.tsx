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
import { Button } from "./components/ui/button";
import { Kbd } from "./components/ui/kbd";
import { Spinner } from "./components/ui/spinner";
import GitPullRequest from "lucide-solid/icons/git-pull-request";
import Keyboard from "lucide-solid/icons/keyboard";

const KEY_SIDEBAR = "fr.sidebarWidth";
const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 720;
const DEFAULT_SIDEBAR = 320;
/** Actions that make sense to auto-repeat while a key is held. */
const REPEATABLE = new Set<Action>(["next", "prev", "skip", "nextHunk", "prevHunk"]);
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
/** Actions that move within the file list, and ones that work inside the diff. */
const TREE_ACTIONS = new Set<Action>(["review", "skip", "next", "prev", "toggleViewed", "focusFilter"]);
const DIFF_ACTIONS = new Set<Action>(["nextHunk", "prevHunk"]);

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
    <Show when={store()} fallback={<div class="app h-full" />}>
      {(s) => <Shell store={s()} />}
    </Show>
  );
}

function Shell(props: { store: AppStore }) {
  const s = props.store;
  const initial = Number(storage.get(KEY_SIDEBAR));
  const [width, setWidth] = createSignal(initial >= MIN_SIDEBAR ? initial : DEFAULT_SIDEBAR);

  // Like an IDE, the file list shows its selection in the accent color only while
  // it is the pane being worked in (last clicked, or driven by file shortcuts).
  const [treeActive, setTreeActive] = createSignal(true);

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || s.phase() !== "ready") return;
    const action = keyToAction(e, isTypingTarget(e.target));
    if (!action || (e.repeat && !REPEATABLE.has(action))) return;
    e.preventDefault();
    if (TREE_ACTIONS.has(action)) setTreeActive(true);
    else if (DIFF_ACTIONS.has(action)) setTreeActive(false);
    s.dispatch(action);
  };
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Element | null;
    if (target?.closest?.(".sidebar")) setTreeActive(true);
    else if (target?.closest?.(".main")) setTreeActive(false);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onPointerDown, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onPointerDown, true);
  });

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
    <div class="app flex h-full flex-col" classList={{ mac: isMac }}>
      <div
        class="titlebar flex h-(--titlebar-h) flex-none items-center gap-2 border-b bg-sidebar pr-2"
        data-tauri-drag-region
      >
        <Show when={s.phase() === "ready"}>
          <Button
            variant="outline"
            size="sm"
            class="title-btn w-72 justify-between pr-1 font-normal text-muted-foreground"
            onClick={() => s.dispatch("picker")}
            title="Open pull request"
          >
            <span class="flex min-w-0 items-center gap-1.5">
              <GitPullRequest />
              <span class="truncate">
                <Show when={s.pr()} fallback="Open pull request…">
                  {(p) => (
                    <>
                      {p().owner}/{p().repo}
                      <span class="text-foreground">#{p().number}</span>
                    </>
                  )}
                </Show>
              </span>
            </span>
            <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
          </Button>
          <div class="flex-1 self-stretch" data-tauri-drag-region />
          <Button variant="ghost" size="icon-sm" onClick={() => s.dispatch("help")} title="Keyboard shortcuts (?)">
            <Keyboard />
          </Button>
          <Show when={s.auth()?.login}>
            {(login) => (
              <span
                class="flex items-center gap-2 pr-1 pl-1 text-xs text-muted-foreground"
                title={`Signed in via ${s.auth()?.source}`}
                data-tauri-drag-region
              >
                <span class="grid size-6 place-items-center rounded-full bg-muted text-[0.7rem] font-medium text-foreground uppercase">
                  {login().slice(0, 1)}
                </span>
                {login()}
              </span>
            )}
          </Show>
        </Show>
      </div>
      <Switch>
        <Match when={s.phase() === "loading"}>
          <div class="flex flex-1 items-center justify-center">
            <Spinner class="size-5" />
          </div>
        </Match>
        <Match when={s.phase() === "auth"}>
          <AuthScreen store={s} />
        </Match>
        <Match when={s.phase() === "ready"}>
          <div class="flex min-h-0 flex-1" style={{ "--sidebar-w": `${width()}px` }}>
            <Sidebar store={s} treeActive={treeActive()} />
            <div
              class="resizer relative z-10 -mx-1 w-2 flex-none cursor-col-resize"
              onPointerDown={startResize}
              onDblClick={() => setWidth(DEFAULT_SIDEBAR)}
            />
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
