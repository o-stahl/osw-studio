'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isForbiddenHeaderName } from '@/lib/llm/providers/custom-headers';

export interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

/** Rows for a saved provider, so editing one field does not drop the headers on another. */
export function headerRowsFrom(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ id: crypto.randomUUID(), name, value }));
}

export function headersFromRows(rows: HeaderRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/**
 * Names a second row claims after an earlier one already has it.
 *
 * Compared without case, because header names are case-insensitive: X-Tenant and x-tenant are one
 * header, and the later would replace the earlier inside fetch with nothing said about it.
 */
export function duplicateHeaderNames(rows: HeaderRow[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const lower = row.name.trim().toLowerCase();
    if (lower === '') continue;
    if (seen.has(lower)) duplicates.push(row.name.trim());
    else seen.add(lower);
  }
  return duplicates;
}

/** Names a row carries that can never be sent, for refusing a save with a reason. */
export function unusableHeaderNames(rows: HeaderRow[]): string[] {
  return [
    ...rows.filter((r) => isForbiddenHeaderName(r.name)).map((r) => r.name.trim()),
    ...duplicateHeaderNames(rows),
  ];
}

/**
 * Name/value rows for the extra headers a custom endpoint is given.
 *
 * Shared by the add and edit drawers: the two write through the same
 * `buildCustomProviderConfig`, so a difference between them would show up as headers surviving one
 * path and not the other.
 *
 * Values are masked by default. They are as sensitive as the API token, being the tenant or routing
 * credential a gateway authenticates with.
 */
export function CustomHeadersEditor({
  rows,
  onChange,
  disabled,
  idPrefix,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const [showValues, setShowValues] = useState(false);
  const duplicates = new Set(duplicateHeaderNames(rows).map((n) => n.toLowerCase()));

  const edit = (id: string, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>
          {t('extraHeaders')}
          <span className="text-muted-foreground text-xs ml-1">{tc('labels.optionalParen')}</span>
        </Label>
        {rows.length > 0 && (
          <Button
            size="icon" variant="ghost" className="h-7 w-7"
            onClick={() => setShowValues(!showValues)}
            aria-label={showValues ? t('hideHeaderValues') : t('showHeaderValues')}
            disabled={disabled}
          >
            {showValues ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        {t('extraHeadersHint')}
      </p>

      <div className="space-y-2 mt-2">
        {rows.map((row, index) => {
          const bad = isForbiddenHeaderName(row.name) || duplicates.has(row.name.trim().toLowerCase());
          return (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                id={`${idPrefix}-header-name-${index}`}
                value={row.name}
                onChange={(e) => edit(row.id, { name: e.target.value })}
                placeholder="X-Tenant" // i18n-ignore: an example header name
                aria-label={t('headerName')}
                aria-invalid={bad || undefined}
                className={bad ? 'flex-1 border-destructive' : 'flex-1'}
                disabled={disabled}
              />
              <Input
                id={`${idPrefix}-header-value-${index}`}
                type={showValues ? 'text' : 'password'}
                value={row.value}
                onChange={(e) => edit(row.id, { value: e.target.value })}
                placeholder="acme" // i18n-ignore: an example header value
                aria-label={t('headerValue')}
                className="flex-1"
                disabled={disabled}
              />
              <Button
                size="icon" variant="ghost" className="h-8 w-8 shrink-0"
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                aria-label={t('removeHeader')}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          );
        })}

        {rows.some((r) => isForbiddenHeaderName(r.name) || duplicates.has(r.name.trim().toLowerCase())) && (
          <p className="text-xs text-destructive">
            {t('invalidHeaderNames')}
          </p>
        )}

        <Button
          variant="outline" size="sm"
          onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: '', value: '' }])}
          disabled={disabled}
        >
          <Plus className="h-3 w-3 mr-1" />
          {t('addHeader')}
        </Button>
      </div>
    </div>
  );
}
