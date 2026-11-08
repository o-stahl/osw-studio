'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Skill, SkillGroup } from '@/lib/vfs/skills/types';
import { skillsService } from '@/lib/vfs/skills';
import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useTranslations } from 'next-intl';
import { useSkillGroupCopy } from '@/lib/i18n/use-skill-group-catalog';
import { Sparkles, Plus, FolderTree } from 'lucide-react';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { Tip } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { SkillEditor } from '@/components/skills/SkillEditor';

interface SkillsPanelProps {
  onClose?: () => void;
}

export function SkillsPanel({ onClose }: SkillsPanelProps) {
  const t = useTranslations('skills');
  const tc = useTranslations('common');
  const groupCopy = useSkillGroupCopy();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [groups, setGroups] = useState<SkillGroup[]>([]);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [enabledSkills, setEnabledSkills] = useState<Set<string>>(new Set());
  const [enabledGroups, setEnabledGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const loadState = useCallback(async () => {
    try {
      const [allSkills, allGroups, global] = await Promise.all([
        skillsService.getAllSkills(),
        skillsService.getAllGroups(),
        skillsService.isGloballyEnabled(),
      ]);
      setSkills(allSkills);
      setGroups(allGroups);
      setGlobalEnabled(global);

      const enabled = new Set<string>();
      for (const skill of allSkills) {
        if (await skillsService.isSkillEnabled(skill.id)) {
          enabled.add(skill.id);
        }
      }
      setEnabledSkills(enabled);

      const enabledG = new Set<string>();
      for (const g of allGroups) {
        if (await skillsService.isGroupEnabled(g.id)) {
          enabledG.add(g.id);
        }
      }
      setEnabledGroups(enabledG);
    } catch (err) {
      logger.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const handleGlobalToggle = async (enabled: boolean) => {
    setGlobalEnabled(enabled);
    await skillsService.setGlobalEnabled(enabled);
    await vfs.reloadTransientSkills();
  };

  const handleSkillToggle = async (skillId: string, enabled: boolean) => {
    const updated = new Set(enabledSkills);
    if (enabled) {
      updated.add(skillId);
      await skillsService.enableSkill(skillId);
    } else {
      updated.delete(skillId);
      await skillsService.disableSkill(skillId);
    }
    setEnabledSkills(updated);
    await vfs.reloadTransientSkills();
  };

  const handleGroupToggle = async (groupId: string, enabled: boolean) => {
    const updated = new Set(enabledGroups);
    if (enabled) {
      updated.add(groupId);
      await skillsService.enableGroup(groupId);
    } else {
      updated.delete(groupId);
      await skillsService.disableGroup(groupId);
    }
    setEnabledGroups(updated);
    await vfs.reloadTransientSkills();
  };

  const builtInSkills = skills.filter(s => s.isBuiltIn);
  const customSkills = skills.filter(s => !s.isBuiltIn);

  return (
    <PanelContainer>
      <PanelHeader
        icon={Sparkles}
        title={tc('terms.skills')}
        color="var(--button-skills-active, #a855f7)"
        onClose={onClose}
        panelKey="skills"
        actions={[
          { id: 'create', icon: Plus, label: t('createNew'), text: t('addSkill'), onSelect: () => setCreateDialogOpen(true) },
        ]}
      />

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Global toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t('enableSkills')}</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('domainSpecificInstructions')}
            </p>
          </div>
          <Tip label={loading ? undefined : globalEnabled ? t('tips.allOff') : t('tips.allOn')} wrap align="end">
            <Switch
              checked={globalEnabled}
              onCheckedChange={handleGlobalToggle}
              disabled={loading}
              aria-label={t('enableSkills')}
            />
          </Tip>
        </div>

        {globalEnabled && !loading && (
          <>
            {groups.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <FolderTree className="w-3 h-3 text-muted-foreground" />
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('groups')}
                  </div>
                </div>
                <div className="space-y-0.5">
                  {groups.map(group => (
                    <div key={group.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50">
                      <Tip label={groupCopy(group).description || undefined} side="left">
                        <div className="flex-1 min-w-0 mr-3">
                          <div className="text-sm truncate">{groupCopy(group).name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {t('memberCount', { count: group.memberIds.length })}
                          </div>
                        </div>
                      </Tip>
                      <Tip label={enabledGroups.has(group.id) ? t('tips.turnOff', { name: groupCopy(group).name }) : t('tips.turnOn', { name: groupCopy(group).name })} wrap align="end">
                        <Switch
                          checked={enabledGroups.has(group.id)}
                          onCheckedChange={(checked) => handleGroupToggle(group.id, checked)}
                          aria-label={groupCopy(group).name}
                        />
                      </Tip>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {builtInSkills.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {tc('labels.builtIn')}
                </div>
                <div className="space-y-0.5">
                  {builtInSkills.map(skill => (
                    <SkillRow key={skill.id} skill={skill} on={enabledSkills.has(skill.id)} onToggle={(checked) => handleSkillToggle(skill.id, checked)} />
                  ))}
                </div>
              </div>
            )}

            {customSkills.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {t('custom')}
                </div>
                <div className="space-y-0.5">
                  {customSkills.map(skill => (
                    <SkillRow key={skill.id} skill={skill} on={enabledSkills.has(skill.id)} onToggle={(checked) => handleSkillToggle(skill.id, checked)} />
                  ))}
                </div>
              </div>
            )}

            {skills.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                {t('noSkillsAvailable')}
              </p>
            )}
          </>
        )}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <SkillEditor
            skill={null}
            mode="create"
            onSave={async () => {
              setCreateDialogOpen(false);
              await loadState();
              await vfs.reloadTransientSkills();
            }}
            onCancel={() => setCreateDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </PanelContainer>
  );
}

/** A skill and its switch; the name's tooltip is the skill's description, which the row has no room for. */
function SkillRow({ skill, on, onToggle }: { skill: Skill; on: boolean; onToggle: (checked: boolean) => void }) {
  const t = useTranslations('skills');
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50">
      <Tip label={skill.description || undefined} side="left">
        <div className="flex-1 min-w-0 mr-3">
          <div className="text-sm truncate">{skill.name}</div>
        </div>
      </Tip>
      <Tip label={on ? t('tips.turnOff', { name: skill.name }) : t('tips.turnOn', { name: skill.name })} wrap align="end">
        <Switch checked={on} onCheckedChange={onToggle} aria-label={skill.name} />
      </Tip>
    </div>
  );
}
