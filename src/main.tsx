import { render } from "solid-js/web";
import App from "./App";
import { warmHighlighter } from "./lib/highlight-client";
import "./styles.css";

// Boot the highlight worker (Shiki core + theme) while the app starts, so the first diff doesn't pay for it.
warmHighlighter();

render(() => <App />, document.getElementById("root")!);
