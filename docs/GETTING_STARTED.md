# Getting Started with OSW Studio

**Create your first website in 5 minutes.**

This guide will walk you through setting up OSW Studio and building your first project.

---

## Step 1: Choose an AI Provider

OSW Studio needs an AI model to generate code. You have two options:

### Option A: Cloud Providers

Use a cloud AI service. You'll need an API key and will pay per usage (typically low cost).

| Provider | Get API Key |
|----------|-------------|
| **OpenRouter** | [Get Key](https://openrouter.ai/keys) |
| **OpenAI** | [Get Key](https://platform.openai.com/api-keys) |
| **Anthropic** | [Get Key](https://console.anthropic.com/settings/keys) |
| **Google** | [Get Key](https://aistudio.google.com/apikey) |
| **Groq** | [Get Key](https://console.groq.com/keys) |
| **HuggingFace** | [Get Token](https://huggingface.co/settings/tokens) |
| **DeepSeek** | [Get Key](https://platform.deepseek.com/api_keys) |
| **SambaNova** | [Get Key](https://cloud.sambanova.ai/) |
| **MiniMax** | [Get Key](https://www.minimax.io/platform/user-center/basic-information/interface-key) |
| **Zhipu** | [Get Key](https://bigmodel.cn/usercenter/apikeys) |
| **Pollinations** | [Get Key](https://enter.pollinations.ai/keys) |
| **Vercel AI Gateway** | [Get Key](https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys) |

**Note**: OSW Studio is developed using OpenRouter, so that provider has the most testing.

### Sign in with OpenRouter (No Key to Copy)

When nothing is connected yet, the chat shows ways to connect. **Sign in** next to OpenRouter takes you to OpenRouter, and you come back connected. A new OpenRouter account can use free models up to a daily limit; adding credit unlocks paid models. An account that has never bought credit starts on **Free models**, the first entry in OpenRouter's model list, which uses the best free model available and moves on when one is busy. Pick any other model and it stays picked.

You can also paste a key from any provider into the field under the options. OSW Studio recognises most providers from the key itself, and asks when it cannot tell.

### Option A2: HuggingFace (Free Tier)

HuggingFace provides $0.10/month in free inference credits to all users — no payment method required.

1. Create an account at [huggingface.co](https://huggingface.co)
2. Go to [Settings → Access Tokens](https://huggingface.co/settings/tokens)
3. Create a new token with **"Make calls to Inference Providers"** permission
4. In Settings, select **HuggingFace** and paste the token

On HuggingFace Spaces, you can also sign in with one click via OAuth (no token needed).

### Option B: ChatGPT Subscription (No API Key)

If you have a ChatGPT Plus or Pro subscription you can use it instead of a separate API key.

1. In Settings → Connections, select **ChatGPT Subscription (Codex)**
2. Click **Sign in with ChatGPT** and approve access in the browser window

No Codex CLI or device authorization setting is required. Desktop/local installations complete automatically. On a remote or self-hosted instance, OpenAI still redirects to localhost; copy the failed ChatGPT tab's full address-bar URL into the form OSW Studio displays. OSW Studio then creates the tokens automatically. The refresh token is kept in an HttpOnly cookie (not localStorage), so client-side JS never has access to it. (ChatGPT sign-in isn't available on HuggingFace Spaces, which runs the app in an embedded frame that can't hold the session cookie.)

> **Warning**: This routes through an unofficial endpoint using your ChatGPT session. OpenAI may restrict or revoke access at any time. For something more stable, use an [OpenAI API key](https://platform.openai.com/api-keys) instead.

### Option C: Local AI (Free, No API Key)

Run AI models on your computer. Completely free but requires installation.

- **[Ollama](https://ollama.ai)** - Run open-source models locally via CLI
- **[LM Studio](https://lmstudio.ai)** - GUI for running local models
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** - Lightweight C++ inference server
- **[mesh-llm](https://github.com/michaelneale/mesh-llm)** - Free open-model inference via a peer-to-peer network (run `mesh-llm --auto` locally to join)

---

## Step 2: Configure Your Provider

You can configure your AI provider in two places:

**Option A: Global Settings**
1. Go to **Settings > Provider & Model**
2. Select your provider from the dropdown
3. Paste your API key and click **Connect** (validates the key)
4. Choose a model from the list

**Option B: In Workspace**
1. Open or create a project
2. Click the **model button** at the bottom left of the Chat panel
3. Select provider, paste API key, click **Connect**, and choose a model

Your selection persists automatically. You can swap models anytime, or click **Disconnect** to remove a stored key.

**That's it!** You're ready to build.

---

## Step 3: Create Your First Project

Let's build a simple personal website.

### Start a New Project

1. Click **Projects** in the sidebar
2. Click **+ New Project**
3. Name your project (e.g., "My Portfolio")
4. Choose a template. The list is grouped by what you're setting out to make, and starts on
   **Handlebars Starter**, an empty website with partials so a nav or footer is written once. Some
   of the twenty:
   - **Static Starter** - an empty website in plain HTML, CSS and JavaScript
   - **Business Website** - one page for a local business: services, prices, hours, location
   - **Portfolio & CV** - one page about one person: selected work, bio, work history
   - **Example Studios** - multi-page agency portfolio with Handlebars
   - **LLM Wiki** - a knowledge base the assistant writes and keeps current as you add sources
   - **Projects & Tasks** - a board of what you are working on, kept in order by the assistant
   - **Store Locator** - a searchable map of your locations, ready to embed elsewhere
   - **Guided Chat** - a chat widget with pre-set replies, needing no backend
   - **To-do List** - a checklist that saves itself in your browser
   - **Landing Page with Contact Form** - contact page wired to an edge function (Server Mode)
   - **Blog with Comments** - multi-page blog with comments via a server function (Server Mode)
   - **AI Assistant** - a chat page whose API key stays in a server function (Server Mode)
   - **Spring Boot REST API** - a Java service you edit here and build elsewhere
   - **Runtime starters** - a closed section holding the eight minimal setups, one per runtime

   The template sets the project's runtime, and you can change it later in project settings.

You'll see the workspace with 4 panels:
- **Chat** (left-most) - Talk to AI
- **File Explorer** (2nd) - Your project files
- **Code Editor** (3rd) - View and edit code
- **Preview** (last) - Live preview of your site

You can open and close panels from their headers and the sidebar on the workspace.

### Build With AI

In the chat, try this prompt:

```
Create a simple portfolio website with:
- A hero section with my name and title
- An about section
- A projects section
- A contact section
- Modern design with a blue color scheme
```

**Watch the AI work:**
- It will create HTML, CSS, and JavaScript files
- You'll see each file creation in the chat
- The preview updates in real-time
- You can ask it to make changes anytime

### Make Changes

Don't like something? Just ask:

```
Make the hero section taller and add a gradient background
```

```
Change the color scheme to purple and orange
```

```
Add smooth scrolling when clicking navigation links
```

The AI will update your code and explain what it changed.

---

## Step 4: Export Your Site

When you're happy with your website:

1. Click the **Menu** icon (three dots) in the top right
2. Select **Export**
3. Choose **ZIP** (suitable for hosting) or **JSON** (for backup)
4. Download the file

You now have a complete, ready-to-deploy website!

---

## Step 5: Deploy to the Web

Upload your site to make it live. Here are the easiest options:

### Vercel (Recommended)

1. Go to [vercel.com](https://vercel.com)
2. Sign up (free)
3. Drag and drop your ZIP file
4. Get a live URL instantly

### Netlify

1. Go to [netlify.com](https://netlify.com)
2. Sign up (free)
3. Drag and drop your ZIP file
4. Get a live URL instantly

Both services offer:
- Free hosting
- Automatic HTTPS
- Custom domains (optional)
- Instant deploys

**[Detailed deployment guide →](?doc=deploying-sites)**

---

## What's Next?

**Get better results from AI:**
- [Working with AI](?doc=working-with-ai) - Prompting tips and best practices

**Speed up your workflow:**
- [Templates](?doc=templates) - Start projects faster
- [Skills](?doc=skills) - Teach AI your preferences

**Manage your work:**
- [Projects](?doc=projects) - Save, organize, and export projects

**Advanced features:**
- [Server Mode](?doc=server-mode) - Self-host and publish sites directly

**Need help?**
- [FAQ](?doc=faq) - Common questions
- [Troubleshooting](?doc=troubleshooting) - Fix issues

---

## Quick Tips

**💡 Be Specific**
Instead of "make it look good", try "add a gradient from blue to purple in the hero section"

**💡 Make One Change at a Time**
Breaking requests into smaller steps gives better results

**💡 Save Often**
Projects auto-save, but you can manually save with Ctrl+S (Cmd+S on Mac)

**💡 Use Templates**
Starting from a template is faster than building from scratch

**💡 Start Simple**
Get the basic structure working, then add features one by one

---

**Ready to build?** Head back to Projects and start creating!
