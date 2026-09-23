import { type ButtonHTMLAttributes, useState } from "react";

const BASE =
  "w-9 h-9 sm:w-[30px] sm:h-[30px] shrink-0 flex items-center justify-center p-0 bg-transparent border-none rounded-md cursor-pointer touch-manipulation [transition:background_0.15s_ease,color_0.15s_ease,opacity_0.1s_ease]";

export function IconButton({
  className = "",
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      className={`${BASE} ${
        pressed
          ? "bg-white/12 text-white opacity-60"
          : "text-[#8e8e93] hover:bg-white/8 hover:text-white"
      } ${className}`}
      onPointerDown={(e) => {
        setPressed(true);
        onPointerDown?.(e);
      }}
      onPointerUp={(e) => {
        setPressed(false);
        onPointerUp?.(e);
      }}
      onPointerCancel={(e) => {
        setPressed(false);
        onPointerCancel?.(e);
      }}
      onPointerLeave={(e) => {
        setPressed(false);
        onPointerLeave?.(e);
      }}
      {...rest}
    />
  );
}
