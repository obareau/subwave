'use client';

import * as React from 'react';
import * as NavigationMenuPrimitive from '@radix-ui/react-navigation-menu';

import { cn } from '@/lib/cn';

// Not the DropdownMenu in this folder: that is role="menu"/"menuitem", an
// application-menu contract. Site navigation is a list of LINKS, and announcing
// it as a menu misleads screen-reader users about what enter does.
// NavigationMenu renders a real <nav>/<ul>/<a> tree and opens on hover too.
//
// Divergence: the default shadcn trigger skin (rounded pills, h-9, text-sm) is
// NOT carried over — the masthead is newsprint, so styling lives with the bs-*
// vocabulary in globals.css and is applied at the call site
// (components/landing/CommunityMenu.tsx). Only structure stays here.

// Divergence: no <NavigationMenuViewport /> mounted here, unlike the registry
// default. The viewport is one shared surface sized from a measurement of the
// active content — that earns its keep for a multi-item menu bar, but for a
// one-item menu in a centred flex row the measured width fought the masthead's
// layout and the content rendered unanchored over the article. Radix treats it
// as optional; without one each Content renders inside its own Item, which is
// the anchoring we want (callers position against the Item, see
// .bs-masthead-panel). Still exported for anyone who wants the shared surface.
const NavigationMenu = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <NavigationMenuPrimitive.Root
    ref={ref}
    className={cn('relative z-20 flex max-w-max items-center justify-center', className)}
    {...props}
  >
    {children}
  </NavigationMenuPrimitive.Root>
));
NavigationMenu.displayName = NavigationMenuPrimitive.Root.displayName;

const NavigationMenuList = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.List>
>(({ className, ...props }, ref) => (
  <NavigationMenuPrimitive.List
    ref={ref}
    // gap-1, not space-x-1 — the registry default trips the repo's
    // better-tailwindcss lint and the shadcn house rule both.
    className={cn('group flex flex-1 list-none items-center justify-center gap-1', className)}
    {...props}
  />
));
NavigationMenuList.displayName = NavigationMenuPrimitive.List.displayName;

const NavigationMenuItem = NavigationMenuPrimitive.Item;

const NavigationMenuTrigger = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <NavigationMenuPrimitive.Trigger ref={ref} className={cn('group', className)} {...props}>
    {children}
  </NavigationMenuPrimitive.Trigger>
));
NavigationMenuTrigger.displayName = NavigationMenuPrimitive.Trigger.displayName;

const NavigationMenuContent = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <NavigationMenuPrimitive.Content
    ref={ref}
    className={cn(
      'data-[motion^=from-]:animate-in data-[motion^=from-]:fade-in data-[motion^=to-]:animate-out data-[motion^=to-]:fade-out',
      className,
    )}
    {...props}
  />
));
NavigationMenuContent.displayName = NavigationMenuPrimitive.Content.displayName;

const NavigationMenuLink = NavigationMenuPrimitive.Link;

const NavigationMenuViewport = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <div className="absolute top-full left-0 flex w-full justify-center">
    <NavigationMenuPrimitive.Viewport
      // h-[var(--x)] is an arbitrary VALUE and is fine under Tailwind v4; the
      // form that breaks is the bare custom property, h-[--x].
      className={cn(
        'relative mt-2 h-[var(--radix-navigation-menu-viewport-height)] w-full origin-top overflow-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:w-[var(--radix-navigation-menu-viewport-width)]',
        className,
      )}
      ref={ref}
      {...props}
    />
  </div>
));
NavigationMenuViewport.displayName = NavigationMenuPrimitive.Viewport.displayName;

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuContent,
  NavigationMenuTrigger,
  NavigationMenuLink,
  NavigationMenuViewport,
};
