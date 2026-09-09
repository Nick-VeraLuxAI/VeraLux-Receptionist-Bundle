import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[2px] border text-sm font-semibold tracking-[0.02em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-vl-text bg-vl-text text-white shadow-[0_4px_16px_rgba(18,17,16,0.16)] hover:-translate-y-px hover:border-[#2a2826] hover:bg-[#2a2826] hover:shadow-[0_8px_24px_rgba(18,17,16,0.22)]",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground shadow-sm hover:-translate-y-px hover:bg-destructive/90",
        outline:
          "border-vl-border-strong bg-white text-vl-text shadow-xs hover:border-vl-text hover:bg-white",
        secondary:
          "border-vl-border bg-vl-warm text-vl-text hover:border-vl-border-strong hover:bg-white",
        ghost: "border-transparent text-vl-secondary hover:bg-vl-warm hover:text-vl-text",
        link: "border-transparent text-vl-gold-deep shadow-none underline-offset-4 hover:text-vl-text hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-7",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
