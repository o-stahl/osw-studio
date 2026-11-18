import { SemanticBlock } from './types';

/** A placeholder's size, by the kind of block it stands for. */
const SIZING: Record<SemanticBlock['category'], string> = {
  Sections: 'display:flex;min-height:80px;',
  Content: 'display:flex;min-height:48px;',
  Interactive: 'display:inline-flex;min-height:32px;padding:8px 16px;',
  Data: 'display:flex;min-height:64px;',
};
const BOX = 'align-items:center;justify-content:center;border:2px dashed rgba(99,102,241,0.6);background:rgba(99,102,241,0.08);border-radius:6px;margin:4px 0;box-sizing:border-box;';
const LABEL = 'color:rgba(99,102,241,0.8);font-size:13px;font-family:system-ui,sans-serif;font-weight:500;';

/**
 * The look of the placeholders written into a page, as a stylesheet the preview frames add:
 * `[attr]` for the box, `[attr^="<block id>-"]` for each block's size. One attribute selector,
 * so the element's own overrides (two) win and styling a placeholder shows.
 */
export function placeholderCss(attr: string): string {
  const byCategory = new Map<SemanticBlock['category'], string[]>();
  for (const block of SEMANTIC_BLOCKS) {
    const list = byCategory.get(block.category) ?? [];
    list.push(`[${attr}^="${block.id}-"]`);
    byCategory.set(block.category, list);
  }
  const sized = [...byCategory].map(([category, selectors]) => `${selectors.join(',')}{${SIZING[category]}}`);
  return `[${attr}]{display:flex;min-height:64px;${BOX}${LABEL}}${sized.join('')}`;
}

/** The placeholder the preview frame shows for a block placed on a page with no source positions. */
function wireframe(name: string, category: SemanticBlock['category']): string {
  const width = category === 'Interactive' ? '' : 'width:100%;';
  return `<div data-semantic-placeholder="true" style="${width}${SIZING[category]}${BOX}"><span style="${LABEL}">${name}</span></div>`;
}

export const SEMANTIC_BLOCKS: SemanticBlock[] = [
  // Sections
  {
    id: 'hero',
    name: 'Hero Section',
    category: 'Sections',
    description: 'A hero section with a prominent headline, subheadline, call-to-action button, and optional background image. Typically full-width at the top of the page.',
    wireframeHtml: wireframe('Hero Section', 'Sections'),
  },
  {
    id: 'header-nav',
    name: 'Header / Nav',
    category: 'Sections',
    description: 'A site header with navigation links, logo/brand name, and optional actions (search, login button). Usually sticky or fixed at the top.',
    wireframeHtml: wireframe('Header / Nav', 'Sections'),
  },
  {
    id: 'footer',
    name: 'Footer',
    category: 'Sections',
    description: 'A page footer with copyright, links (privacy, terms, about), social media icons, and optional newsletter signup. Full-width at the bottom.',
    wireframeHtml: wireframe('Footer', 'Sections'),
  },
  {
    id: 'features-grid',
    name: 'Features Grid',
    category: 'Sections',
    description: 'A grid of feature cards, each with an icon, title, and short description. Typically 3 or 4 columns on desktop, stacking on mobile.',
    wireframeHtml: wireframe('Features Grid', 'Sections'),
  },
  {
    id: 'testimonials',
    name: 'Testimonials',
    category: 'Sections',
    description: 'A testimonials section displaying customer quotes with attribution. Includes name, role/company, quote text, and optionally a photo. Common layouts: carousel, grid of cards, or stacked quotes.',
    wireframeHtml: wireframe('Testimonials', 'Sections'),
  },
  {
    id: 'pricing',
    name: 'Pricing',
    category: 'Sections',
    description: 'A pricing comparison section with 2-4 plan tiers shown as cards. Each card has a plan name, price, feature list, and CTA button. One tier is usually highlighted as recommended.',
    wireframeHtml: wireframe('Pricing', 'Sections'),
  },
  {
    id: 'faq',
    name: 'FAQ',
    category: 'Sections',
    description: 'A frequently asked questions section with expandable/collapsible question-answer pairs. Typically uses an accordion pattern.',
    wireframeHtml: wireframe('FAQ', 'Sections'),
  },
  {
    id: 'cta-banner',
    name: 'CTA Banner',
    category: 'Sections',
    description: 'A call-to-action banner with a headline, short supporting text, and one or two action buttons. Often has a contrasting background color.',
    wireframeHtml: wireframe('CTA Banner', 'Sections'),
  },
  // Content
  {
    id: 'text-block',
    name: 'Text Block',
    category: 'Content',
    description: 'A content block with a heading and one or more paragraphs of body text. May include inline links and basic formatting.',
    wireframeHtml: wireframe('Text Block', 'Content'),
  },
  {
    id: 'image',
    name: 'Image',
    category: 'Content',
    description: 'An image element with optional caption and alt text. Can be inline, full-width, or sized to fit its container.',
    wireframeHtml: wireframe('Image', 'Content'),
  },
  {
    id: 'video',
    name: 'Video',
    category: 'Content',
    description: 'An embedded video player, either a hosted video file or an embed from YouTube/Vimeo. Includes playback controls and optional poster image.',
    wireframeHtml: wireframe('Video', 'Content'),
  },
  {
    id: 'card',
    name: 'Card',
    category: 'Content',
    description: 'A card component with an optional image, title, description, and action link/button. Contained in a bordered/shadowed box.',
    wireframeHtml: wireframe('Card', 'Content'),
  },
  {
    id: 'list',
    name: 'List',
    category: 'Content',
    description: 'An ordered or unordered list of items. Each item may have an icon, title, and description. Can be styled as a simple bullet list or a more complex item list.',
    wireframeHtml: wireframe('List', 'Content'),
  },
  // Interactive
  {
    id: 'button',
    name: 'Button',
    category: 'Interactive',
    description: 'A clickable button element. Matches the site\'s existing button styling.',
    wireframeHtml: wireframe('Button', 'Interactive'),
  },
  {
    id: 'form',
    name: 'Form',
    category: 'Interactive',
    description: 'A general-purpose form with labeled input fields, validation, and a submit button. Field types determined by context.',
    wireframeHtml: wireframe('Form', 'Interactive'),
  },
  {
    id: 'contact-form',
    name: 'Contact Form',
    category: 'Interactive',
    description: 'A contact form with name, email, subject, and message fields plus a submit button. May include validation and a success message.',
    wireframeHtml: wireframe('Contact Form', 'Interactive'),
  },
  {
    id: 'search-bar',
    name: 'Search Bar',
    category: 'Interactive',
    description: 'A search input with a search icon/button. May include autocomplete suggestions or a dropdown of results.',
    wireframeHtml: wireframe('Search Bar', 'Interactive'),
  },
  {
    id: 'modal',
    name: 'Modal',
    category: 'Interactive',
    description: 'A modal/dialog overlay triggered by a button or action. Contains content, a close button, and optional action buttons in a footer.',
    wireframeHtml: wireframe('Modal', 'Interactive'),
  },
  // Data
  {
    id: 'table',
    name: 'Table',
    category: 'Data',
    description: 'A data table with headers, rows, and columns. May include sorting, pagination, or filtering. Responsive on smaller screens.',
    wireframeHtml: wireframe('Table', 'Data'),
  },
  {
    id: 'chart',
    name: 'Chart',
    category: 'Data',
    description: 'A data visualization chart (bar, line, pie, etc.). Includes labels, a legend, and sample data. Type determined by context.',
    wireframeHtml: wireframe('Chart', 'Data'),
  },
  {
    id: 'stats-counter',
    name: 'Stats Counter',
    category: 'Data',
    description: 'A row of statistic counters showing key metrics (e.g., "10K+ Users", "99.9% Uptime"). Each stat has a large number and a label below it.',
    wireframeHtml: wireframe('Stats Counter', 'Data'),
  },
  {
    id: 'progress-bar',
    name: 'Progress Bar',
    category: 'Data',
    description: 'A horizontal progress indicator showing completion percentage. Includes a label, percentage text, and a filled bar segment. Can be single or stacked for multiple metrics.',
    wireframeHtml: wireframe('Progress Bar', 'Data'),
  },
  {
    id: 'metric-cards',
    name: 'Metric Cards',
    category: 'Data',
    description: 'A row of dashboard-style KPI cards. Each card shows a metric label, a large value, and an optional trend indicator (up/down arrow with percentage change). Commonly used in admin panels and dashboards.',
    wireframeHtml: wireframe('Metric Cards', 'Data'),
  },
  {
    id: 'data-list',
    name: 'Data List',
    category: 'Data',
    description: 'A vertical list of key-value pairs displayed in rows. Each row has a label on the left and a value on the right, separated by a divider. Used for settings pages, profile details, or specification sheets.',
    wireframeHtml: wireframe('Data List', 'Data'),
  },
  // Sections (additional)
  {
    id: 'sidebar-nav',
    name: 'Sidebar Nav',
    category: 'Sections',
    description: 'A vertical sidebar navigation panel with grouped links, icons, and optional section headers. Can be collapsible. Typically fixed on the left side of an application layout.',
    wireframeHtml: wireframe('Sidebar Nav', 'Sections'),
  },
  {
    id: 'breadcrumbs',
    name: 'Breadcrumbs',
    category: 'Sections',
    description: 'A horizontal breadcrumb navigation trail showing the current page location within a hierarchy (e.g., Home > Products > Category > Item). Each level is a clickable link except the current page.',
    wireframeHtml: wireframe('Breadcrumbs', 'Sections'),
  },
  {
    id: 'tabs',
    name: 'Tabs',
    category: 'Sections',
    description: 'A tabbed interface with a row of tab buttons and a content area below. Clicking a tab shows its associated content panel. One tab is active at a time. Includes tab labels and optional icons.',
    wireframeHtml: wireframe('Tabs', 'Sections'),
  },
  {
    id: 'pagination',
    name: 'Pagination',
    category: 'Sections',
    description: 'A page navigation control with numbered page buttons, previous/next arrows, and an indicator of the current page. Used below lists, tables, or grids of content to navigate between pages of results.',
    wireframeHtml: wireframe('Pagination', 'Sections'),
  },
  // Content (additional)
  {
    id: 'accordion',
    name: 'Accordion',
    category: 'Content',
    description: 'A series of collapsible content panels. Each panel has a clickable header that expands or collapses its body content. Unlike FAQ, this is a general-purpose container for any grouped content that benefits from progressive disclosure.',
    wireframeHtml: wireframe('Accordion', 'Content'),
  },
  {
    id: 'gallery',
    name: 'Gallery',
    category: 'Content',
    description: 'A grid or carousel of images with optional captions. Supports a lightbox view for full-size viewing. Can display as a uniform grid, masonry layout, or horizontal scrolling carousel with navigation arrows.',
    wireframeHtml: wireframe('Gallery', 'Content'),
  },
  {
    id: 'timeline',
    name: 'Timeline',
    category: 'Content',
    description: 'A vertical timeline showing a sequence of events in chronological order. Each entry has a date/time marker, a title, and a description. Connected by a vertical line with dots or icons at each event.',
    wireframeHtml: wireframe('Timeline', 'Content'),
  },
  {
    id: 'profile-card',
    name: 'Profile Card',
    category: 'Content',
    description: 'A card displaying a person or team member. Includes an avatar/photo, name, role or title, a short bio, and optional social media links or a contact button.',
    wireframeHtml: wireframe('Profile Card', 'Content'),
  },
  // Interactive (additional)
  {
    id: 'login-form',
    name: 'Login Form',
    category: 'Interactive',
    description: 'A login form with email/username and password fields, a submit button, a "forgot password" link, and optional social login buttons (Google, GitHub, etc.). May include a "remember me" checkbox and a link to a registration page.',
    wireframeHtml: wireframe('Login Form', 'Interactive'),
  },
  {
    id: 'file-upload',
    name: 'File Upload',
    category: 'Interactive',
    description: 'A file upload area with a drag-and-drop zone and a browse button. Shows selected file names, sizes, and upload progress. Supports single or multiple files with optional file type restrictions.',
    wireframeHtml: wireframe('File Upload', 'Interactive'),
  },
  {
    id: 'notification',
    name: 'Notification',
    category: 'Interactive',
    description: 'A toast or banner notification component for displaying messages to the user. Includes an icon, message text, and a dismiss button. Supports variants: success, error, warning, info. Can auto-dismiss after a timeout.',
    wireframeHtml: wireframe('Notification', 'Interactive'),
  },
  {
    id: 'dropdown-menu',
    name: 'Dropdown Menu',
    category: 'Interactive',
    description: 'A button that opens a floating menu of actions or options. Menu items can have icons, dividers between groups, and optional keyboard shortcuts. Closes on selection or clicking outside.',
    wireframeHtml: wireframe('Dropdown Menu', 'Interactive'),
  },
];

export function getBlockById(id: string): SemanticBlock | undefined {
  return SEMANTIC_BLOCKS.find(b => b.id === id);
}

export const BLOCK_CATEGORIES: SemanticBlock['category'][] = ['Sections', 'Content', 'Interactive', 'Data'];
