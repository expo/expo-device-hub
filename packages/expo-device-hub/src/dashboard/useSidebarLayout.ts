import { useEffect, useRef, useState } from 'react';

export type SidebarPreference = 'auto' | 'open' | 'hidden';
export type SidebarSide = 'left' | 'right';

type SidebarLayoutOptions = {
  leftPreference: SidebarPreference;
  rightPreference: SidebarPreference;
  containerWidth: number;
  leftWidth: number;
  rightWidth: number;
  minStreamWidth: number;
};

export type SidebarLayout = {
  leftOpen: boolean;
  leftDocked: boolean;
  leftOverlay: boolean;
  rightOpen: boolean;
  rightDocked: boolean;
  rightOverlay: boolean;
};

/** Resolve docking from the space that is actually available, without viewport breakpoints. */
export function resolveSidebarLayout({
  leftPreference,
  rightPreference,
  containerWidth,
  leftWidth,
  rightWidth,
  minStreamWidth,
}: SidebarLayoutOptions): SidebarLayout {
  const rightFits = containerWidth >= rightWidth + minStreamWidth;
  const rightOpen = rightPreference === 'open' || (rightPreference === 'auto' && rightFits);
  const rightDocked = rightOpen && rightFits;
  const leftFits =
    containerWidth >= leftWidth + minStreamWidth + (rightDocked ? rightWidth : 0);
  const leftOpen = leftPreference === 'open' || (leftPreference === 'auto' && leftFits);
  const leftDocked = leftOpen && leftFits;

  return {
    leftOpen,
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
  const [leftPreference, setLeftPreference] = useState<SidebarPreference>('auto');
  const [rightPreference, setRightPreference] = useState<SidebarPreference>('auto');
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
    leftPreference,
    rightPreference,
    containerWidth,
    leftWidth,
    rightWidth,
    minStreamWidth,
  });

  const openLeft = () => {
    const leftFits =
      containerWidth >=
      leftWidth + minStreamWidth + (layout.rightDocked ? rightWidth : 0);
    setLeftPreference(leftFits ? 'auto' : 'open');
    setLastOpened('left');
  };
  const closeLeft = () => setLeftPreference('hidden');
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
    leftOpen: layout.leftOpen,
    lastOpened,
    openLeft,
    closeLeft,
    openRight,
    closeRight,
  };
}
