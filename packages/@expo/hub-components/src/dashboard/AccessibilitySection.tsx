import { useEffect, useState } from 'react';

import { type AccessibilityNode, type DeviceClient } from '@expo/hub-client';
import { bg, border, radius, text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { SectionNote } from './SectionNote';
import { SidebarActionButton } from './SidebarActionButton';
import { SidebarRow } from './SidebarRow';

const LIST_MAX_HEIGHT = 320;

function AccessibilityStatus({ client }: { client: DeviceClient }) {
  if (client.accessibilityPending) {
    return <SectionNote role="status">Reading the screen…</SectionNote>;
  }
  if (client.accessibilityError) {
    return <SectionNote role="alert">{client.accessibilityError}</SectionNote>;
  }
  const snapshot = client.accessibility;
  if (!snapshot) return null;
  if (snapshot.nodes.length === 0) {
    return <SectionNote>No accessible elements on this screen.</SectionNote>;
  }
  return <SectionNote>{`Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}`}</SectionNote>;
}

function tapNode(client: DeviceClient, node: AccessibilityNode) {
  const x = node.frame.x + node.frame.width / 2;
  const y = node.frame.y + node.frame.height / 2;
  client.sendTouch({ phase: 'begin', x, y, edgeGestures: false });
  client.sendTouch({ phase: 'end', x, y });
}

/** The accessibility tree of the current screen: one row per element, click to tap it. */
export function AccessibilitySection({
  client,
  defaultOpen = false,
}: {
  client: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { accessibility, accessibilityPending, refreshAccessibility } = client;

  useEffect(() => {
    if (open) refreshAccessibility();
  }, [open, refreshAccessibility]);

  const nodes = accessibility?.nodes ?? [];

  return (
    <CollapsibleSection title="Accessibility" open={open} onOpenChange={setOpen}>
      <SidebarRow label="Elements">
        <SidebarActionButton disabled={accessibilityPending} onClick={refreshAccessibility}>
          Refresh
        </SidebarActionButton>
      </SidebarRow>
      <AccessibilityStatus client={client} />
      {nodes.length > 0 && (
        <div
          style={{
            display: 'flex',
            maxHeight: LIST_MAX_HEIGHT,
            flexDirection: 'column',
            overflowY: 'auto',
            padding: 4,
            boxSizing: 'border-box',
            border: `1px solid ${border.default}`,
            borderRadius: radius.lg,
            backgroundColor: bg.subtle,
          }}>
          {nodes.map((node, index) => {
            const meta = [node.role, node.clickable ? 'tappable' : '']
              .filter(Boolean)
              .join(' · ');
            return (
              <button
                key={`${node.id}-${index}`}
                type="button"
                aria-label={`Tap ${node.label}`}
                disabled={!node.enabled}
                onClick={() => tapNode(client, node)}
                style={{
                  display: 'flex',
                  width: '100%',
                  minWidth: 0,
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: '6px 8px',
                  boxSizing: 'border-box',
                  border: 0,
                  borderRadius: radius.md,
                  backgroundColor: 'transparent',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  cursor: node.enabled ? 'pointer' : 'default',
                  opacity: node.enabled ? 1 : 0.5,
                }}>
                <span
                  style={{
                    ...textSize.sm,
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: text.default,
                  }}>
                  {node.label}
                </span>
                {meta && <span style={{ ...textSize.xs, color: text.tertiary }}>{meta}</span>}
              </button>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}
