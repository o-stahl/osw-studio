"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/lib/utils"

/** Set by a TooltipProvider, so a Tooltip under one shares it instead of bringing its own. */
const InsideProvider = React.createContext(false)

/**
 * Tooltips open after a short pause, and once one has shown, the next one opens at once (for 300 ms
 * after it closes), so running the pointer along a row of buttons reads them without waiting each
 * time. They close the moment the pointer leaves the trigger: the content can't be hovered.
 */
function TooltipProvider({
  delayDuration = 700,
  skipDelayDuration = 300,
  disableHoverableContent = true,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    >
      <InsideProvider.Provider value={true}>{children}</InsideProvider.Provider>
    </TooltipPrimitive.Provider>
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const inside = React.useContext(InsideProvider)
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  // A tooltip on its own (in a test, or outside the app's tree) still needs a provider.
  return inside ? root : <TooltipProvider>{root}</TooltipProvider>
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/**
 * Above every other layer, the menus (z-[100]), the providers drawer and banners (z-[60]) and the
 * guided tour (z-[2000]) included: a tooltip belongs to the control under the pointer, wherever
 * that control sits.
 */
function TooltipContent({
  className,
  sideOffset = 0,
  children,
  arrowStyle,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { arrowStyle?: React.CSSProperties }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "border border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))] text-primary shadow-md animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-[2100] w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow 
          className="bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))] fill-transparent border-r border-b border-primary/40 z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" 
          style={arrowStyle}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Keyboard focus shows a tooltip; focus a script moves after a click (a tab switch) does not, nor
 * focus a closing menu hands back, which comes from nowhere: its items are already gone.
 */
function opensOnFocus(event: React.FocusEvent) {
  return focusVisible(event.target) && event.relatedTarget !== null
}

function focusVisible(el: EventTarget) {
  if (!(el instanceof Element)) return true
  try {
    return el.matches(":focus-visible")
  } catch {
    return true
  }
}

type TipProps = {
  label?: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"]
  /** A colour of its own, as the rail's panel buttons have: background, text and border. */
  tone?: React.CSSProperties
  /**
   * Shows the tip from a span around the control rather than from the control. For a Radix control
   * that reports its own `data-state` (a switch, a select, a tab), which the tooltip's would replace.
   */
  wrap?: boolean
  /**
   * The classes of the span around a wrapped or disabled control, which stands in for it in its
   * row: a control that grows or stretches there needs its span to (`flex-1 grid`, `grid`).
   */
  wrapClassName?: string
  /** Shows only while the control's text is cut off: for a label the tip would otherwise repeat. */
  truncated?: boolean
  children: React.ReactElement
} & Omit<React.ComponentProps<"button">, "children">

/** Whether the element, or a `truncate` or line-clamped element inside it, has more text than room. */
function clipped(el: Element) {
  return [el, ...Array.from(el.querySelectorAll('.truncate, [class*="line-clamp-"]'))].some(
    (node) => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight
  )
}

/**
 * The app's tooltip on one control: `<Tip label={name}><Button aria-label={name}>…</Button></Tip>`. An
 * icon-only control still needs its own `aria-label`: a tooltip describes, it does not name.
 *
 * It goes innermost, next to the control, inside a menu or popover trigger rather than around one,
 * so the control keeps that trigger's `data-state`; around a switch, a select or a tab, which set
 * their own, it shows from a span (`wrap`). A disabled button takes no pointer events, so it is
 * wrapped too, to still say why it is off. Nothing shows while the control is pressed, which for a
 * drag handle is the whole drag, and none shows without a label.
 *
 * The tree is the same with a label and without one, so a control whose label comes and goes (gone
 * while a run, a menu or a save is under way) is never mounted again and keeps its focus.
 */
function Tip({ label, side, align, tone, wrap = false, wrapClassName = "inline-flex", truncated = false, children, onPointerDown, onPointerEnter, onPointerLeave, onFocus, ...rest }: TipProps) {
  const [held, setHeld] = React.useState(false)
  const [cut, setCut] = React.useState(false)
  const labelled = !(label === undefined || label === null || label === false || label === "")
  // A disabled button takes no pointer events, so a span shows its tip. A control with its own state
  // keeps its span without a label too, so that the span's classes hold in every state.
  const wrapped = wrap || (labelled && (children.props as { disabled?: unknown }).disabled === true)
  // Without a label the trigger carries none of the tooltip's state: no `data-state` but a menu's
  // around it, and no description pointing at content that never renders.
  const unset = (keep: boolean) =>
    labelled ? {} : {
      "data-state": keep ? (rest as Record<string, unknown>)["data-state"] : undefined,
      "aria-describedby": keep ? rest["aria-describedby"] : undefined,
    }
  // The handlers of a menu or drag around the tip stay with the control: a span around a disabled
  // one must not open the menu.
  const own = wrapped ? {} : { onPointerDown, onPointerEnter, onPointerLeave, onFocus }
  const handlers = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      own.onPointerDown?.(event)
      setHeld(true)
    },
    onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
      own.onPointerEnter?.(event)
      if (truncated) setCut(clipped(event.currentTarget))
    },
    onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => {
      own.onPointerLeave?.(event)
      setHeld(false)
    },
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
      own.onFocus?.(event)
      if (truncated) setCut(clipped(event.currentTarget))
      // Radix opens on any focus it did not see a press for; a prevented event stops it. The target,
      // since around a wrapped control the focus is the control's, reaching the span as it bubbles.
      if (!opensOnFocus(event)) event.preventDefault()
    },
  }
  return (
    <Tooltip>
      {wrapped ? (
        <TooltipTrigger asChild {...unset(false)} {...handlers}>
          <span className={wrapClassName}>
            <Slot onPointerDown={onPointerDown} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={onFocus} {...rest}>{children}</Slot>
          </span>
        </TooltipTrigger>
      ) : (
        <TooltipTrigger asChild {...rest} {...unset(true)} {...handlers}>
          {children}
        </TooltipTrigger>
      )}
      {labelled && !held && (!truncated || cut) && (
        <TooltipContent side={side} align={align} className="max-w-[280px]" style={tone} arrowStyle={tone}>
          {label}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Tip }
