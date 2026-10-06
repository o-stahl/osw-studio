'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Secret } from '@/lib/vfs/types';
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
import { Loader2, AlertCircle, Eye, EyeOff, Info } from 'lucide-react';

const KEY_EXAMPLE = 'sk_live_...'; // i18n-ignore: the shape of an API key, not prose

interface SecretEditorProps {
  secret: Secret | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { name: string; value?: string; description?: string }) => Promise<void>;
}

export function SecretEditor({
  secret,
  isOpen,
  onClose,
  onSave,
}: SecretEditorProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const [name, setName] = useState(secret?.name || '');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState(secret?.description || '');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(secret?.name || '');
      setValue('');
      setDescription(secret?.description || '');
      setShowValue(false);
      setError(null);
    }
  }, [secret, isOpen]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Convert to SCREAMING_SNAKE_CASE
    const newValue = e.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '')
      .replace(/^[0-9]+/, ''); // Remove leading numbers
    setName(newValue);
  };

  const handleSave = async () => {
    setError(null);

    // Basic validation
    if (!name.trim()) {
      setError(t('validation.secretNameRequired'));
      return;
    }
    // Validate SCREAMING_SNAKE_CASE
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      setError(t('validation.secretNameFormat'));
      return;
    }
    // Value required for new secrets
    if (!secret && !value.trim()) {
      setError(t('validation.secretValueRequired'));
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        value: value.trim() || undefined,
        description: description.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveSecretFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {secret ? t('editSecret') : t('createSecret')}
          </DialogTitle>
          <DialogDescription>
            {t('secretDialogDesc', { name: name || 'NAME' })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('secretName')}</Label>
            <Input
              id="name"
              value={name}
              onChange={handleNameChange}
              placeholder={t('secretNamePlaceholder')}
              disabled={!!secret}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {t('screamingSnakeHelp')}
            </p>
          </div>

          {/* Value */}
          <div className="space-y-2">
            <Label htmlFor="value">
              {secret ? t('newValueLabel') : t('secretValueLabel')}
            </Label>
            <div className="relative">
              <Input
                id="value"
                type={showValue ? 'text' : 'password'}
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={secret ? t('newValuePlaceholder') : KEY_EXAMPLE}
                className="pr-10 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                onClick={() => setShowValue(!showValue)}
              >
                {showValue ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {secret ? t('leaveEmptyHelp') : t('encryptedHelp')}
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{tc('labels.descriptionOptional')}</Label>
            <Input
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('secretDescPlaceholder')}
            />
          </div>

          {/* Usage Reference */}
          <div className="bg-muted/30 border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4" />
              {t('usageInEdgeFunctions')}
            </div>
            <pre className="text-xs font-mono bg-background p-2 rounded overflow-x-auto">
{`// Get secret value
const apiKey = secrets.get('${name || 'STRIPE_API_KEY'}');

// Check if secret exists
if (secrets.has('${name || 'STRIPE_API_KEY'}')) {
  // Use the secret
}

// List all available secrets
const allSecrets = secrets.list(); // ['${name || 'STRIPE_API_KEY'}', ...]`}
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
              secret ? tc('actions.saveChanges') : t('createSecret')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
