'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations, type NumberFormatOptions } from 'next-intl';
import { configManager, CostSettings } from '@/lib/config/storage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

/** How a lifetime cost total is formatted. Small totals keep enough digits to show they are not zero. */
export function costTotalFormat(usd: number): NumberFormatOptions {
  return {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: usd > 0 && usd < 0.01 ? 4 : 2,
    maximumFractionDigits: usd > 0 && usd < 0.01 ? 4 : usd < 1 ? 3 : 2,
  };
}

export function CostTrackingPane() {
  const t = useTranslations('settings');
  const { number } = useLocalFormat();
  const formatTotal = (usd: number) => number(usd, costTotalFormat(usd));
  const [costSettings, setCostSettings] = useState<CostSettings>({});

  useEffect(() => {
    setCostSettings(configManager.getCostSettings());
  }, []);

  return (
    <div className="space-y-5">
      {/* Show Costs */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="show-costs">{t('displayCosts')}</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('showCostsHint')}
          </p>
        </div>
        <Switch
          id="show-costs"
          checked={costSettings.showCosts !== false}
          onCheckedChange={(checked) => {
            const newCostSettings = { ...costSettings, showCosts: checked };
            configManager.setCostSettings(newCostSettings);
            setCostSettings(newCostSettings);
          }}
        />
      </div>

      {/* Daily + Project Limits */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="daily-limit" className="text-xs">{t('dailyLimit')}</Label>
          <Input
            id="daily-limit"
            type="number"
            min="0"
            step="0.01"
            placeholder={t('noLimit')}
            className="mt-1.5"
            value={costSettings.dailyLimit || ''}
            onChange={(e) => {
              const value = e.target.value ? parseFloat(e.target.value) : undefined;
              const newCostSettings = { ...costSettings, dailyLimit: value };
              configManager.setCostSettings(newCostSettings);
              setCostSettings(newCostSettings);
            }}
          />
        </div>
        <div>
          <Label htmlFor="project-limit" className="text-xs">{t('projectLimit')}</Label>
          <Input
            id="project-limit"
            type="number"
            min="0"
            step="0.01"
            placeholder={t('noLimit')}
            className="mt-1.5"
            value={costSettings.projectLimit || ''}
            onChange={(e) => {
              const value = e.target.value ? parseFloat(e.target.value) : undefined;
              const newCostSettings = { ...costSettings, projectLimit: value };
              configManager.setCostSettings(newCostSettings);
              setCostSettings(newCostSettings);
            }}
          />
        </div>
      </div>

      {/* Warning Threshold */}
      <div>
        <Label htmlFor="warning-threshold" className="text-xs">{t('warningThreshold')}</Label>
        <div className="flex items-center gap-3 mt-1.5">
          <Input
            id="warning-threshold"
            type="number"
            min="50"
            max="100"
            step="5"
            className="flex-1"
            value={costSettings.warningThreshold || 80}
            onChange={(e) => {
              const value = parseInt(e.target.value, 10);
              if (isNaN(value)) return;
              const newCostSettings = { ...costSettings, warningThreshold: value };
              configManager.setCostSettings(newCostSettings);
              setCostSettings(newCostSettings);
            }}
          />
          <span className="text-xs text-muted-foreground flex items-center gap-1 whitespace-nowrap font-mono">
            <AlertTriangle className="h-3 w-3" />
            {t('warnAt', { percent: costSettings.warningThreshold || 80 })}
          </span>
        </div>
      </div>

      {/* Lifetime Costs */}
      <div className="flex items-center justify-between bg-muted/30 border rounded-lg p-3">
        <div>
          <div className="text-xs text-muted-foreground font-medium">{t('lifetimeTotal')}</div>
          <div className="text-lg font-bold font-mono tracking-tight mt-0.5">
            {formatTotal(configManager.getLifetimeCosts().total)}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (confirm(t('resetCostsConfirm'))) {
              configManager.resetLifetimeCosts();
              toast.success(t('costsReset'));
            }
          }}
        >
          {t('resetStats')}
        </Button>
      </div>
    </div>
  );
}
