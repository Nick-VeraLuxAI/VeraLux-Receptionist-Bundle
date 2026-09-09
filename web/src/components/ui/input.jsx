import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-[2px] border border-vl-border-strong bg-white px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-vl-muted focus-visible:border-vl-gold-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-gold/25 disabled:cursor-not-allowed disabled:bg-vl-warm disabled:opacity-60 md:text-sm",
        className
      )}
      ref={ref}
      {...props} />
  );
})
Input.displayName = "Input"

export { Input }
