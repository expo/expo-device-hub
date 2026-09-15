/**
 * serve-emu keys its input queue by `touch:<pointerId>`, so each finger needs
 * its own message with a stable id.
 */

import { type MultiTouchSample, type TouchSample } from './types';

type UnitPoint = MultiTouchSample['a'];
type TouchPhase = TouchSample['phase'];

export type AndroidTouchMessage = {
  type: 'touch';
  action: 'down' | 'move' | 'up';
  x: number;
  y: number;
  pointerId: number;
};

const WIRE_ACTION: Record<TouchPhase, AndroidTouchMessage['action']> = {
  begin: 'down',
  move: 'move',
  end: 'up',
};

export function androidTouchMessage(
  phase: TouchPhase,
  point: UnitPoint,
  pointerId: number,
): AndroidTouchMessage {
  return { type: 'touch', action: WIRE_ACTION[phase], x: point.x, y: point.y, pointerId };
}
