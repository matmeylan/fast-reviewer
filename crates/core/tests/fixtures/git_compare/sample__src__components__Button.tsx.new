import { JSX } from "solid-js";

interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function Button(props: ButtonProps): JSX.Element {
  return <button class="btn btn-primary" disabled={props.disabled} onClick={props.onClick}>{props.label}</button>;
}
