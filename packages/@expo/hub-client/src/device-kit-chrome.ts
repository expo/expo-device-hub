export interface DeviceKitChromeDescriptor {
  identifier: string;
  screenId?: number;
  displayVariants?: Record<number, DeviceKitChromeDescriptor>;
  frame: DeviceKitChromeSize;
  body: DeviceKitChromeRect;
  screen: DeviceKitChromeRect;
  insets: DeviceKitChromeInsets;
  outerCornerRadius: number;
  innerCornerRadius: number;
  screenRadius: number;
  screenCornerRadii?: {
    topLeft: number;
    topRight: number;
    bottomRight: number;
    bottomLeft: number;
  };
  compositeImage: string | null;
  slice: DeviceKitChromeSlice | null;
  corner: DeviceKitChromeSize | null;
  buttons: DeviceKitChromeButton[];
}

export interface DeviceKitChromeButton {
  name: string;
  image: string;
  imageDown: string | null;
  onTop: boolean;
  frame: DeviceKitChromeRect;
  hover: { x: number; y: number };
  usagePage: number | null;
  usage: number | null;
}

export interface DeviceKitChromeSlice {
  topLeft: string;
  top: string;
  topRight: string;
  right: string;
  bottomRight: string;
  bottom: string;
  bottomLeft: string;
  left: string;
}

export interface DeviceKitChromeSize {
  width: number;
  height: number;
}

export interface DeviceKitChromeRect extends DeviceKitChromeSize {
  x: number;
  y: number;
}

export interface DeviceKitChromeInsets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** An image served by the device's existing DeviceKit artwork endpoint. */
export interface DeviceKitChromeAsset {
  identifier: string;
  image: string;
}

/** Resolve an asset to a same-origin URL or an authenticated, preloaded blob URL. */
export type DeviceKitChromeAssetResolver = (
  identifier: string,
  image: string,
) => string | undefined;

/** Relative to the mounted serve-sim middleware; does not include credentials. */
export function deviceKitChromeAssetPath(identifier: string, image: string): string {
  // v2 honors the PDF page rotation; old rasterizations were cached immutable.
  return `grid/api/devicekit-chrome?chrome=${encodeURIComponent(identifier)}&image=${encodeURIComponent(image)}&v=2`;
}

/** Assets used by the renderer, including pressed buttons and alternate displays. */
export function getDeviceKitChromeAssets(
  chrome: DeviceKitChromeDescriptor,
): DeviceKitChromeAsset[] {
  const assets = new Map<string, DeviceKitChromeAsset>();
  const visited = new Set<DeviceKitChromeDescriptor>();
  const visit = (descriptor: DeviceKitChromeDescriptor) => {
    if (visited.has(descriptor)) return;
    visited.add(descriptor);
    const add = (image: string | null) => {
      if (image)
        assets.set(JSON.stringify([descriptor.identifier, image]), {
          identifier: descriptor.identifier,
          image,
        });
    };
    if (descriptor.compositeImage) add(descriptor.compositeImage);
    else if (descriptor.slice && descriptor.corner) Object.values(descriptor.slice).forEach(add);
    for (const button of descriptor.buttons) {
      add(button.image);
      add(button.imageDown);
    }
    Object.values(descriptor.displayVariants ?? {}).forEach(visit);
  };
  visit(chrome);
  return [...assets.values()];
}
