'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Skill } from '@/lib/vfs/skills/types';
import { skillsService } from '@/lib/vfs/skills';
import { createSkillTemplate, parseSkillFile, generateSkillFile } from '@/lib/vfs/skills/parser';
import { track } from '@/lib/telemetry';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { ArrowLeft, Save, FileText } from 'lucide-react';

interface SkillEditorProps {
  skill: Skill | null;
  mode: 'create' | 'edit';
  onSave: () => void;
  onCancel: () => void;
}

export function SkillEditor({ skill, mode, onSave, onCancel }: SkillEditorProps) {
  const t = useTranslations('skills');
  const te = useTranslations('skills.editor');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [rawContent, setRawContent] = useState('');
  const [activeTab, setActiveTab] = useState<'form' | 'raw'>('form');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (skill) {
      setName(skill.name);
      setDescription(skill.description);
      setMarkdown(skill.markdown);
      setRawContent(skill.content);
    } else {
      const template = createSkillTemplate('my-skill', 'Description of your skill');
      setRawContent(template);
      try {
        const { frontmatter, markdown } = parseSkillFile(template);
        setName(frontmatter.name);
        setDescription(frontmatter.description);
        setMarkdown(markdown);
      } catch (error) {
        // Ignore parse errors for template
      }
    }
  }, [skill]);

  const handleFormChange = () => {
    // When form fields change, regenerate the raw content
    try {
      const newContent = generateSkillFile({ name, description }, markdown);
      setRawContent(newContent);
    } catch (error) {
      // Ignore errors while typing
    }
  };

  const handleRawChange = (newRaw: string) => {
    setRawContent(newRaw);
    // Try to parse and update form fields
    try {
      const { frontmatter, markdown } = parseSkillFile(newRaw);
      setName(frontmatter.name);
      setDescription(frontmatter.description);
      setMarkdown(markdown);
    } catch (error) {
      // Ignore parse errors while editing
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Validate using parser
      const { frontmatter } = parseSkillFile(rawContent);

      if (mode === 'create') {
        await skillsService.createSkill(rawContent);
        track('skill_created');
        toast.success(t('createdSkill', { name: frontmatter.name }));
      } else if (skill) {
        await skillsService.updateSkill(skill.id, rawContent);
        toast.success(t('updatedSkill', { name: frontmatter.name }));
      }

      onSave();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('saveSkillFailed');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'form') {
      handleFormChange();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, markdown, activeTab]);

  return (
    <div className="flex flex-col bg-background h-[inherit]">
      {/* Header */}
      <div className="border-b px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">
                {mode === 'create' ? te('createTitle') : te('editTitle')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {te('subtitle')}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>
              {tc('actions.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? tc('actions.saving') : te('saveSkill')}
            </Button>
          </div>
        </div>
      </div>

      {/* Editor Tabs */}
      <div className="flex-1 flex flex-col overflow-auto">
        <div className="border-b px-6 shrink-0">
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('form')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'form'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {te('formEditor')}
            </button>
            <button
              onClick={() => setActiveTab('raw')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'raw'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {te('rawMarkdown')}
            </button>
          </div>
        </div>

        {activeTab === 'form' && (
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="space-y-6">
              <div>
                <Label htmlFor="name">{te('nameLabel')}</Label>
                <Input
                  id="name"
                  placeholder={te('namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1.5"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {te('nameHelp')}
                </p>
              </div>

              <div>
                <Label htmlFor="description">{te('descLabel')}</Label>
                <Input
                  id="description"
                  placeholder={t('descriptionPlaceholder')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1.5"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {te('descHelp')}
                </p>
              </div>

              <div>
                <Label htmlFor="markdown">{te('contentLabel')}</Label>
                <Textarea
                  id="markdown"
                  placeholder={te('contentPlaceholder')}
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  className="mt-1.5 font-mono text-sm min-h-[400px]"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {te('contentHelp')}
                </p>
              </div>

              <div className="bg-muted/50 rounded-lg p-4">
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  {te('tipsTitle')}
                </h3>
                <ul className="text-sm text-muted-foreground space-y-1 ml-5 list-disc">
                  <li>{t('tipSpecific')}</li>
                  <li>{t('tipMarkdown')}</li>
                  <li>{t('tipExamples')}</li>
                  <li>{t('tipPractical')}</li>
                  <li>{t('tipConcise')}</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'raw' && (
          <div className="flex-1 overflow-auto px-6 py-4">
            <div className="max-w-4xl">
              <div>
                <Label htmlFor="raw-content">{t('rawContent')}</Label>
                <Textarea
                  id="raw-content"
                  value={rawContent}
                  onChange={(e) => handleRawChange(e.target.value)}
                  className="mt-1.5 font-mono text-sm min-h-[600px]"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {te('rawHelp')}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
