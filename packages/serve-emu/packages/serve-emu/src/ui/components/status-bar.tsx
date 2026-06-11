import type { DeviceSize } from "../lib/use-stream";

type Props = {
  status: string;
  deviceSize: DeviceSize | null;
  fps: number;
};

export function StatusBar({ status, deviceSize, fps }: Props) {
  const meta =
    status +
    (deviceSize ? ` • ${deviceSize.width}×${deviceSize.height} • ${fps} fps` : "");
  return (
    <header>
      <h1>serve-emu</h1>
      <div className="meta">{meta}</div>
    </header>
  );
}
