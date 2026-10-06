'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PublishSettings, ScriptConfig } from '@/lib/vfs/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { Plus, Edit, Trash2, Code } from 'lucide-react';

interface ScriptsTabProps {
  settings: PublishSettings;
  onChange: (settings: PublishSettings) => void;
}

export function ScriptsTab({ settings, onChange }: ScriptsTabProps) {
  const t = useTranslations('publishSettings');
  const tc = useTranslations('common');
  const [editingScript, setEditingScript] = useState<ScriptConfig | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [scriptPosition, setScriptPosition] = useState<'head' | 'body'>('head');

  const allScripts = [
    ...settings.headScripts.map(s => ({ ...s, position: 'head' as const })),
    ...settings.bodyScripts.map(s => ({ ...s, position: 'body' as const })),
  ];

  const handleAddScript = () => {
    const newScript: ScriptConfig = {
      id: `script-${Date.now()}`,
      name: '',
      content: '',
      type: 'inline',
      enabled: true,
    };
    setEditingScript(newScript);
    setScriptPosition('head');
    setIsDialogOpen(true);
  };

  const handleEditScript = (script: ScriptConfig, position: 'head' | 'body') => {
    setEditingScript(script);
    setScriptPosition(position);
    setIsDialogOpen(true);
  };

  const handleDeleteScript = (scriptId: string) => {
    if (!confirm(t('confirmDeleteScript'))) return;

    onChange({
      ...settings,
      headScripts: settings.headScripts.filter(s => s.id !== scriptId),
      bodyScripts: settings.bodyScripts.filter(s => s.id !== scriptId),
    });
  };

  const handleToggleScript = (scriptId: string, position: 'head' | 'body') => {
    const scripts = position === 'head' ? settings.headScripts : settings.bodyScripts;
    const updatedScripts = scripts.map(s =>
      s.id === scriptId ? { ...s, enabled: !s.enabled } : s
    );

    onChange({
      ...settings,
      [position === 'head' ? 'headScripts' : 'bodyScripts']: updatedScripts,
    });
  };

  const handleSaveScript = () => {
    if (!editingScript || !editingScript.name.trim()) {
      alert(t('scriptNameRequired'));
      return;
    }

    const targetArray = scriptPosition === 'head' ? settings.headScripts : settings.bodyScripts;
    const otherArray = scriptPosition === 'head' ? settings.bodyScripts : settings.headScripts;

    // Check if editing existing or creating new
    const existingIndex = targetArray.findIndex(s => s.id === editingScript.id);
    let updatedScripts;

    if (existingIndex >= 0) {
      // Update existing
      updatedScripts = [...targetArray];
      updatedScripts[existingIndex] = editingScript;
    } else {
      // Check if it exists in the other position
      const existsInOther = otherArray.some(s => s.id === editingScript.id);
      if (existsInOther) {
        // Move from other position to current
        const filtered = otherArray.filter(s => s.id !== editingScript.id);
        onChange({
          ...settings,
          [scriptPosition === 'head' ? 'headScripts' : 'bodyScripts']: [...targetArray, editingScript],
          [scriptPosition === 'head' ? 'bodyScripts' : 'headScripts']: filtered,
        });
        setIsDialogOpen(false);
        setEditingScript(null);
        return;
      } else {
        // Add new
        updatedScripts = [...targetArray, editingScript];
      }
    }

    onChange({
      ...settings,
      [scriptPosition === 'head' ? 'headScripts' : 'bodyScripts']: updatedScripts,
    });

    setIsDialogOpen(false);
    setEditingScript(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <SectionHeader icon={Code} title={t('scripts')}>
          <Button onClick={handleAddScript} size="sm" variant="outline">
            <Plus className="h-4 w-4" />
            {t('addScript')}
          </Button>
        </SectionHeader>
        <SectionBody className="space-y-3">
      {allScripts.length === 0 ? (
        <div className="text-center p-8 border-2 border-dashed rounded-lg">
          <Code className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <h3 className="text-lg font-semibold mb-2">{t('noScripts')}</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {t('noScriptsHint')}
          </p>
          <Button onClick={handleAddScript} variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            {t('addFirstScript')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {allScripts.map((script) => (
            <div
              key={script.id}
              className="flex items-start gap-4 p-4 border rounded-lg hover:bg-accent/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-semibold truncate">{script.name}</h4>
                  <Badge variant={script.position === 'head' ? 'default' : 'secondary'}>
                    {script.position === 'head' ? '<head>' : t('positionBody')}
                  </Badge>
                  <Badge variant="outline">
                    {script.type}
                  </Badge>
                  {script.async && <Badge variant="outline">async</Badge>}
                  {script.defer && <Badge variant="outline">defer</Badge>}
                </div>
                <p className="text-sm text-muted-foreground truncate">
                  {script.type === 'inline'
                    ? `${script.content.length} characters`
                    : script.content}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={script.enabled}
                  onCheckedChange={() => handleToggleScript(script.id, script.position)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEditScript(script, script.position)}
                >
                  <Edit className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteScript(script.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
        </SectionBody>
      </Section>

      {/* Script Editor Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingScript?.name ? t('editScript') : t('addScriptTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('scriptDialogDesc')}
            </DialogDescription>
          </DialogHeader>

          {editingScript && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="script-name">{t('scriptName')}</Label>
                <Input
                  id="script-name"
                  placeholder={t('scriptNamePlaceholder')}
                  value={editingScript.name}
                  onChange={(e) =>
                    setEditingScript({ ...editingScript, name: e.target.value })
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="script-position">{t('position')}</Label>
                  <Select
                    value={scriptPosition}
                    onValueChange={(value: 'head' | 'body') => setScriptPosition(value)}
                  >
                    <SelectTrigger id="script-position">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="head">{t('positionHead')}</SelectItem>
                      <SelectItem value="body">{t('positionBody')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="script-type">{tc('labels.type')}</Label>
                  <Select
                    value={editingScript.type}
                    onValueChange={(value: 'inline' | 'external') =>
                      setEditingScript({ ...editingScript, type: value })
                    }
                  >
                    <SelectTrigger id="script-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inline">{t('inlineScript')}</SelectItem>
                      <SelectItem value="external">{t('externalUrl')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="script-content">
                  {editingScript.type === 'inline' ? t('scriptCode') : t('scriptUrl')}
                </Label>
                {editingScript.type === 'inline' ? (
                  <Textarea
                    id="script-content"
                    placeholder="<script>...</script>"
                    rows={8}
                    value={editingScript.content}
                    onChange={(e) =>
                      setEditingScript({ ...editingScript, content: e.target.value })
                    }
                    className="font-mono text-sm"
                  />
                ) : (
                  <Input
                    id="script-content"
                    type="url"
                    placeholder="https://example.com/script.js"
                    value={editingScript.content}
                    onChange={(e) =>
                      setEditingScript({ ...editingScript, content: e.target.value })
                    }
                  />
                )}
              </div>

              {editingScript.type === 'external' && (
                <div className="flex gap-4">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="script-async"
                      checked={editingScript.async || false}
                      onCheckedChange={(checked) =>
                        setEditingScript({ ...editingScript, async: checked })
                      }
                    />
                    <Label htmlFor="script-async">Async</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="script-defer"
                      checked={editingScript.defer || false}
                      onCheckedChange={(checked) =>
                        setEditingScript({ ...editingScript, defer: checked })
                      }
                    />
                    <Label htmlFor="script-defer">Defer</Label>
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              {tc('actions.cancel')}
            </Button>
            <Button onClick={handleSaveScript}>{t('saveScript')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
