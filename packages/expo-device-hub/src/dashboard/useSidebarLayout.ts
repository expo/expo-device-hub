import { useEffect, useRef, useState } from 'react';

export type RightSidebarPreference = 'auto' | 'open' | 'hidden';
export type SidebarSide = 'left' | 'right';

type SidebarLayoutOptions = {
  leftOpen: boolean;
  rightPreference: RightSidebarPreference;
  containerWidth: number;
  leftWidth: number;
  rightWidth: number;
  minStreamWidth: number;
};

export type SidebarLayout = {
  leftDocked: boolean;
  leftOverlay: boolean;
  rightOpen: boolean;
  rightDocked: boolean;
  rightOverlay: boolean;
};

/** Resolve docking from the space that is actually available, without viewport breakpoints. */
export function resolveSidebarLayout({
  leftOpen,
  rightPreference,
  containerWidth,
  leftWidth,
  rightWidth,
  minStreamWidth,
}: SidebarLayoutOptions): SidebarLayout {
  const rightFits = containerWidth >= rightWidth + minStreamWidth;
  const rightOpen = rightPreference === 'open' || (rightPreference === 'auto' && rightFits);
  const rightDocked = rightOpen && rightFits;
  const leftDocked =
    leftOpen &&
    containerWidth >= leftWidth + minStreamWidth + (rightDocked ? rightWidth : 0);

  return {
    leftDocked,
    leftOverlay: leftOpen && !leftDocked,
    rightOpen,
    rightDocked,
    rightOverlay: rightOpen && !rightDocked,
  };
}

/** Owns sidebar intent and measures the dashboard rather than inferring space from breakpoints. */
export function useSidebarLayout({
  leftWidth,
  rightWidth,
  minStreamWidth,
}: Pick<SidebarLayoutOptions, 'leftWidth' | 'rightWidth' | 'minStreamWidth'>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth
  );
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightPreference, setRightPreference] = useState<RightSidebarPreference>('auto');
  const [lastOpened, setLastOpened] = useState<SidebarSide>('right');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => setContainerWidth(container.getBoundingClientRect().width);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const layout = resolveSidebarLayout({
    leftOpen,
    rightPreference,
    containerWidth,
    leftWidth,
    rightWidth,
    minStreamWidth,
  });

  const openLeft = () => {
    setLeftOpen(true);
    setLastOpened('left');
  };
  const closeLeft = () => setLeftOpen(false);
  const openRight = () => {
    const rightFits = containerWidth >= rightWidth + minStreamWidth;
    setRightPreference(rightFits ? 'auto' : 'open');
    setLastOpened('right');
  };
  const closeRight = () => setRightPreference('hidden');

  return {
    ...layout,
    containerRef,
    containerWidth,
    leftOpen,
    lastOpened,
    openLeft,
    closeLeft,
    openRight,
    closeRight,
  };
}
