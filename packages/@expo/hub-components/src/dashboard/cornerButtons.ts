/** Height of a floating corner button: the 40px box that wraps a 20px icon. */
const CORNER_BUTTON_SIZE = 40;
/** Height of the toggle in an open sidebar's header. */
const SIDEBAR_HEADER_TOGGLE_SIZE = 32;

/**
 * Top offset of the corner buttons on a phone, in px. The device starts 56px down, so the
 * 40px buttons need to sit well above it, or their icons crowd the device's top edge.
 */
export const MOBILE_CORNER_BUTTON_TOP = 12;

/**
 * Top padding of a phone's open sidebar, in px. It centers the header toggle on the same
 * line as the corner buttons, so the toggle does not jump when the sidebar opens.
 */
export const MOBILE_SIDEBAR_TOP_INSET =
  MOBILE_CORNER_BUTTON_TOP + (CORNER_BUTTON_SIZE - SIDEBAR_HEADER_TOGGLE_SIZE) / 2;
