export interface Dictionary {
  common: {
    loading: string;
    noRecentProjects: string;
    noDeployment: string;
  };
  workspace: {
    tabs: {
      chat: string;
      fileExplorer: string;
      codeEditor: string;
      preview: string;
      inspector: string;
      skills: string;
      console: string;
      checkpoints: string;
      debugEvents: string;
    };
    deploy: string;
    deployTooltip: string;
    settings: string;
    checkpointsShort: string;
    consoleShort: string;
    skillsShort: string;
    debugShort: string;
  };
  skills: {
    title: string;
    createNew: string;
    addSkill: string;
    enableSkills: string;
    domainSpecificInstructions: string;
  };
}
