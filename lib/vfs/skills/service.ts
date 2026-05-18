/**
 * Skills Service - Manages skill CRUD operations
 * Skills are stored in localStorage (custom) and loaded from built-in registry
 */

import { Skill, SkillMetadata, SkillGroup } from './types';
import { parseSkillFile } from './parser';
import { BUILT_IN_SKILLS, BUILT_IN_GROUPS } from './registry';
import { logger } from '@/lib/utils';
import JSZip from 'jszip';

const CUSTOM_SKILLS_KEY = 'osw_custom_skills';
const ENABLED_STATE_KEY = 'osw_skills_enabled_state';
const GROUPS_STATE_KEY = 'osw_skill_groups_state';

interface EnabledState {
  globalEnabled: boolean;
  skillEvaluationEnabled: boolean;
  disabledSkills: Set<string>; // IDs of disabled skills
}

interface GroupsState {
  disabledGroups: Set<string>;       // IDs of disabled groups
  customGroups: Map<string, SkillGroup>;
}

/**
 * Skills Service - Global singleton
 */
class SkillsService {
  private customSkills: Map<string, Skill> = new Map();
  private initialized = false;
  private enabledState: EnabledState = {
    globalEnabled: true,
    skillEvaluationEnabled: false,
    disabledSkills: new Set(),
  };
  private groupsState: GroupsState = {
    disabledGroups: new Set(),
    customGroups: new Map(),
  };

  /**
   * Initialize the service - load custom skills and enabled state from localStorage
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      if (typeof localStorage !== 'undefined') {
        // Load custom skills
        const stored = localStorage.getItem(CUSTOM_SKILLS_KEY);
        if (stored) {
          const skills: Skill[] = JSON.parse(stored);
          skills.forEach(skill => {
            // Restore Date objects
            skill.createdAt = new Date(skill.createdAt);
            skill.updatedAt = new Date(skill.updatedAt);
            this.customSkills.set(skill.id, skill);
          });
        }

        // Load enabled state
        const enabledStateStored = localStorage.getItem(ENABLED_STATE_KEY);
        if (enabledStateStored) {
          const state = JSON.parse(enabledStateStored);
          this.enabledState = {
            globalEnabled: state.globalEnabled ?? true,
            skillEvaluationEnabled: state.skillEvaluationEnabled ?? false,
            disabledSkills: new Set(state.disabledSkills || []),
          };
        }

        // Load groups state
        const groupsStored = localStorage.getItem(GROUPS_STATE_KEY);
        if (groupsStored) {
          const parsed = JSON.parse(groupsStored);
          const customGroups = new Map<string, SkillGroup>();
          for (const g of parsed.customGroups || []) {
            customGroups.set(g.id, {
              ...g,
              createdAt: new Date(g.createdAt),
              updatedAt: new Date(g.updatedAt),
            });
          }
          this.groupsState = {
            disabledGroups: new Set(parsed.disabledGroups || []),
            customGroups,
          };
        }
      }

      this.initialized = true;
      logger.info(`[SkillsService] Loaded ${this.customSkills.size} custom skills, ${this.groupsState.customGroups.size} custom groups`);
    } catch (error) {
      logger.error('[SkillsService] Failed to load custom skills', error);
    }
  }

  /**
   * Persist custom skills to localStorage
   */
  private saveCustomSkills(): void {
    try {
      const skills = Array.from(this.customSkills.values());
      localStorage.setItem(CUSTOM_SKILLS_KEY, JSON.stringify(skills));
    } catch (error) {
      logger.error('[SkillsService] Failed to save custom skills', error);
      throw new Error('Failed to save skills');
    }
  }

  /**
   * Persist enabled state to localStorage
   */
  private saveEnabledState(): void {
    try {
      const state = {
        globalEnabled: this.enabledState.globalEnabled,
        skillEvaluationEnabled: this.enabledState.skillEvaluationEnabled,
        disabledSkills: Array.from(this.enabledState.disabledSkills),
      };
      localStorage.setItem(ENABLED_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      logger.error('[SkillsService] Failed to save enabled state', error);
    }
  }

  /**
   * Persist groups state to localStorage
   */
  private saveGroupsState(): void {
    try {
      const state = {
        disabledGroups: Array.from(this.groupsState.disabledGroups),
        customGroups: Array.from(this.groupsState.customGroups.values()),
      };
      localStorage.setItem(GROUPS_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      logger.error('[SkillsService] Failed to save groups state', error);
    }
  }

  /**
   * Get all skills (built-in + custom)
   */
  async getAllSkills(): Promise<Skill[]> {
    await this.init();

    const skills: Skill[] = [];

    // Add built-in skills
    for (const builtIn of BUILT_IN_SKILLS) {
      try {
        const { frontmatter, markdown } = parseSkillFile(builtIn.content);
        skills.push({
          id: builtIn.id,
          name: frontmatter.name,
          description: frontmatter.description,
          content: builtIn.content,
          markdown,
          isBuiltIn: true,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        });
      } catch (error) {
        logger.error(`[SkillsService] Failed to parse built-in skill: ${builtIn.id}`, error);
      }
    }

    // Add custom skills
    skills.push(...Array.from(this.customSkills.values()));

    return skills;
  }

  /**
   * Get skill metadata for system prompt (lightweight)
   */
  async getSkillsMetadata(): Promise<SkillMetadata[]> {
    const skills = await this.getAllSkills();
    return skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: `/.skills/${skill.id}.md`,
      isBuiltIn: skill.isBuiltIn,
    }));
  }

  /**
   * Get a single skill by ID
   */
  async getSkill(id: string): Promise<Skill | null> {
    await this.init();

    // Check custom skills first
    const customSkill = this.customSkills.get(id);
    if (customSkill) return customSkill;

    // Check built-in skills
    const builtInSkill = BUILT_IN_SKILLS.find(s => s.id === id);
    if (builtInSkill) {
      try {
        const { frontmatter, markdown } = parseSkillFile(builtInSkill.content);
        return {
          id: builtInSkill.id,
          name: frontmatter.name,
          description: frontmatter.description,
          content: builtInSkill.content,
          markdown,
          isBuiltIn: true,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        };
      } catch (error) {
        logger.error(`[SkillsService] Failed to parse built-in skill: ${id}`, error);
      }
    }

    return null;
  }

  /**
   * Create a new custom skill from SKILL.md content
   */
  async createSkill(content: string): Promise<Skill> {
    await this.init();

    try {
      const { frontmatter, markdown } = parseSkillFile(content);
      const id = frontmatter.name; // Use name as ID

      // Check if skill already exists
      if (this.customSkills.has(id) || BUILT_IN_SKILLS.some(s => s.id === id)) {
        throw new Error(`Skill with name "${id}" already exists`);
      }

      const skill: Skill = {
        id,
        name: frontmatter.name,
        description: frontmatter.description,
        content,
        markdown,
        isBuiltIn: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      this.customSkills.set(id, skill);
      this.saveCustomSkills();

      // Background sync to server
      import('../auto-sync').then(({ autoSyncSkill }) => autoSyncSkill(skill)).catch(() => {});

      logger.info(`[SkillsService] Created skill: ${id}`);
      return skill;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to create skill');
    }
  }

  /**
   * Update an existing custom skill
   */
  async updateSkill(id: string, content: string): Promise<Skill> {
    await this.init();

    const existingSkill = this.customSkills.get(id);
    if (!existingSkill) {
      throw new Error(`Skill "${id}" not found`);
    }

    if (existingSkill.isBuiltIn) {
      throw new Error('Cannot update built-in skills');
    }

    try {
      const { frontmatter, markdown } = parseSkillFile(content);

      // If name changed, this is a new skill
      if (frontmatter.name !== id) {
        throw new Error('Skill name cannot be changed. Create a new skill instead.');
      }

      const updatedSkill: Skill = {
        ...existingSkill,
        name: frontmatter.name,
        description: frontmatter.description,
        content,
        markdown,
        updatedAt: new Date(),
      };

      this.customSkills.set(id, updatedSkill);
      this.saveCustomSkills();

      // Background sync to server
      import('../auto-sync').then(({ autoSyncSkill }) => autoSyncSkill(updatedSkill)).catch(() => {});

      logger.info(`[SkillsService] Updated skill: ${id}`);
      return updatedSkill;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to update skill');
    }
  }

  /**
   * Delete a custom skill
   */
  async deleteSkill(id: string): Promise<void> {
    await this.init();

    const skill = this.customSkills.get(id);
    if (!skill) {
      throw new Error(`Skill "${id}" not found`);
    }

    if (skill.isBuiltIn) {
      throw new Error('Cannot delete built-in skills');
    }

    this.customSkills.delete(id);
    this.saveCustomSkills();

    // Remove from any custom groups that contain it
    let groupsChanged = false;
    for (const group of this.groupsState.customGroups.values()) {
      const idx = group.memberIds.indexOf(id);
      if (idx !== -1) {
        group.memberIds.splice(idx, 1);
        group.updatedAt = new Date();
        groupsChanged = true;
      }
    }
    if (groupsChanged) this.saveGroupsState();

    // Background sync to server
    import('../auto-sync').then(({ autoDeleteSkill }) => autoDeleteSkill(id)).catch(() => {});

    logger.info(`[SkillsService] Deleted skill: ${id}`);
  }

  /**
   * Import skills from a ZIP file
   */
  async importSkills(zipBlob: Blob): Promise<Skill[]> {
    await this.init();

    const importedSkills: Skill[] = [];

    try {
      const zip = await JSZip.loadAsync(zipBlob);

      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir) continue;
        if (!filename.endsWith('.md')) continue;

        const content = await file.async('string');

        try {
          const skill = await this.createSkill(content);
          importedSkills.push(skill);
        } catch (error) {
          logger.warn(`[SkillsService] Failed to import ${filename}:`, error);
          // Continue importing other skills
        }
      }

      logger.info(`[SkillsService] Imported ${importedSkills.length} skills`);
      return importedSkills;
    } catch (error) {
      logger.error('[SkillsService] Failed to import skills', error);
      throw new Error('Failed to import skills');
    }
  }

  /**
   * Import a single skill from .md file
   */
  async importSkillFile(file: File): Promise<Skill> {
    const content = await file.text();
    return this.createSkill(content);
  }

  /**
   * Export skills as a ZIP file
   */
  async exportSkills(skillIds: string[]): Promise<Blob> {
    await this.init();

    const zip = new JSZip();

    for (const id of skillIds) {
      const skill = await this.getSkill(id);
      if (!skill) {
        logger.warn(`[SkillsService] Skill not found for export: ${id}`);
        continue;
      }

      zip.file(`${skill.id}.md`, skill.content);
    }

    logger.info(`[SkillsService] Exported ${skillIds.length} skills`);
    return await zip.generateAsync({ type: 'blob' });
  }

  /**
   * Clear all custom skills (for testing/reset)
   */
  async clearCustomSkills(): Promise<void> {
    this.customSkills.clear();
    localStorage.removeItem(CUSTOM_SKILLS_KEY);
    logger.info('[SkillsService] Cleared all custom skills');
  }

  // ============================================
  // Enable/Disable Management
  // ============================================

  /**
   * Check if skills system is globally enabled
   */
  async isGloballyEnabled(): Promise<boolean> {
    await this.init();
    return this.enabledState.globalEnabled;
  }

  /**
   * Set global enabled state for skills system
   */
  async setGlobalEnabled(enabled: boolean): Promise<void> {
    await this.init();
    this.enabledState.globalEnabled = enabled;
    this.saveEnabledState();
    logger.info(`[SkillsService] Global enabled set to: ${enabled}`);
  }

  /**
   * Check if skill evaluation pre-flight is enabled
   */
  async isEvaluationEnabled(): Promise<boolean> {
    await this.init();
    return this.enabledState.globalEnabled && this.enabledState.skillEvaluationEnabled;
  }

  /**
   * Set skill evaluation pre-flight enabled state
   */
  async setEvaluationEnabled(enabled: boolean): Promise<void> {
    await this.init();
    this.enabledState.skillEvaluationEnabled = enabled;
    this.saveEnabledState();
    logger.info(`[SkillsService] Skill evaluation set to: ${enabled}`);
  }

  /**
   * Check if a specific skill is individually enabled (ignoring groups)
   */
  async isSkillEnabled(skillId: string): Promise<boolean> {
    await this.init();
    if (!this.enabledState.globalEnabled) return false;
    return !this.enabledState.disabledSkills.has(skillId);
  }

  /**
   * Enable a specific skill
   */
  async enableSkill(skillId: string): Promise<void> {
    await this.init();
    this.enabledState.disabledSkills.delete(skillId);
    this.saveEnabledState();
    logger.info(`[SkillsService] Enabled skill: ${skillId}`);
  }

  /**
   * Disable a specific skill
   */
  async disableSkill(skillId: string): Promise<void> {
    await this.init();
    this.enabledState.disabledSkills.add(skillId);
    this.saveEnabledState();
    logger.info(`[SkillsService] Disabled skill: ${skillId}`);
  }

  /**
   * Get only enabled skills (respects global, per-skill, and group settings).
   * A skill is active if:
   *   - global skills system is enabled, AND
   *   - either the skill is individually enabled, OR it belongs to at least one enabled group.
   * Group membership ENABLES — an enabled group activates its members regardless of
   * their individual toggle state. Individual toggle only matters when no enabled group
   * is covering the skill.
   */
  async getEnabledSkills(): Promise<Skill[]> {
    await this.init();

    if (!this.enabledState.globalEnabled) {
      return [];
    }

    const allSkills = await this.getAllSkills();
    const allGroups = await this.getAllGroups();

    // Build skill -> groups map for fast lookup
    const skillToGroups = new Map<string, string[]>();
    for (const group of allGroups) {
      for (const memberId of group.memberIds) {
        const arr = skillToGroups.get(memberId) ?? [];
        arr.push(group.id);
        skillToGroups.set(memberId, arr);
      }
    }

    return allSkills.filter(skill => {
      const inEnabledGroup = (skillToGroups.get(skill.id) ?? [])
        .some(gid => !this.groupsState.disabledGroups.has(gid));
      const individuallyEnabled = !this.enabledState.disabledSkills.has(skill.id);
      return inEnabledGroup || individuallyEnabled;
    });
  }

  /**
   * Get enabled skills metadata for system prompt (lightweight)
   */
  async getEnabledSkillsMetadata(): Promise<SkillMetadata[]> {
    const enabledSkills = await this.getEnabledSkills();
    return enabledSkills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: `/.skills/${skill.id}.md`,
      isBuiltIn: skill.isBuiltIn,
    }));
  }

  // ============================================
  // Group Management
  // ============================================

  /**
   * Get all skill groups (built-in + custom)
   */
  async getAllGroups(): Promise<SkillGroup[]> {
    await this.init();

    const groups: SkillGroup[] = [];

    for (const builtIn of BUILT_IN_GROUPS) {
      groups.push({
        id: builtIn.id,
        name: builtIn.name,
        description: builtIn.description,
        memberIds: [...builtIn.memberIds],
        isBuiltIn: true,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      });
    }

    groups.push(...Array.from(this.groupsState.customGroups.values()));

    return groups;
  }

  /**
   * Get a single group by ID
   */
  async getGroup(id: string): Promise<SkillGroup | null> {
    const all = await this.getAllGroups();
    return all.find(g => g.id === id) ?? null;
  }

  /**
   * Check if a group is enabled
   */
  async isGroupEnabled(groupId: string): Promise<boolean> {
    await this.init();
    return !this.groupsState.disabledGroups.has(groupId);
  }

  /**
   * Enable a group (allows its members to be active)
   */
  async enableGroup(groupId: string): Promise<void> {
    await this.init();
    this.groupsState.disabledGroups.delete(groupId);
    this.saveGroupsState();
    logger.info(`[SkillsService] Enabled group: ${groupId}`);
  }

  /**
   * Disable a group (its members are inactive unless they belong to another enabled group)
   */
  async disableGroup(groupId: string): Promise<void> {
    await this.init();
    this.groupsState.disabledGroups.add(groupId);
    this.saveGroupsState();
    logger.info(`[SkillsService] Disabled group: ${groupId}`);
  }

  /**
   * Create a custom group
   */
  async createGroup(input: { name: string; description?: string; memberIds?: string[] }): Promise<SkillGroup> {
    await this.init();

    const id = this.slugify(input.name);
    if (!id) {
      throw new Error('Group name must contain at least one alphanumeric character');
    }

    if (this.groupsState.customGroups.has(id) || BUILT_IN_GROUPS.some(g => g.id === id)) {
      throw new Error(`Group with name "${input.name}" already exists`);
    }

    const group: SkillGroup = {
      id,
      name: input.name,
      description: input.description,
      memberIds: input.memberIds ? [...new Set(input.memberIds)] : [],
      isBuiltIn: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.groupsState.customGroups.set(id, group);
    this.saveGroupsState();

    logger.info(`[SkillsService] Created group: ${id}`);
    return group;
  }

  /**
   * Update a custom group's metadata or membership
   */
  async updateGroup(id: string, updates: { name?: string; description?: string; memberIds?: string[] }): Promise<SkillGroup> {
    await this.init();

    const existing = this.groupsState.customGroups.get(id);
    if (!existing) {
      throw new Error(`Group "${id}" not found`);
    }

    const updated: SkillGroup = {
      ...existing,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      memberIds: updates.memberIds ? [...new Set(updates.memberIds)] : existing.memberIds,
      updatedAt: new Date(),
    };

    this.groupsState.customGroups.set(id, updated);
    this.saveGroupsState();

    logger.info(`[SkillsService] Updated group: ${id}`);
    return updated;
  }

  /**
   * Delete a custom group (does not delete its members)
   */
  async deleteGroup(id: string): Promise<void> {
    await this.init();

    const group = this.groupsState.customGroups.get(id);
    if (!group) {
      throw new Error(`Group "${id}" not found`);
    }

    this.groupsState.customGroups.delete(id);
    this.groupsState.disabledGroups.delete(id);
    this.saveGroupsState();

    logger.info(`[SkillsService] Deleted group: ${id}`);
  }

  /**
   * Add a skill to a custom group
   */
  async addSkillToGroup(groupId: string, skillId: string): Promise<void> {
    const group = this.groupsState.customGroups.get(groupId);
    if (!group) throw new Error(`Group "${groupId}" not found or is built-in`);
    if (!group.memberIds.includes(skillId)) {
      group.memberIds.push(skillId);
      group.updatedAt = new Date();
      this.saveGroupsState();
    }
  }

  /**
   * Remove a skill from a custom group
   */
  async removeSkillFromGroup(groupId: string, skillId: string): Promise<void> {
    const group = this.groupsState.customGroups.get(groupId);
    if (!group) throw new Error(`Group "${groupId}" not found or is built-in`);
    const idx = group.memberIds.indexOf(skillId);
    if (idx !== -1) {
      group.memberIds.splice(idx, 1);
      group.updatedAt = new Date();
      this.saveGroupsState();
    }
  }

  /**
   * Convert a name into a slug usable as a group ID
   */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ============================================
  // Sync Support (Server Mode)
  // ============================================

  /**
   * Get all custom skills (for sync)
   */
  async getCustomSkills(): Promise<Skill[]> {
    await this.init();
    return Array.from(this.customSkills.values());
  }

  /**
   * Update a skill's sync metadata after successful sync
   */
  async updateSyncMetadata(skillId: string, lastSyncedAt: Date, serverUpdatedAt: Date): Promise<void> {
    await this.init();

    const skill = this.customSkills.get(skillId);
    if (!skill || skill.isBuiltIn) return;

    const updatedSkill: Skill = {
      ...skill,
      lastSyncedAt,
      serverUpdatedAt,
    };

    this.customSkills.set(skillId, updatedSkill);
    this.saveCustomSkills();

    logger.info(`[SkillsService] Updated sync metadata for skill: ${skillId}`);
  }

  /**
   * Import a skill from server (pull)
   * Creates or updates local skill with server data
   */
  async importFromServer(serverSkill: Skill): Promise<void> {
    await this.init();

    // Restore Date objects
    const skill: Skill = {
      ...serverSkill,
      createdAt: new Date(serverSkill.createdAt),
      updatedAt: new Date(serverSkill.updatedAt),
      lastSyncedAt: new Date(),
      serverUpdatedAt: new Date(serverSkill.updatedAt),
      isBuiltIn: false,
    };

    this.customSkills.set(skill.id, skill);
    this.saveCustomSkills();

    logger.info(`[SkillsService] Imported skill from server: ${skill.id}`);
  }

  /**
   * Check if a skill exists locally
   */
  async hasSkill(id: string): Promise<boolean> {
    await this.init();
    return this.customSkills.has(id) || BUILT_IN_SKILLS.some(s => s.id === id);
  }
}

// Export singleton instance
export const skillsService = new SkillsService();
