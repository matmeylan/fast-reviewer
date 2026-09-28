import { render } from "solid-js/web";
import App from "./App";
import { warmHighlighter } from "./lib/highlight-client";
import "./styles.css";

// Boot the highlight worker (Shiki core + theme) while the app starts, so the first diff doesn't pay for it.
warmHighlighter();
// Start fetching the code font now so the first diff renders in it.
void document.fonts?.load('13px "JetBrains Mono Variable"').catch(() => {});

render(() => <App />, document.getElementById("root")!);
