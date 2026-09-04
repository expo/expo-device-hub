import { useRef, useState } from 'react';

import {
  type CameraFacing,
  type DeviceCameraFeed,
  type DeviceClient,
} from '@expo/hub-client';
import { bg, border, radius, text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { SidebarActionButton } from './SidebarActionButton';
import { SidebarRow } from './SidebarRow';

const FACING_LABELS: Record<CameraFacing, string> = {
  back: 'Back',
  front: 'Front',
};

function CameraRestartRow({
  onRestartWithCamera,
  restarting,
}: {
  onRestartWithCamera?: () => Promise<void>;
  restarting: boolean;
}) {
  return (
    <SidebarRow label="Camera feeds attach when the emulator starts." borderBottom={false}>
      <SidebarActionButton
        disabled={!onRestartWithCamera || restarting}
        onClick={() => void onRestartWithCamera?.()}>
        Restart with camera
      </SidebarActionButton>
    </SidebarRow>
  );
}

function CameraFeedRow({
  client,
  feed,
  borderBottom,
}: {
  client: DeviceClient;
  feed: DeviceCameraFeed;
  borderBottom: boolean;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = client.cameraPending.has(feed.facing);
  const source = feed.placeholder ? null : feed.imageUrl;

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        // dragleave also fires when the pointer crosses into a child of the row.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTarget(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropTarget(false);
        const file: File | undefined = event.dataTransfer.files[0];
        if (file) client.setCameraImage(feed.facing, file);
      }}
      style={{ backgroundColor: dropTarget ? bg.selected : undefined }}>
      <SidebarRow compact label={FACING_LABELS[feed.facing]} borderBottom={borderBottom}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              display: 'flex',
              width: 85,
              height: 64,
              flexShrink: 0,
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              backgroundColor: bg.element,
              border: `1px solid ${border.default}`,
              borderRadius: radius.md,
            }}>
            {source ? (
              <img
                src={source}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <span style={{ ...textSize.xs, color: text.tertiary }}>No image</span>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 6,
            }}>
            {feed.width !== null && feed.height !== null && (
              <span style={{ ...textSize.xs, color: text.secondary }}>
                {feed.width}×{feed.height}
              </span>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <SidebarActionButton disabled={pending} onClick={() => fileInput.current?.click()}>
                Choose image…
              </SidebarActionButton>
              <SidebarActionButton
                disabled={pending || feed.placeholder}
                onClick={() => client.clearCameraImage(feed.facing)}>
                Clear
              </SidebarActionButton>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  input.value = '';
                  if (file) client.setCameraImage(feed.facing, file);
                }}
              />
            </div>
          </div>
        </div>
      </SidebarRow>
    </div>
  );
}

/**
 * Emulator camera feeds: a PNG preview per facing that the viewer can replace by
 * picking or dropping an image, or reset to serve-emu's placeholder.
 */
export function CameraSection({
  client,
  onRestartWithCamera,
  restarting = false,
}: {
  client: DeviceClient;
  onRestartWithCamera?: () => Promise<void>;
  /** A restart is already in flight. */
  restarting?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const camera = client.camera;

  if (!camera) return null;

  return (
    <CollapsibleSection title="Camera" open={open} onOpenChange={setOpen}>
      {camera.wiredAtLaunch ? (
        camera.feeds.map((feed, index) => (
          <CameraFeedRow
            key={feed.facing}
            client={client}
            feed={feed}
            borderBottom={index < camera.feeds.length - 1}
          />
        ))
      ) : (
        <CameraRestartRow onRestartWithCamera={onRestartWithCamera} restarting={restarting} />
      )}
      {client.cameraError && (
        <span
          role="alert"
          style={{
            ...textSize.xs,
            display: 'block',
            padding: '0 0 8px',
            color: text.danger,
          }}>
          {client.cameraError}
        </span>
      )}
      <span
        style={{ ...textSize.xs, display: 'block', padding: '8px 0 0', color: text.secondary }}>
        Apps see the new image after they reopen the camera.
      </span>
    </CollapsibleSection>
  );
}
