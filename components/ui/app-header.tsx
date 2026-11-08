'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Logo } from '@/components/ui/logo';
import { Tip } from '@/components/ui/tooltip';
import { ChevronDown, ChevronUp, Menu } from 'lucide-react';

export interface HeaderAction {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  disabled?: boolean;
  content?: React.ReactNode;
  dataTourId?: string;
  /** The desktop tooltip, where it says more than the label: a shortcut, a state, or why it is off. */
  tip?: string;
}

export interface ViewTab {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface AppHeaderProps {
  title?: string;
  subtitle?: string;
  badge?: string;
  onLogoClick?: () => void;
  /** What the logo button does, as its tooltip. */
  logoTip?: string;
  actions?: HeaderAction[];
  mobileMenuContent?: React.ReactNode;
  desktopOnlyContent?: React.ReactNode; // Content shown only on desktop
  className?: string;
  leftText?: React.ReactNode; // Text to show next to logo on desktop, centered on mobile
  leftSubtext?: string; // Secondary line below leftText on mobile (e.g. active panel name)
  mobileVisibleActions?: string[]; // Action IDs to show outside dropdown on mobile
  viewTabs?: ViewTab[]; // View tabs for switching between sections
  activeViewTab?: string; // Currently active view tab
  onViewTabChange?: (tabId: string) => void; // Callback when view tab changes
  hideLogo?: boolean; // Hide the logo button (for use with sidebar)
  showMobileMenu?: boolean; // Show hamburger menu button on mobile (for sidebar)
  onMobileMenuClick?: () => void; // Callback when hamburger is clicked
  hideActionsOnMobile?: boolean; // Hide all actions on mobile (actions in sidebar instead)
  pageName?: string; // Page name to show in center on mobile (when showMobileMenu is true)
}

export function AppHeader({
  title,
  subtitle,
  badge,
  onLogoClick,
  logoTip,
  actions = [],
  mobileMenuContent,
  desktopOnlyContent,
  className = '',
  leftText,
  leftSubtext,
  mobileVisibleActions = [],
  viewTabs,
  activeViewTab,
  onViewTabChange,
  hideLogo = false,
  showMobileMenu = false,
  onMobileMenuClick,
  hideActionsOnMobile = false,
  pageName
}: AppHeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Split actions into mobile-visible and dropdown-only
  const mobileVisibleActionsSet = new Set(mobileVisibleActions);
  const visibleOnMobile = hideActionsOnMobile ? [] : actions.filter(a => mobileVisibleActionsSet.has(a.id));
  const dropdownOnlyActions = hideActionsOnMobile ? [] : actions.filter(a => !mobileVisibleActionsSet.has(a.id));

  return (
    <div className={`border-b bg-card shadow-sm relative z-20 ${className}`}>
      <div className="px-3 py-2 flex items-center justify-between">
        {/* Left side - Logo + pageName (mobile when showMobileMenu is true) */}
        {showMobileMenu && (
          <div className="md:hidden flex items-center gap-3">
            <Logo width={24} height={24} />
            {pageName && <span className="text-sm font-semibold">{pageName}</span>}
          </div>
        )}

        {/* Left side - Logo + text (desktop), empty (mobile with sidebar) */}
        {!hideLogo && !showMobileMenu && (
          <Tip label={logoTip} side="bottom" align="start">
            <button
              onClick={onLogoClick}
              className="flex items-center gap-2 p-1 pr-2 hover:ring-1 hover:ring-border rounded-sm transition-all"
            >
              <Logo width={24} height={24} />
              {leftText && (
                <div className="flex flex-col items-start min-w-0">
                  <span className="font-semibold text-sm md:text-lg truncate max-w-[160px] md:max-w-none">{leftText}</span>
                  {leftSubtext && <span className="text-xs text-muted-foreground md:hidden">{leftSubtext}</span>}
                </div>
              )}
            </button>
          </Tip>
        )}

        {/* Center - View tabs or leftText/title (desktop only now) */}
        <div className="flex items-center gap-2 flex-1 justify-center md:justify-start md:ml-6">
          {viewTabs && viewTabs.length > 0 ? (
            /* Show view tabs as pill toggle */
            <div className="flex border rounded-full">
              {viewTabs.map((tab, index) => (
                <Button
                  key={tab.id}
                  variant={activeViewTab === tab.id ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => onViewTabChange?.(tab.id)}
                  className={`gap-2 ${
                    index === 0 ? 'rounded-r-none rounded-l-full' :
                    index === viewTabs.length - 1 ? 'rounded-l-none rounded-r-full' :
                    'rounded-none'
                  }`}
                >
                  {tab.icon && <tab.icon className="h-4 w-4" />}
                  {tab.label}
                </Button>
              ))}
            </div>
          ) : title ? (
            <>
              {title && <h1 className="text-lg md:text-xl font-semibold">{title}</h1>}
              {badge && <Badge variant="secondary">{badge}</Badge>}
            </>
          ) : null}
        </div>

        {/* Desktop - Show subtitle only if no leftText and no center title */}
        {!leftText && !title && subtitle && (
          <div className="hidden md:flex items-center flex-1 ml-6">
            <span className="text-sm text-muted-foreground">{subtitle}</span>
          </div>
        )}

        {/* Right side controls */}
        <div className="flex items-center gap-2">
          {/* Desktop actions */}
          <div className="hidden md:flex items-center gap-2">
            {actions.map((action) => (
              action.content ? (
                <div key={action.id}>{action.content}</div>
              ) : (
                <Tip key={action.id} label={action.tip} side="bottom">
                  <Button
                    variant={action.variant || 'outline'}
                    size={action.size || 'sm'}
                    onClick={action.onClick}
                    disabled={action.disabled}
                    className="justify-start"
                    data-tour-id={action.dataTourId}
                  >
                    {action.icon && <action.icon className="h-4 w-4 mr-2" />}
                    {action.label}
                  </Button>
                </Tip>
              )
            ))}
            {desktopOnlyContent}
          </div>

          {/* Mobile visible actions */}
          <div className="md:hidden flex items-center gap-2">
            {visibleOnMobile.map((action) => (
              action.content ? (
                <div key={action.id}>{action.content}</div>
              ) : (
                <Button
                  key={action.id}
                  variant={action.variant || 'outline'}
                  size={action.size || 'sm'}
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className="h-8 px-3"
                  data-tour-id={action.dataTourId}
                >
                  {action.icon && <action.icon className="h-4 w-4 mr-2" />}
                  {action.label}
                </Button>
              )
            ))}
          </div>

          {/* Mobile menu toggle */}
          {(dropdownOnlyActions.length > 0 || mobileMenuContent) && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="h-8 w-8 md:hidden"
            >
              {mobileMenuOpen ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          )}

          {/* Mobile hamburger menu (on right side) */}
          {showMobileMenu && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onMobileMenuClick}
              className="md:hidden h-8 w-8"
            >
              <Menu className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>
      
      {/* Mobile dropdown menu */}
      {mobileMenuOpen && (dropdownOnlyActions.length > 0 || mobileMenuContent) && (
        <div className="md:hidden border-t bg-muted/30 px-4 py-4 space-y-3">
          {/* Show subtitle on mobile if no leftText and no center title */}
          {!leftText && !title && subtitle && (
            <div className="pb-2 border-b border-border/50">
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            </div>
          )}

          {/* Mobile dropdown-only actions */}
          {dropdownOnlyActions.length > 0 && (
            <div className="space-y-2">
              {dropdownOnlyActions.map((action) => (
                action.content ? (
                  <div key={action.id}>{action.content}</div>
                ) : (
                  <Button
                    key={action.id}
                    variant={action.variant || 'outline'}
                    size={action.size || 'sm'}
                    onClick={() => {
                      action.onClick();
                      setMobileMenuOpen(false);
                    }}
                    disabled={action.disabled}
                    className="w-full justify-start"
                    data-tour-id={action.dataTourId}
                  >
                    {action.icon && <action.icon className="h-4 w-4 mr-2" />}
                    {action.label}
                  </Button>
                )
              ))}
            </div>
          )}

          {/* Custom mobile menu content */}
          {mobileMenuContent && (
            <div className="pt-2 border-t border-border/50">
              {mobileMenuContent}
            </div>
          )}
        </div>
      )}
    </div>
  );
}