'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import MonacoEditor from '@monaco-editor/react';
import { ServerFunction } from '@/lib/vfs/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, AlertCircle, Info } from 'lucide-react';
import { useTheme } from 'next-themes';

interface ServerFunctionEditorProps {
  function: ServerFunction | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<ServerFunction>) => Promise<void>;
}

const DEFAULT_CODE = `// Server functions receive arguments via the 'args' array
// and have access to 'db' and 'fetch'

// Example: Validate an API key
const [apiKey] = args;
if (!apiKey) {
  return { valid: false, error: 'No API key provided' };
}

const users = db.query(
  'SELECT id, name FROM users WHERE api_key = ?',
  [apiKey]
);

if (users.length === 0) {
  return { valid: false, error: 'Invalid API key' };
}

return { valid: true, user: users[0] };
`;

export function ServerFunctionEditor({
  function: fn,
  isOpen,
  onClose,
  onSave,
}: ServerFunctionEditorProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const [name, setName] = useState(fn?.name || '');
  const [description, setDescription] = useState(fn?.description || '');
  const [code, setCode] = useState(fn?.code || DEFAULT_CODE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setName(fn?.name || '');
      setDescription(fn?.description || '');
      setCode(fn?.code || DEFAULT_CODE);
      setError(null);
    }
  }, [fn, isOpen]);

  const handleSave = async () => {
    setError(null);

    // Basic validation
    if (!name.trim()) {
      setError(t('validation.functionNameRequired'));
      return;
    }
    // Validate JS identifier (camelCase or snake_case)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      setError(t('validation.identifierName'));
      return;
    }
    // Check reserved names
    const reserved = ['db', 'fetch', 'console', 'args', 'request', 'Response', 'server'];
    if (reserved.includes(name)) {
      setError(t('reservedName', { name }));
      return;
    }
    if (!code.trim()) {
      setError(t('validation.functionCodeRequired'));
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        code,
        enabled: fn?.enabled ?? true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveHelperFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  const shownName = name || 'name'; // i18n-ignore: a code identifier standing in for the helper's name

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {fn ? t('editHelper') : t('createHelperTitle')}
          </DialogTitle>
          <DialogDescription>
            {t.rich('helperDialogDesc', { name: shownName, code: (chunks) => <span className="font-mono">{chunks}</span> })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('functionName')}</Label>
            <Input
              id="name"
              value={name}
              onChange={e => setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              placeholder="validateAuth"
              disabled={!!fn}
            />
            <p className="text-xs text-muted-foreground">
              {t.rich('helperUsage', { name: shownName, code: (chunks) => <span className="font-mono">{chunks}</span> })}
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{tc('labels.descriptionOptional')}</Label>
            <Input
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('helperPlaceholder')}
            />
          </div>

          {/* Code Editor */}
          <div className="space-y-2">
            <Label>{t('functionCode')}</Label>
            <div className="h-64 border rounded-lg overflow-hidden">
              <MonacoEditor
                language="javascript"
                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
                value={code}
                onChange={value => setCode(value || '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            </div>
          </div>

          {/* API Reference */}
          <div className="bg-muted/30 border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4" />
              {t('availableInHelpers')}
            </div>
            <div className="grid gap-2 text-xs font-mono">
              <div><span className="text-orange-500">args</span> - {t('apiArgsDesc')}</div>
              <div><span className="text-green-500">db</span>.query(sql, params), .run(sql, params), .all(sql, params)</div>
              <div><span className="text-yellow-500">fetch</span>(url, options) - {t('apiFetchDesc')}</div>
              <div><span className="text-blue-500">console</span>.log(), .error(), .warn() - {t('apiConsoleDesc')}</div>
            </div>
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs text-muted-foreground">
                {t.rich('helperNote', { b: (chunks) => <strong>{chunks}</strong> })}
              </p>
            </div>
          </div>

          {/* Example */}
          <div className="bg-muted/30 border rounded-lg p-4 space-y-2">
            <div className="text-sm font-medium">{t('helperExample')}</div>
            <pre className="text-xs font-mono bg-background p-2 rounded overflow-x-auto">
{`// Edge function code
const auth = server.${name || 'validateAuth'}(request.headers['x-api-key']);
if (!auth.valid) {
  Response.error(auth.error, 401);
  return;
}

// User is authenticated
const products = db.query('SELECT * FROM products WHERE user_id = ?', [auth.user.id]);
Response.json({ products });`}
            </pre>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {tc('actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {tc('actions.saving')}
              </>
            ) : (
              fn ? tc('actions.saveChanges') : t('createFunction')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
