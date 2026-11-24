import { type RefObject, useLayoutEffect } from "react";

/**
 * While `active`, makes every sibling of the element inert, also a sibling that
 * mounts later. A full-screen element uses it so that focus and clicks cannot
 * reach the page behind it. Each sibling gets its own `inert` value back when
 * `active` ends.
 */
export function useInertSiblings(ref: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const element = ref.current;
    const parent = element?.parentElement;
    if (!parent) return;
    const previous = new Map<HTMLElement, boolean>();
    const protectSiblings = () => {
      for (const node of parent.children) {
        if (node === element || !(node instanceof HTMLElement) || previous.has(node)) continue;
        previous.set(node, node.inert);
        node.inert = true;
      }
    };
    protectSiblings();
    const observer = new MutationObserver(protectSiblings);
    observer.observe(parent, { childList: true });
    return () => {
      observer.disconnect();
      previous.forEach((inert, node) => {
        node.inert = inert;
      });
    };
  }, [ref, active]);
}
