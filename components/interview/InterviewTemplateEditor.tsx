'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { InterviewTemplate } from '@/lib/interview/types';
import {
  emptyForm,
  templateToForm,
  formToTemplate,
  validateTemplateForm,
  slugify,
  type TemplateForm,
} from '@/lib/interview/template-form';
import { interviewTemplatesService } from '@/lib/interview/templates-service';
import { track } from '@/lib/telemetry';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { ArrowLeft, Save, Plus, Trash2 } from 'lucide-react';

interface InterviewTemplateEditorProps {
  template: InterviewTemplate | null; // null = create
  onSaved: () => void;
  onCancel: () => void;
}

function derivedArtifactPath(title: string): string {
  return `/.interviews/${slugify(title) || 'untitled'}.md`;
}

export function InterviewTemplateEditor({ template, onSaved, onCancel }: InterviewTemplateEditorProps) {
  const t = useTranslations('interviews');
  const te = useTranslations('interviews.editor');
  const tc = useTranslations('common');
  const tg = useTranslations('generationShelf');
  const tp = useTranslations('publishSettings');
  const isCreate = template === null;
  const readOnly = template?.isBuiltIn === true;

  const [form, setForm] = useState<TemplateForm>(() =>
    template ? templateToForm(template) : emptyForm()
  );
  const [saving, setSaving] = useState(false);

  const handleTitleChange = (title: string) => {
    setForm(prev => {
      const next: TemplateForm = { ...prev, title };
      // Only auto-derive the artifact path when creating and the user hasn't
      // manually edited it away from the previously-derived value.
      if (isCreate) {
        const prevDerived = derivedArtifactPath(prev.title);
        if (prev.artifactPath === prevDerived || prev.artifactPath === '/.interviews/untitled.md') {
          next.artifactPath = derivedArtifactPath(title);
        }
      }
      return next;
    });
  };

  const updateItem = (index: number, patch: Partial<TemplateForm['items'][number]>) => {
    setForm(prev => ({
      ...prev,
      items: prev.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    }));
  };

  const addItem = () => {
    setForm(prev => ({
      ...prev,
      items: [...prev.items, { question: '', criteria: '', required: true }],
    }));
  };

  const removeItem = (index: number) => {
    setForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
  };

  const handoffEnabled = form.handoff !== null;
  const setHandoffEnabled = (enabled: boolean) => {
    setForm(prev => ({
      ...prev,
      handoff: enabled ? (prev.handoff ?? { label: '', prompt: '', mode: 'code' }) : null,
    }));
  };
  const updateHandoff = (patch: Partial<NonNullable<TemplateForm['handoff']>>) => {
    setForm(prev => ({
      ...prev,
      handoff: prev.handoff ? { ...prev.handoff, ...patch } : prev.handoff,
    }));
  };

  const handleSave = async () => {
    const err = validateTemplateForm(form);
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const id = await interviewTemplatesService.generateId(form.title);
        await interviewTemplatesService.createTemplate(formToTemplate(form, id));
        track('interview_template_created');
        toast.success(t('createdTemplate', { title: form.title.trim() }));
      } else {
        await interviewTemplatesService.updateTemplate(template.id, formToTemplate(form, template.id));
        toast.success(t('updatedTemplate', { title: form.title.trim() }));
      }
      onSaved();
    } catch (e) {
      const message = e instanceof Error ? e.message : t('saveFailed');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col bg-background h-[inherit]">
      {/* Header */}
      <div className="border-b px-6 py-4 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold truncate">
                {readOnly ? te('viewTitle') : isCreate ? te('createTitle') : te('editTitle')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {readOnly ? te('readOnlySub') : te('editSub')}
              </p>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              {readOnly ? tc('actions.close') : tc('actions.cancel')}
            </Button>
            {!readOnly && (
              <Button onClick={handleSave} disabled={saving}>
                <Save className="w-4 h-4 mr-2" />
                {saving ? tc('actions.saving') : tc('actions.save')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-6 max-w-3xl">
          {readOnly && (
            <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
              {te('builtInNote')}
            </div>
          )}

          {!readOnly && (
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground leading-relaxed space-y-2">
              <p>{te('modeExplainer')}</p>
              <p>
                {te.rich('artifactExplainer', {
                  b: chunks => <span className="font-medium text-foreground">{chunks}</span>,
                  code: chunks => <code className="font-mono">{chunks}</code>,
                })}
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="template-title">{te('titleLabel')}</Label>
            <Input
              id="template-title"
              placeholder={te('titlePlaceholder')}
              value={form.title}
              onChange={(e) => handleTitleChange(e.target.value)}
              disabled={readOnly}
              className="mt-1.5"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {te('titleHelp')}
            </p>
          </div>

          <div>
            <Label htmlFor="template-description">{tc('labels.description')}</Label>
            <Input
              id="template-description"
              placeholder={te('descPlaceholder')}
              value={form.description}
              onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
              disabled={readOnly}
              className="mt-1.5"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {te('descHelp')}
            </p>
          </div>

          <div>
            <Label htmlFor="template-artifact">{te('artifactLabel')}</Label>
            <Input
              id="template-artifact"
              placeholder="/.interviews/site-plan.md"
              value={form.artifactPath}
              onChange={(e) => setForm(prev => ({ ...prev, artifactPath: e.target.value }))}
              disabled={readOnly}
              className="mt-1.5 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {te('artifactHelp')}
            </p>
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>{te('itemsLabel')}</Label>
              {!readOnly && (
                <Button variant="outline" size="sm" onClick={addItem}>
                  <Plus className="w-4 h-4 mr-2" />
                  {te('addItem')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              {te('itemsHelp')}
            </p>
            <div className="space-y-4">
              {form.items.map((item, i) => (
                <div key={i} className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">{te('itemN', { n: i + 1 })}</span>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeItem(i)}
                        title={t('removeItem')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <div>
                    <Label htmlFor={`item-question-${i}`} className="text-xs">{t('question')}</Label>
                    <Textarea
                      id={`item-question-${i}`}
                      placeholder={te('questionPlaceholder')}
                      value={item.question}
                      onChange={(e) => updateItem(i, { question: e.target.value })}
                      disabled={readOnly}
                      className="mt-1.5 min-h-[64px]"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {te('questionHelp')}
                    </p>
                  </div>
                  <div>
                    <Label htmlFor={`item-criteria-${i}`} className="text-xs">
                      {te('doneWhenLabel')}
                    </Label>
                    <Textarea
                      id={`item-criteria-${i}`}
                      placeholder={te('criteriaPlaceholder')}
                      value={item.criteria}
                      onChange={(e) => updateItem(i, { criteria: e.target.value })}
                      disabled={readOnly}
                      className="mt-1.5 min-h-[64px]"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {te('criteriaHelp')}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer w-fit">
                    <Checkbox
                      checked={item.required}
                      onCheckedChange={(checked) => updateItem(i, { required: checked === true })}
                      disabled={readOnly}
                    />
                    <span className="text-sm">{t('required')}</span>
                  </label>
                </div>
              ))}
              {form.items.length === 0 && (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  {te('noItems')}
                </div>
              )}
            </div>
          </div>

          {/* Handoff */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <Checkbox
                checked={handoffEnabled}
                onCheckedChange={(checked) => setHandoffEnabled(checked === true)}
                disabled={readOnly}
              />
              <span className="text-sm font-medium">{t('handoffAction')}</span>
            </label>
            <p className="text-xs text-muted-foreground">
              {te('handoffHelp')}
            </p>
            {handoffEnabled && form.handoff && (
              <div className="space-y-3 pt-1">
                <div>
                  <Label htmlFor="handoff-label" className="text-xs">{t('buttonLabel')}</Label>
                  <Input
                    id="handoff-label"
                    placeholder={te('handoffLabelPlaceholder')}
                    value={form.handoff.label}
                    onChange={(e) => updateHandoff({ label: e.target.value })}
                    disabled={readOnly}
                    className="mt-1.5"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {te('handoffLabelHelp')}
                  </p>
                </div>
                <div>
                  <Label htmlFor="handoff-prompt" className="text-xs">{tg('prompt')}</Label>
                  <Textarea
                    id="handoff-prompt"
                    placeholder={te('handoffPromptPlaceholder')}
                    value={form.handoff.prompt}
                    onChange={(e) => updateHandoff({ prompt: e.target.value })}
                    disabled={readOnly}
                    className="mt-1.5 min-h-[64px]"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {te('handoffPromptHelp')}
                  </p>
                </div>
                <div>
                  <Label className="text-xs">{tp('mode')}</Label>
                  <Select
                    value={form.handoff.mode}
                    onValueChange={(v) => updateHandoff({ mode: v as 'code' | 'chat' })}
                    disabled={readOnly}
                  >
                    <SelectTrigger className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="code">{tc('labels.code')}</SelectItem>
                      <SelectItem value="chat">{tc('terms.chat')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {te('modeHelp')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
