import type { Dictionary } from '../dictionary-type';

export const ko: Dictionary = {
  common: {
    loading: '불러오는 중…',
    noRecentProjects: '최근 프로젝트가 없어요',
    noDeployment: '배포 없음',
  },
  workspace: {
    tabs: {
      chat: '채팅',
      fileExplorer: '파일 탐색기',
      codeEditor: '코드 편집기',
      preview: '미리보기',
      inspector: '인스펙터',
      skills: '스킬',
      console: '콘솔',
      checkpoints: '체크포인트',
      debugEvents: '디버그 이벤트',
    },
    deploy: '배포',
    deployTooltip: '이 프로젝트 배포하기',
    settings: '설정',
    checkpointsShort: '체크포인트',
    consoleShort: '콘솔',
    skillsShort: '스킬',
    debugShort: '디버그',
  },
  skills: {
    title: '스킬',
    createNew: '새 스킬 만들기',
    addSkill: '스킬 추가',
    enableSkills: '스킬 사용',
    domainSpecificInstructions: '분야별 맞춤 AI 지침',
  },
};
