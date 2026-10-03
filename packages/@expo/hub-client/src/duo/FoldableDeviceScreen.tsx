/**
 * The iPhone Duo as serve-sim's 3D preview: Xcode's model, textured with both
 * live panels, folding with the hinge. Rendered by `PhoneFrame` in place of
 * {@link DeviceScreen} while `client.hinge.modelActive` is set. Pointer input
 * is projected onto the active panel by the scene; the keyboard works as on
 * the flat screen.
 */

import { type CSSProperties, useCallback, useRef } from 'react';

import { DEVICE_SCREEN_STATUS_LAYOUT_STYLE, deviceScreenPresentsMedia } from '../DeviceScreen';
import { type DeviceClient } from '../types';
import { useDeviceKeyboard } from '../useDeviceKeyboard';
import { DuoModelView } from './DuoModelView';
import { DuoPanelStreams } from './DuoPanelStreams';

export interface FoldableDeviceScreenProps {
  client: DeviceClient;
  /** Freeze the departing panel's last frame while the device folds. */
  cacheScreenOnFold?: boolean;
  /** Keep the model at its physical size, or fill the stage as the hinge moves. */
  sizeMode?: 'physical' | 'fill';
  /** Xcode's model is missing or WebGL failed; the consumer should show the flat screen. */
  onUnavailable?: () => void;
}

const HOST_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  outline: 'none',
};

export function FoldableDeviceScreen({
  client,
  cacheScreenOnFold = false,
  sizeMode = 'fill',
  onUnavailable,
}: FoldableDeviceScreenProps) {
  const { hinge, status, error } = client;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const keyboard = useDeviceKeyboard(client);
  const setAngle = useCallback(
    (value: number) => hinge?.setControl({ control: 'angle', value }),
    [hinge],
  );
  if (!hinge || !hinge.modelUrl || !hinge.panels) return null;

  return (
    <div
      ref={hostRef}
      role="application"
      aria-label="Interactive iPhone Duo. Focus to control it with your keyboard. Press Shift and Escape to stop keyboard control."
      tabIndex={0}
      style={HOST_STYLE}
      onPointerDownCapture={() => hostRef.current?.focus({ preventScroll: true })}
      onBlur={keyboard.releasePressedKeys}
      onKeyDown={keyboard.onKeyDown}
      onKeyUp={keyboard.onKeyUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      <DuoModelView
        modelUrl={hinge.modelUrl}
        angle={hinge.angle}
        pose={hinge.pose}
        physicalPose={hinge.physicalPose}
        faceDown={hinge.faceDown}
        view={hinge.view}
        streamConfig={client.screen}
        hingeCommands={hinge.commands}
        onUnavailable={onUnavailable}
        streamError={status === 'error' ? error : null}
        cacheScreenOnFold={cacheScreenOnFold}
        sizeMode={sizeMode}
        onHingeAngleChange={setAngle}
        onTouch={hinge.sendModelTouch}
        onMultiTouch={hinge.sendModelMultiTouch}
        onScroll={hinge.sendModelScroll}
      >
        <DuoPanelStreams feeds={hinge.panels} activeScreenId={hinge.activeScreenId} />
      </DuoModelView>
      {!deviceScreenPresentsMedia(status) && status !== 'error' && (
        <div
          style={{
            ...DEVICE_SCREEN_STATUS_LAYOUT_STYLE,
            backgroundColor: 'transparent',
            alignItems: 'flex-end',
            color: 'rgba(255, 255, 255, 0.85)',
          }}
        >
          <span
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
            }}
          >
            {status === 'connecting' ? 'Connecting…' : 'Not connected'}
          </span>
        </div>
      )}
    </div>
  );
}
