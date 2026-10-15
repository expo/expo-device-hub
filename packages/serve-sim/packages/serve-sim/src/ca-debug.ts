export const CA_DEBUG_FLAGS = {
  blended: "debug_color_blended",
  copies: "debug_color_copies",
  misaligned: "debug_color_misaligned",
  offscreen: "debug_color_offscreen",
  "slow-animations": "debug_slow_animations",
} as const;

export const CA_DEBUG_ALIASES: Record<string, string> = {
  ...CA_DEBUG_FLAGS,
  copied: CA_DEBUG_FLAGS.copies,
  slow: CA_DEBUG_FLAGS["slow-animations"],
};
