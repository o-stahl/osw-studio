# Troubleshooting Guide

---

## Installation & Setup

### Node Version Errors

**Symptoms**:
```
Error: The engine "node" is incompatible with this module
```

**Solution**:
```bash
# Check current version
node -v

# Should be 18.x or higher
# Install correct version
nvm install 18
nvm use 18

# Or with Homebrew (macOS)
brew install node@18
```

### npm install Failures

**Symptoms**:
```
npm ERR! code ERESOLVE
npm ERR! ERESOLVE unable to resolve dependency tree
```

**Solutions**:
```bash
# Clear cache
npm cache clean --force

# Delete node_modules and package-lock
rm -rf node_modules package-lock.json

# Reinstall
npm install

# If still failing, use legacy peer deps
npm install --legacy-peer-deps
```

### Build Errors

**Symptoms**:
```
Error: Cannot find module '@next/swc-darwin-arm64'
```

**Solutions**:
```bash
# Reinstall dependencies
rm -rf node_modules .next
npm install

# Run build
npm run build

# If specific platform binary missing
npm install --force
```

---

## API & Provider Issues

### Invalid API Key

**Symptoms**:
- "Invalid API key" error
- 401 Unauthorized
- Authentication failed

**Solutions**:
1. **Verify key is correct**:
   - Copy key directly from provider
   - Check for extra spaces
   - Ensure no line breaks

2. **Check key permissions**:
   - OpenAI: Key must have chat/completions access
   - Anthropic: Key must be active
   - OpenRouter: Check credits balance

3. **Re-enter key**:
   - Settings → Select provider → Click **Disconnect** → Paste new key → Click **Connect**

### Rate Limiting

**Symptoms**:
- "Rate limit exceeded" error
- 429 Too Many Requests
- Slow responses

**What happens automatically**:
- A short rate limit is retried; the chat says it is trying again.
- If it does not clear, the task stops and the chat shows a card. **Continue** carries on from that point on the same model. The card may also suggest another model or another connected provider; the model only changes if you pick one.
- When a daily or monthly allowance is used up, the card shows the provider's own count and reset time when it publishes them.
- With **Free models** selected (OpenRouter), a busy free model is passed over for the next suggested free model, and the chat names both. This is the only case where the model changes without you choosing it.

**Solutions**:
1. **Wait before retrying**:
   - Wait 1 minute before next request

2. **Switch models**:
   - Use different model with separate limits
   - Or connect another provider from the card and continue there

3. **Upgrade plan**:
   - Check provider's pricing page
   - Higher tiers often have higher limits

### Model Not Found

**Symptoms**:
- "Model not found" error
- 404 Model does not exist
- "Invalid model" message

**Solutions**:
1. **Check model name**:
   - Exact spelling required
   - Case-sensitive for some providers

2. **Refresh model list**:
   - Settings → Provider → Click refresh icon
   - Select from updated list

3. **Check provider access**:
   - Some models require special access
   - OpenAI: o1 requires tier 3+
   - Anthropic: Check beta access

### Connection Timeouts

**Symptoms**:
- Request timeout
- No response from AI
- Connection error

**Solutions**:
1. **Check internet connection**:
   - Test with other websites
   - Disable VPN temporarily

2. **Try different provider**:
   - Issue may be provider-specific
   - Switch to backup provider

3. **Check provider status**:
   - Visit provider's status page
   - OpenAI: status.openai.com
   - Anthropic: status.anthropic.com

### Local Providers (Ollama, LM Studio, llama.cpp)

OSW Studio's server talks to a local model server on your behalf, so the model server must run on the same machine as OSW Studio. The HuggingFace Space cannot reach a model server on your computer; use the desktop app or a self-hosted instance for local models.

**Symptoms**:
```
Could not reach Ollama at http://127.0.0.1:11434/v1
```

**Solutions**:
1. **Start the server**: `ollama serve` (Ollama), or start the local server in LM Studio
2. **Run the check**: Settings → Connections → Add a provider → Ollama → Check setup (or open the Ollama card once connected). It reports whether Ollama answers, whether the selected model is pulled, whether the model supports tool calls, and the context length it will be loaded with, each with the command that fixes it.
3. **Pick a model with tool calls**: tasks need them. `ollama pull qwen3:4b` is a small one that works.

Each local provider has a **Context length** setting on its connection (default 32,768 tokens). For Ollama, OSW Studio loads the model with that window; Ollama's own default of 4k tokens cuts off the start of the instructions and the model works from a fragment. For LM Studio and llama.cpp the window is set when the model is loaded or the server started, so set the value to match. In every case OSW Studio compacts the conversation to stay inside it. Lower it if a model does not fit in memory.

---

## Generation Issues

### AI Not Responding

**Symptoms**:
- "Thinking..." indicator stuck
- No response after several minutes
- Request seems to hang

**Solutions**:
1. **Check browser console** (F12):
   - Look for JavaScript errors
   - Check network tab for failed requests

2. **Refresh page**:
   - Reload browser tab
   - Projects and conversation persist

3. **Try shorter prompt**:
   - Very long prompts may timeout
   - Break into smaller requests

4. **Switch models**:
   - Some models may be overloaded
   - Try different provider

### Tool Call Failures

**Symptoms**:
- Red X marks on tool executions
- "File not found" errors
- "Invalid path" errors

**Solutions**:
1. **Check file paths**:
   - Paths must start with `/`
   - Case-sensitive

2. **Verify file exists**:
   - Check file explorer
   - AI may be referencing old/deleted file

3. **Retry**:
   - AI usually retries automatically
   - Or rephrase request

### Loop Detection Triggered

**Symptoms**:
```
Loop detected: Preventing repeated failed command
```

**Solutions**:
1. **Different approach**:
   - AI was repeating failing command
   - Rephrase your request
   - Provide more context

2. **Manual fix**:
   - Fix the issue manually
   - Then ask AI to continue

3. **Fresh start**:
   - Start new conversation
   - Describe problem differently

### Out of Memory

**Symptoms**:
- Browser tab crashes
- "Out of memory" error
- Slow/unresponsive UI

**Solutions**:
1. **Close other tabs**:
   - Free up browser memory

2. **Smaller project**:
   - Split large project into parts
   - Delete unused files

3. **Restart browser**:
   - Close and reopen browser
   - Clear cache if needed

---

## Browser Mode Issues

### IndexedDB Quota Exceeded

**Symptoms**:
```
QuotaExceededError: The quota has been exceeded
```

**Solutions**:
1. **Delete old projects**:
   - Export important projects first
   - Delete unused projects

2. **Clear browser data**:
   - Keep OSW Studio origin
   - Or export all (.osws) then reimport

3. **Check browser quota**:
```javascript
// In console (F12)
navigator.storage.estimate().then(estimate => {
  console.log(`Using ${estimate.usage} of ${estimate.quota} bytes`);
});
```

### Lost Data After Clearing Cookies

**Symptoms**:
- All projects gone
- After clearing browser data

**Prevention**:
- Regular .osws exports (backups)
- Don't clear IndexedDB for OSW Studio origin

**Recovery**:
- Import last .osws backup
- Or start fresh

### Slow Performance with Large Projects

**Symptoms**:
- Laggy editor
- Slow file operations
- Preview takes long to load

**Solutions**:
1. **Reduce project size**:
   - Delete unused files
   - Compress images
   - Remove old assets

2. **Split project**:
   - Break into multiple smaller projects

3. **Use Server Mode**:
   - Server Mode handles large projects better

---

## Editor Issues

### Monaco Not Loading

**Symptoms**:
- Blank editor area
- "Loading editor..." stuck
- No syntax highlighting

**Solutions**:
1. **Refresh page**:
   - Hard refresh (Cmd/Ctrl+Shift+R)

2. **Check browser console**:
   - Look for Monaco-related errors
   - Network issues loading CDN

3. **Disable extensions**:
   - Browser extensions may interfere
   - Try in incognito/private mode

### File Not Saving

**Symptoms**:
- Changes not persisting
- "Save failed" error
- File reverts after close

**Solutions**:
1. **Check VFS**:
   - File explorer should update
   - If not, VFS write failed

2. **Try manual save**:
   - Cmd/Ctrl+S
   - Check for error messages

3. **Check browser storage**:
   - May be quota issue (see above)

### Tab Issues

**Symptoms**:
- Can't close tabs
- Tabs not switching
- Wrong file showing

**Solutions**:
1. **Refresh page**:
   - Editor state resets

2. **Close all tabs**:
   - Right-click → Close All
   - Reopen files from explorer

---

## Preview Issues

### Preview Not Updating

**Symptoms**:
- Changes not reflected
- Old version showing
- Preview stuck

**Solutions**:
1. **Manual refresh**:
   - Click ↻ button in preview

2. **Hard refresh preview**:
   - Right-click preview → Inspect
   - In DevTools: Right-click refresh → Hard Reload

3. **Save file first**:
   - Cmd/Ctrl+S
   - Then preview updates

### Assets Not Loading

**Symptoms**:
- Images broken (missing icon)
- CSS not applied
- JavaScript not running

**Solutions**:
1. **Check file paths**:
   - Absolute paths from the project root work: `/images/logo.png`
   - Relative paths also work: `./images/logo.png`
   - Paths are case-sensitive

2. **Verify files exist**:
   - Check file explorer
   - Correct spelling/case

3. **Check browser console**:
   - F12 → Console tab
   - Look for 404 errors

### Handlebars Errors

**Symptoms**:
```
Error: Missing partial: header
```
or
```
Error: Parse error on line 5
```

**Auto-fix**: In Code Mode, the AI can run `build` to check for compilation errors and fix them. You can also ask the AI to run `build` if you see errors in the preview.

**Manual solutions** (if the AI doesn't catch it, or in Chat Mode):
1. **Check partial exists**:
   - `/templates/header.hbs` must exist
   - Correct path in `{{> header}}`

2. **Check syntax**:
   - Closing tags match opening
   - Valid Handlebars syntax

3. **Check front matter**:
   - YAML between `---` delimiters
   - Valid YAML syntax

### Blob URL Issues

**Symptoms**:
- `blob:` URLs in the preview
- Images work in preview but not export

**Solution**:
- This is normal for preview
- Export compiles to regular paths
- Deploy exported ZIP, not preview

---

## Export Issues

### ZIP Download Fails

**Symptoms**:
- Export button does nothing
- Download starts but fails
- Corrupted ZIP file

**Solutions**:
1. **Check browser permissions**:
   - Allow downloads for site

2. **Try different browser**:
   - Chrome, Firefox, or Safari

3. **Smaller project**:
   - If project very large, may timeout
   - Remove unused assets

### Missing Files in Export

**Symptoms**:
- Exported ZIP incomplete
- Some files missing
- Folder structure wrong

**Solutions**:
1. **Check file explorer**:
   - Ensure all files saved
   - Cmd/Ctrl+S

2. **Wait for export to complete**:
   - Large projects take time
   - Don't interrupt download

3. **Re-export**:
   - Try export again
   - Check ZIP contents

### Handlebars Not Compiled

**Symptoms**:
- `.hbs` files in ZIP
- `{{> partial}}` syntax in output
- Site broken when deployed

**Solution**:
- Ensure using "Export → ZIP" (not .osws)
- ZIP export auto-compiles Handlebars
- If issue persists, report bug

---

## Performance Issues

### Slow AI Responses

**Symptoms**:
- Long wait times
- "Thinking..." for minutes

**Causes**:
- Provider-side latency
- Model overload
- Large context

**Solutions**:
1. **Switch models**:
   - Try faster model (smaller size)
   - Or different provider

2. **Reduce context**:
   - Start fresh conversation
   - Delete old messages

3. **Use streaming**:
   - Most providers support streaming
   - See partial responses as they generate

### Slow File Operations

**Symptoms**:
- Laggy editor typing
- Slow file explorer
- Preview delays

**Solutions**:
1. **Reduce project size**:
   - Delete unused files
   - Optimize images

2. **Close unused tabs**:
   - Only open files you need

3. **Restart browser**:
   - Free up memory

### High Memory Usage

**Symptoms**:
- Browser tab uses lots of RAM
- Computer fan running
- Other apps slow

**Solutions**:
1. **Close other tabs/apps**:
   - Free system resources

2. **Smaller projects**:
   - Split into multiple projects

3. **Use Server Mode**:
   - Offload storage to server

---

## Still Having Issues?

1. **Check documentation**: Other guides may have answers
2. **Browser console**: F12 → Console for error details
3. **Report bug**: [GitHub Issues](https://github.com/o-stahl/osw-studio/issues)

**When reporting**:
- Describe expected vs actual behavior
- Include error messages
- Browser and OS version
- Steps to reproduce
