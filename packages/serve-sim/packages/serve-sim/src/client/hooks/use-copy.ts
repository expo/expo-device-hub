import { useEffect, useRef, useState } from "react";

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timerRef.current ? clearTimeout(timerRef.current) : undefined), []);
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      },
      () => {}
    );
  };
  return [copied, copy];
}
