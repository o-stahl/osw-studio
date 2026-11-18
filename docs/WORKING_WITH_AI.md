# Working with AI

**Get the best results from AI when building your websites.**

This guide covers how to interact with AI effectively, understand its capabilities, and make the most of OSW Studio's dual-mode system.

---

## Chat Mode vs Code Mode

OSW Studio has two modes that control what AI can do to your project:

### 💬 Chat Mode (Read-Only)

**Use when you want to explore without making changes.**

In Chat mode, the AI is limited to read-only bash commands. It can read files and analyze your project structure, but cannot write, edit, or delete anything.

AI can:
- Answer questions about your code
- Explain how things work
- Suggest improvements
- Help you plan features
- Review code structure
- Show you how it understands your project

AI cannot:
- Create or modify files
- Delete anything
- Make changes to your project

**Perfect for:**
- Learning about your codebase
- Planning before building
- Getting second opinions
- Understanding unfamiliar code
- Seeing how the AI interprets your project structure

**Pro tip**: If you're unsure how to proceed, start with Chat mode to discuss the project with the AI and see how it would approach the work.

**Example prompts:**
```
How does the navigation menu work?
```
```
What would be the best way to add a blog section?
```
```
Can you explain this JavaScript function?
```

### 🔧 Code Mode (Full Access)

**Use when you want AI to build and modify your project.**

In Code mode, the AI has full access to all bash commands. It can create, edit, delete, and restructure files as needed.

AI can:
- Create new files and folders
- Edit existing code
- Delete files
- Restructure your project
- Implement complete features
- Fix bugs
- One-shot build entire multi-page websites (though smaller, focused tasks are generally more consistent)

**Perfect for:**
- Building new features
- Making design changes
- Fixing bugs
- Refactoring code
- Implementing your plans
- Creating complete websites from scratch

**Example prompts:**
```
Add a contact form to the contact page
```
```
Make the header sticky when scrolling
```
```
Change the color scheme to dark mode
```

### Switching Modes

Toggle between modes using the switch at the top of the chat panel.

**Pro tip**: Plan in Chat Mode, build in Code Mode.

---

## Working with Files

### Creating Files

**Let AI create files for you:**

```
Create a new file called contact.html with a contact form
```

**Or do it manually:**
1. Right-click in File Explorer
2. Select **New File**
3. Enter filename
4. Press Enter

### Editing Files

**With AI:**
```
Update the CSS to make the header sticky
```

**Manually:**
1. Click file in File Explorer
2. Edit in Code Editor
3. Save with `Cmd/Ctrl+S`

### Deleting Files

**With AI:**
```
Delete the unused about.html file
```

**Manually:**
1. Right-click file in File Explorer
2. Select **Delete**
3. Confirm

---

## Writing Good Prompts

### Be Specific

❌ **Vague**: "Make it look better"
✅ **Specific**: "Add a gradient background from #667eea to #764ba2 in the hero section"

❌ **Vague**: "Add a form"
✅ **Specific**: "Add a contact form with fields for name, email, and message, with a blue submit button"

### One Thing at a Time

Break complex requests into steps:

❌ **Too much**:
```
Create a blog with posts, categories, tags, search, pagination,
comments, and social sharing
```

✅ **Step by step**:
```
1. First: Create a blog page with a list of 3 sample posts
2. Then: Add categories to organize the posts
3. Then: Add a search feature
... and so on
```

### Provide Context

Help AI understand your goals:

❌ **No context**: "Add a section"

✅ **With context**:
```
Add a testimonials section below the features section.
Show 3 testimonials in a row with photos, names, and quotes.
Match the existing blue color scheme.
```

### Show Examples

Describe what you want to see:

```
Add a pricing table with 3 tiers: Basic ($9/mo), Pro ($29/mo),
and Enterprise ($99/mo). Each tier should show 5 features
and have a "Get Started" button. Make the Pro tier highlighted.
```

### Ask for Explanations

If you want to learn:

```
Add smooth scrolling to the page, and explain how it works
```

---

## Common Tasks

### Building Features

```
Add a hamburger menu for mobile screens
```

```
Create a photo gallery with lightbox effect
```

```
Add a newsletter signup form that's centered on the page
```

### Styling & Design

```
Change the font to Inter throughout the site
```

```
Make the hero section full-height with centered content
```

```
Add hover effects to all buttons with a slight scale animation
```

### Fixing Issues

```
The mobile menu isn't closing when I click a link. Can you fix that?
```

```
Images are overflowing their containers on mobile. Fix the sizing.
```

```
The contact form isn't visually aligned. Center it properly.
```

### Modifying Content

```
Update the hero heading to say "Welcome to My Portfolio"
```

```
Add 2 more project cards to the projects section
```

```
Change all instances of "Company" to "Studio"
```

---

## Understanding AI Responses

### Tool Execution

When AI works in Code Mode, all file operations run through a single `bash` tool. You'll see commands like:

**Creating files:**
```
🔧 write: cat > index.html << 'EOF' ...
✅ Created index.html
```

**Editing files:**
```
🔧 write: sed -i 's/old/new/' styles.css
✅ Updated styles.css
```
or for larger edits:
```
🔧 write: ss /styles.css << 'EOF'
search===replace
EOF
```

**Reading files:**
```
🔧 bash: cat index.html
📄 Read file contents
```

**Checking compilation:**
```
🔧 status: build
✅ Build successful — 0 errors
```

### Status Updates

AI will tell you what it's doing:

- "I'll create a new navigation menu..."
- "Updating the CSS to make buttons larger..."
- "I've added the contact form. Here's how it works..."

### Explanations

AI often explains its changes. Read these to learn:

> "I've added flexbox to center the content. Flexbox is a CSS layout
> method that makes it easy to align items..."

---

## Cost Tracking

OSW Studio tracks how much you're spending on AI calls.

> **Note**: Accurate cost tracking currently only works with **OpenRouter**. Other providers may show no cost data or inaccurate values.

### Viewing Costs

Click the **💰** icon in the settings to see:
- Cost per message
- Total session cost
- Model pricing rates

### Saving Money

**Use efficient models:**
- `gpt-4o-mini` - Good balance of cost and quality
- `claude-3-5-haiku` - Fast and affordable
- Avoid expensive models for simple tasks

**Be concise:**
- One clear request beats multiple vague ones
- Smaller context = lower cost

**Use Chat Mode for questions:**
- Read-only mode uses fewer tokens
- Save Code Mode for actual changes

---

## Best Practices

### ✅ Do's

**DO start simple:**
Get basic structure working first, then add complexity

**DO test as you go:**
Check the preview after each change

**DO ask for explanations:**
Learning helps you write better prompts

**DO use templates:**
Starting from a template saves time and tokens

**DO break big tasks into steps:**
Incremental progress is more reliable

### ❌ Don'ts

**DON'T ask for everything at once:**
Complex multi-feature requests often fail

**DON'T ignore errors:**
If something breaks, ask AI to fix it before continuing

**DON'T assume AI remembers:**
Reference earlier work explicitly if needed

**DON'T keep working on errors:**
Stop and fix issues when they appear

---

## Examples: Good vs Bad Prompts

### Example 1: Adding a Feature

❌ **Bad:**
```
make a contact page
```

✅ **Good:**
```
Create a contact page with:
- Page title "Get In Touch"
- Contact form (name, email, message fields)
- Submit button in blue
- Add to navigation menu
```

### Example 2: Styling

❌ **Bad:**
```
better colors
```

✅ **Good:**
```
Change color scheme:
- Primary: #3B82F6 (blue)
- Secondary: #8B5CF6 (purple)
- Background: #F9FAFB (light gray)
Update buttons, links, and headings to use these colors
```

### Example 3: Fixing Issues

❌ **Bad:**
```
it's broken
```

✅ **Good:**
```
The mobile menu isn't working. When I click the hamburger icon,
nothing happens. Can you fix the JavaScript?
```

---

## Server Context (Server Mode Only)

In Server Mode, the AI can understand your published deployment's backend features when you select a deployment from the dropdown in the workspace header.

### What the AI Knows

When a deployment is selected, the AI has access to:
- **Edge Functions** - Available API endpoints
- **Database Schema** - Tables, columns, and types
- **Server Functions** - Reusable helper code
- **Scheduled Functions** - Cron schedules and linked functions
- **Secrets** - Available secret names (not values)

### Example Prompts

```
What edge functions are available?
```

```
Create an endpoint to fetch all users from the database
```

```
I need to use the STRIPE_KEY secret in a payment function
```

```
Show me the current database schema
```

```
Set up a scheduled function to clean up old records every night at 3am
```

### How It Works

OSW Studio mounts a `/.server/` hidden folder containing JSON files with your deployment's backend context. The LLM reads these to understand what exists and writes to them to extend them.

See **[Backend → AI Integration](?doc=backend-features#ai-integration)** for more details.

---

## Visual Context & Control

### Focus Tool

Click the **crosshair** icon in the preview toolbar, then click any element to attach it as context to your next message. The AI receives the element's HTML, path, and surrounding structure, and where it is: the page, the width you picked it at, and its line in the source. So you can say "make this bigger on phones" instead of describing what you mean.

### The AI Sees Your Pages

The AI can look at a page as visitors see it, at any width, with its scripts run: `inspect` reads the page's layout and says which CSS rule sets each value, and `screenshot` shows it the page when the model reads images.

When you have selected an element and ask for a change to it, in a static or Handlebars project, the AI can make the change where the Inspector's own changes go, `/overrides.css`. It then checks that the change shows on the page. When a stronger rule in your CSS would win, the change is marked `!important` so it applies; if even that does not help, the AI says what wins and takes its change back out. In browser mode, Ctrl/Cmd+Z in the workspace undoes it like your own edits. To turn those overrides into ordinary CSS in your stylesheets, press **Move into stylesheets** under the CSS readout in the Styles tab and send the request it puts in the chat. **Remove unused** next to it clears out rules for elements that no longer exist.

Your own edits are looked after when the AI rewrites a page. A style you gave an element in the Inspector hangs on a `data-osw-id` attribute in the HTML; if a rewrite leaves the attribute out, it is put back where the element can still be recognised, and the AI is told. The same goes for a block placeholder it removed without being asked and an element you locked.

### Semantic Blocks

Open the **Blocks** palette in the preview toolbar or on Canvas and drag any of the 36 blocks (hero, pricing, gallery, contact form, etc.) onto the page where you want it. In static and Handlebars projects a placeholder for the block goes into the page's HTML, so it shows in the file, the Elements tab and on every Canvas artboard; Ctrl/Cmd+Z takes it out again, and so does removing the block from the chat. When you send your message, the AI replaces the placeholder with the block, written to fit your project's style: blocks are specifications, not pre-built snippets. Styles you give the placeholder in the Styles tab, such as its height or spacing, carry over to the block. A placeholder that has not been built yet stays in your project and is left out of the site when you publish or export it. In other project types the placeholder shows in the preview only.

### Image Attachments

Drop images into the chat input to include them as context. Works with any vision-capable model — the model selector shows a **Vision** badge for supported models.

### Pause, Continue, Retry

- **Stop** - Click Stop during generation to halt the AI immediately.
- **Continue** - If the AI stops because of an API error or timeout, Continue resumes with feedback about what went wrong.
- **Retry** - Every user message has a Retry button that rewinds to the checkpoint before that message and re-runs it.

---

## Advanced Tips

### Reference Specific Files

```
In styles.css, change the button padding to 12px 24px
```

### Request Multiple Variations

```
Show me 3 different color schemes for the hero section
```

### Ask for Best Practices

```
Is this the best way to structure my HTML for SEO?
What improvements would you suggest?
```

### Combine Changes

```
Make the header sticky AND add a shadow when scrolling
```

### Request Cleanup

```
Remove any unused CSS and organize the file by sections
```

---

## Troubleshooting

### AI Isn't Understanding

- Be more specific about what you want
- Break the request into smaller parts
- Provide visual examples or references

### Changes Aren't Showing

- Check if you're in Code Mode (not Chat Mode)
- Refresh the preview
- Check for JavaScript errors in browser console

### Code Looks Wrong

```
This doesn't look right. Can you review and fix any issues?
```

### Want to Undo

- Use checkpoints to restore earlier versions
- Ask AI to revert specific changes

```
Undo the last change you made to the CSS
```

---

**Next Steps:**

- **[Templates](?doc=templates)** - Start faster with templates
- **[Skills](?doc=skills)** - Teach AI your preferences
- **[MCP Server](?doc=mcp-server)** - Let Claude Code or another client drive the same agent
- **[FAQ](?doc=faq)** - Common questions answered
