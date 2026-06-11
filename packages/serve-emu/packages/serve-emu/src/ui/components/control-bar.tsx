export type HardwareKey = "back" | "home" | "recents" | "power";

type Props = {
  onPress: (key: HardwareKey) => void;
};

const BUTTONS: { key: HardwareKey; label: string }[] = [
  { key: "back", label: "Back" },
  { key: "home", label: "Home" },
  { key: "recents", label: "Recents" },
  { key: "power", label: "Power" },
];

export function ControlBar({ onPress }: Props) {
  return (
    <footer>
      {BUTTONS.map((b) => (
        <button key={b.key} onClick={() => onPress(b.key)}>
          {b.label}
        </button>
      ))}
    </footer>
  );
}
