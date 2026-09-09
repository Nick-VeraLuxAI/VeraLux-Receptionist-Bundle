import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-[2px] border border-vl-border-strong bg-white px-3 py-2 text-base placeholder:text-vl-muted focus-visible:border-vl-gold-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-gold/25 disabled:cursor-not-allowed disabled:bg-vl-warm disabled:opacity-60 md:text-sm",
        className
      )}
      ref={ref}
      {...props} />
  );
})
Textarea.displayName = "Textarea"

export { Textarea }
