import {
  BookOpen,
  Zap,
  FolderOpen,
  Sparkles,
  LayoutTemplate,
  Globe,
  Server,
  Code,
  Users,
  HelpCircle,
  Wrench,
  Database,
  Upload,
  ServerCog,
} from 'lucide-react';

export interface DocItem {
  id: string;
  title: string;
  icon: React.ElementType;
  file: string;
}

export const DOCS_ITEMS: DocItem[] = [
  // What's New (shown first for version updates)
  { id: 'whats-new', title: "What's New", icon: Sparkles, file: 'WHATS_NEW.md' },

  // Getting Started
  { id: 'overview', title: 'Overview', icon: BookOpen, file: 'OVERVIEW.md' },
  { id: 'getting-started', title: 'Getting Started', icon: Zap, file: 'GETTING_STARTED.md' },
  { id: 'projects', title: 'Projects', icon: FolderOpen, file: 'PROJECTS.md' },

  // Using OSW Studio
  { id: 'working-with-ai', title: 'Working with AI', icon: Sparkles, file: 'WORKING_WITH_AI.md' },
  { id: 'templates', title: 'Templates', icon: LayoutTemplate, file: 'TEMPLATES.md' },
  { id: 'skills', title: 'Skills', icon: Sparkles, file: 'SKILLS.md' },
  { id: 'deploying-sites', title: 'Deploying', icon: Globe, file: 'DEPLOYING_SITES.md' },
  { id: 'server-mode', title: 'Server Mode', icon: Server, file: 'SERVER_MODE.md' },
  { id: 'vps-deployment', title: 'VPS Deployment', icon: ServerCog, file: 'VPS_DEPLOYMENT.md' },
  { id: 'site-publishing', title: 'Deployment Publishing', icon: Upload, file: 'SITE_PUBLISHING.md' },
  { id: 'custom-domains', title: 'Custom Domains', icon: Globe, file: 'CUSTOM_DOMAINS.md' },
  { id: 'backend-features', title: 'Backend', icon: Database, file: 'BACKEND_FEATURES.md' },
  { id: 'mcp-server', title: 'MCP Server', icon: Code, file: 'MCP_SERVER.md' },
  { id: 'multitenancy', title: 'Multitenancy', icon: Users, file: 'MULTITENANCY.md' },

  // Help & Advanced
  { id: 'faq', title: 'FAQ', icon: HelpCircle, file: 'FAQ.md' },
  { id: 'troubleshooting', title: 'Troubleshooting', icon: Wrench, file: 'TROUBLESHOOTING.md' },
];
