'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Terminal as TerminalIcon, Play, Square, Trash2 } from 'lucide-react';
import { PanelHeader } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { scriptRunner } from '@/lib/scripting/script-runner';
import { vfsShell } from '@/lib/vfs/cli-shell';
import { vfs } from '@/lib/vfs';
import type { ScriptRuntime, ScriptWorkerResponse } from '@/lib/scripting/types';
import type { ProjectRuntime } from '@/lib/vfs/types';
import { getRuntimeConfig } from '@/lib/runtimes/registry';
import { logger } from '@/lib/utils';

interface ConsolePanelProps {
  projectId: string;
  runtime: ProjectRuntime;
  onClose?: () => void;
  bufferedMessages?: { level: string; text: string }[];
  onBufferConsumed?: () => void;
}

/** Tokenize a command string into argv, respecting quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/** Get the script runtime from a file extension. */
function runtimeFromExtension(path: string): ScriptRuntime | null {
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.lua')) return 'lua';
  return null;
}

/** Check if a file is executable in the console. */
function isExecutableFile(path: string): boolean {
  return runtimeFromExtension(path) !== null;
}

const MAX_HISTORY = 50;

/** Write a colored log line to the terminal based on level. */
function writeLogLine(term: import('@xterm/xterm').Terminal, level: string, text: string) {
  switch (level) {
    case 'warn':
      term.writeln(`\x1b[33m[warn] ${text}\x1b[0m`);
      break;
    case 'error':
      term.writeln(`\x1b[31m[error] ${text}\x1b[0m`);
      break;
    case 'info':
      term.writeln(`\x1b[36m[info] ${text}\x1b[0m`);
      break;
    case 'debug':
      term.writeln(`\x1b[2m[debug] ${text}\x1b[0m`);
      break;
    default:
      term.writeln(text);
      break;
  }
}

export function ConsolePanel({ projectId, runtime, onClose, bufferedMessages, onBufferConsumed }: ConsolePanelProps) {
  const tc = useTranslations('common');
  const tw = useTranslations('workspace');
  // Terminal output is written from long-lived effects and callbacks; reading the translator
  // through a ref keeps their text in the current locale.
  const consoleText = useTranslations('workspace.console');
  const consoleTextRef = useRef(consoleText);
  consoleTextRef.current = consoleText;
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Entry point / file dropdown
  const isTerminalRuntime = getRuntimeConfig(runtime).previewMode === 'terminal';
  const defaultEntryPoint = runtime === 'python' ? '/main.py' : runtime === 'lua' ? '/main.lua' : '';
  const [selectedEntryPoint, setSelectedEntryPoint] = useState(defaultEntryPoint);
  const [executableFiles, setExecutableFiles] = useState<string[]>([]);

  // Input line buffer
  const inputBufferRef = useRef('');
  const cursorPosRef = useRef(0);
  const isRunningRef = useRef(false);

  // Command history
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef('');

  // Cooldown: ignore filesChanged for 1s after script completion
  // (output-file VFS writes arrive after 'complete', re-triggering auto-run)
  const lastRunCompletedRef = useRef(0);

  // Track AI generation state to suppress auto-run during generation
  const generatingRef = useRef(false);
  const lastBuildSuccessRef = useRef(false);

  // Load executable files from VFS
  const loadExecutableFiles = useCallback(async () => {
    try {
      await vfs.init();
      const files = await vfs.listFiles(projectId);
      const execs = files
        .filter((f: { path: string }) => isExecutableFile(f.path))
        .map((f: { path: string }) => f.path)
        .sort();
      setExecutableFiles(execs);
    } catch (_err) {
      // ignore
    }
  }, [projectId]);

  // Initialize xterm
  useEffect(() => {
    let cancelled = false;
    let terminal: import('@xterm/xterm').Terminal | null = null;
    let fitAddon: import('@xterm/addon-fit').FitAddon | null = null;

    const init = async () => {
      if (!terminalRef.current) return;

      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      try {
        await import('@xterm/xterm/css/xterm.css');
      } catch (_cssErr) { /* non-fatal */ }

      if (cancelled || !terminalRef.current) return;

      terminalRef.current.innerHTML = '';

      terminal = new Terminal({
        theme: {
          background: '#1a1a2e',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          cursorAccent: '#1a1a2e',
          selectionBackground: 'rgba(255, 255, 255, 0.2)',
          black: '#1a1a2e',
          red: '#ff6b6b',
          green: '#51cf66',
          yellow: '#ffd43b',
          blue: '#748ffc',
          magenta: '#cc5de8',
          cyan: '#66d9e8',
          white: '#e0e0e0',
          brightBlack: '#495057',
          brightRed: '#ff8787',
          brightGreen: '#69db7c',
          brightYellow: '#ffe066',
          brightBlue: '#91a7ff',
          brightMagenta: '#e599f7',
          brightCyan: '#99e9f2',
          brightWhite: '#f8f9fa',
        },
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, monospace',
        lineHeight: 1.4,
        cursorBlink: true,
        disableStdin: false,
        convertEol: true,
        scrollback: 5000,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalRef.current);

      requestAnimationFrame(() => {
        if (fitAddon && !cancelled) {
          try { fitAddon.fit(); } catch (_e) { /* not attached yet */ }
        }
      });

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;
      setIsReady(true);

      // Welcome message
      terminal.writeln(`\x1b[2m${consoleTextRef.current('ready')}\x1b[0m`);
      writePrompt(terminal);

      // Replay buffered messages captured while console was hidden
      if (bufferedMessages && bufferedMessages.length > 0) {
        for (const msg of bufferedMessages) {
          writeLogLine(terminal, msg.level, msg.text);
        }
        onBufferConsumed?.();
        writePrompt(terminal);
      }

      // Wire up input handler
      terminal.onData((data) => {
        handleTerminalInput(data);
      });
    };

    init().catch(err => logger.error('Failed to initialize console:', err));

    return () => {
      cancelled = true;
      terminal?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load files on mount and when files change
  useEffect(() => {
    loadExecutableFiles();
    const handler = () => loadExecutableFiles();
    window.addEventListener('filesChanged', handler);
    return () => window.removeEventListener('filesChanged', handler);
  }, [loadExecutableFiles]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current) {
        try { fitAddonRef.current.fit(); } catch (_e) { /* ignore */ }
      }
    };

    window.addEventListener('resize', handleResize);
    const observer = new ResizeObserver(handleResize);
    if (terminalRef.current?.parentElement) {
      observer.observe(terminalRef.current.parentElement);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
    };
  }, [isReady]);

  // Track AI generation state to suppress auto-run
  useEffect(() => {
    const handler = (e: Event) => {
      generatingRef.current = (e as CustomEvent).detail?.generating ?? false;
    };
    window.addEventListener('generationStateChanged', handler);
    return () => window.removeEventListener('generationStateChanged', handler);
  }, []);

  // Show compilation output for non-terminal runtimes (React, Preact, Svelte, Vue, static)
  useEffect(() => {
    if (isTerminalRuntime) return;

    const handleCompilation = (e: Event) => {
      // Suppress during AI generation
      if (generatingRef.current) return;

      const detail = (e as CustomEvent).detail;
      const term = xtermRef.current;
      if (!term) return;

      if (detail.success) {
        // Skip consecutive success messages (multiple compiles on load)
        if (!lastBuildSuccessRef.current) {
          term.writeln(`\x1b[32m\u2713 ${consoleTextRef.current('buildSuccessful')}\x1b[0m`);
        }
        lastBuildSuccessRef.current = true;
      } else {
        lastBuildSuccessRef.current = false;
        for (const err of detail.errors) {
          term.writeln(`\x1b[31m\u2717 ${err.file}: ${err.error}\x1b[0m`);
        }
      }
    };

    window.addEventListener('compilationComplete', handleCompilation);
    return () => window.removeEventListener('compilationComplete', handleCompilation);
  }, [isTerminalRuntime]);

  // Capture console.log/warn/error/info/debug from preview iframe
  useEffect(() => {
    if (isTerminalRuntime) return;

    const handler = (e: Event) => {
      if (generatingRef.current) return;
      const term = xtermRef.current;
      if (!term) return;

      const { level, args } = (e as CustomEvent<{ level: string; args: string[] }>).detail;
      writeLogLine(term, level, args.join(' '));
    };

    window.addEventListener('previewConsole', handler);
    return () => window.removeEventListener('previewConsole', handler);
  }, [isTerminalRuntime]);

  // Listen for "runInConsole" custom event from file explorer
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (detail?.path) {
        setSelectedEntryPoint(detail.path);
        runFile(detail.path);
      }
    };
    window.addEventListener('runInConsole', handler);
    return () => window.removeEventListener('runInConsole', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Subscribe to script runner output
  useEffect(() => {
    const unsubscribe = scriptRunner.onOutput((msg: ScriptWorkerResponse) => {
      const term = xtermRef.current;
      if (!term) return;

      switch (msg.type) {
        case 'stdout':
          term.writeln(msg.data);
          break;
        case 'stderr':
          term.writeln(`\x1b[31m${msg.data}\x1b[0m`);
          break;
        case 'status':
          term.writeln(`\x1b[2m${msg.data}\x1b[0m`);
          break;
        case 'error':
          term.writeln(`\x1b[31;1m${msg.data}\x1b[0m`);
          break;
        case 'complete':
          isRunningRef.current = false;
          lastRunCompletedRef.current = Date.now();
          setIsRunning(false);
          if (msg.exitCode === 0) {
            term.writeln(`\x1b[2m--- ${consoleTextRef.current('scriptCompleted')} ---\x1b[0m`);
          } else {
            term.writeln(`\x1b[31;2m--- ${consoleTextRef.current('scriptExited', { code: msg.exitCode ?? '' })} ---\x1b[0m`);
          }
          writePrompt(term);
          break;
        case 'output-file':
          handleOutputFile(msg.path, msg.content);
          break;
      }
    });

    return unsubscribe;
  }, [projectId]);

  // Handle output files from script execution
  const handleOutputFile = useCallback(async (path: string, content: string) => {
    try {
      await vfs.init();
      const files = await vfs.listFiles(projectId);
      const existing = files.find((f: { path: string }) => f.path === path);

      if (existing) {
        await vfs.updateFile(projectId, path, content);
      } else {
        try { await vfs.createDirectory(projectId, '/output'); } catch (_e) { /* exists */ }
        await vfs.createFile(projectId, path, content);
      }
    } catch (err) {
      logger.error('Failed to write output file:', err);
    }
  }, [projectId]);

  // Auto-run on file changes (terminal runtimes only)
  useEffect(() => {
    if (!isTerminalRuntime) return;

    const handleFilesChanged = () => {
      // Skip if AI is generating — wait for explicit python/lua command
      if (generatingRef.current) return;
      // Skip if a script is running or just finished (output-file writes trigger filesChanged)
      if (isRunningRef.current) return;
      if (Date.now() - lastRunCompletedRef.current < 1000) return;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        if (isRunningRef.current) return;
        if (Date.now() - lastRunCompletedRef.current < 1000) return;
        const ep = selectedEntryPoint || defaultEntryPoint;
        if (ep) runFile(ep);
      }, 150);
    };

    window.addEventListener('filesChanged', handleFilesChanged);

    return () => {
      window.removeEventListener('filesChanged', handleFilesChanged);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryPoint, defaultEntryPoint, isTerminalRuntime, projectId]);

  // Auto-run entry point on initial ready (terminal runtimes only)
  useEffect(() => {
    if (!isReady || !isTerminalRuntime) return;
    const ep = selectedEntryPoint || defaultEntryPoint;
    if (ep) {
      // Short delay to let the terminal render the welcome message first
      const timer = setTimeout(() => runFile(ep), 100);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      scriptRunner.dispose();
    };
  }, []);

  // --- Input handling ---

  function writePrompt(term: import('@xterm/xterm').Terminal) {
    term.write('\r\n\x1b[32m$\x1b[0m ');
  }

  function redrawLine() {
    const term = xtermRef.current;
    if (!term) return;
    const buf = inputBufferRef.current;
    const pos = cursorPosRef.current;

    // Move to start of line, clear it, rewrite prompt + buffer
    term.write('\r\x1b[K\x1b[32m$\x1b[0m ' + buf);

    // Position cursor correctly
    const charsAfterCursor = buf.length - pos;
    if (charsAfterCursor > 0) {
      term.write(`\x1b[${charsAfterCursor}D`);
    }
  }

  function handleTerminalInput(data: string) {
    const term = xtermRef.current;
    if (!term) return;

    // During script execution, only Ctrl+C is handled
    if (isRunningRef.current) {
      if (data === '\x03') {
        stopScript();
      }
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      // Check for escape sequences (arrow keys etc.)
      if (ch === '\x1b' && i + 2 < data.length && data[i + 1] === '[') {
        const code = data[i + 2];
        i += 2; // skip '[' and code

        switch (code) {
          case 'A': // Up arrow — history back
            navigateHistory(-1);
            break;
          case 'B': // Down arrow — history forward
            navigateHistory(1);
            break;
          case 'C': // Right arrow
            if (cursorPosRef.current < inputBufferRef.current.length) {
              cursorPosRef.current++;
              term.write('\x1b[C');
            }
            break;
          case 'D': // Left arrow
            if (cursorPosRef.current > 0) {
              cursorPosRef.current--;
              term.write('\x1b[D');
            }
            break;
        }
        continue;
      }

      switch (ch) {
        case '\r': // Enter
          term.write('\r\n');
          processCommand();
          break;

        case '\x7f': // Backspace
          if (cursorPosRef.current > 0) {
            const buf = inputBufferRef.current;
            inputBufferRef.current = buf.slice(0, cursorPosRef.current - 1) + buf.slice(cursorPosRef.current);
            cursorPosRef.current--;
            redrawLine();
          }
          break;

        case '\x03': // Ctrl+C
          term.write('^C');
          inputBufferRef.current = '';
          cursorPosRef.current = 0;
          historyIndexRef.current = -1;
          writePrompt(term);
          break;

        case '\x0c': // Ctrl+L — clear
          term.clear();
          redrawLine();
          break;

        default:
          // Only insert printable characters
          if (ch >= ' ') {
            const buf = inputBufferRef.current;
            inputBufferRef.current = buf.slice(0, cursorPosRef.current) + ch + buf.slice(cursorPosRef.current);
            cursorPosRef.current++;
            redrawLine();
          }
          break;
      }
    }
  }

  function navigateHistory(direction: number) {
    const history = historyRef.current;
    if (history.length === 0) return;

    const idx = historyIndexRef.current;

    if (direction < 0) {
      // Going back in history
      if (idx === -1) {
        // Save current input before navigating
        savedInputRef.current = inputBufferRef.current;
        historyIndexRef.current = history.length - 1;
      } else if (idx > 0) {
        historyIndexRef.current = idx - 1;
      } else {
        return; // Already at oldest
      }
    } else {
      // Going forward in history
      if (idx === -1) return; // Already at current input
      if (idx < history.length - 1) {
        historyIndexRef.current = idx + 1;
      } else {
        // Return to saved input
        historyIndexRef.current = -1;
        inputBufferRef.current = savedInputRef.current;
        cursorPosRef.current = inputBufferRef.current.length;
        redrawLine();
        return;
      }
    }

    inputBufferRef.current = history[historyIndexRef.current];
    cursorPosRef.current = inputBufferRef.current.length;
    redrawLine();
  }

  async function processCommand() {
    const line = inputBufferRef.current.trim();
    inputBufferRef.current = '';
    cursorPosRef.current = 0;
    historyIndexRef.current = -1;

    if (!line) {
      writePrompt(xtermRef.current!);
      return;
    }

    // Push to history (avoid consecutive duplicates)
    const history = historyRef.current;
    if (history.length === 0 || history[history.length - 1] !== line) {
      history.push(line);
      if (history.length > MAX_HISTORY) history.shift();
    }

    const tokens = tokenize(line);
    if (tokens.length === 0) {
      writePrompt(xtermRef.current!);
      return;
    }

    const cmd = tokens[0];

    // Route commands
    switch (cmd) {
      case 'exec':
        await handleExec(tokens.slice(1));
        break;
      case 'clear':
        xtermRef.current?.clear();
        writePrompt(xtermRef.current!);
        break;
      case 'help':
        printHelp();
        break;
      default:
        // Route to VFS shell
        await handleBashCommand(tokens);
        break;
    }
  }

  async function handleExec(args: string[]) {
    const term = xtermRef.current;
    if (!term) return;

    if (args.length === 0) {
      term.writeln(`\x1b[33m${consoleTextRef.current('usage', { usage: 'exec <file.py|file.lua>' })}\x1b[0m`);
      writePrompt(term);
      return;
    }

    const filePath = args[0].startsWith('/') ? args[0] : '/' + args[0];
    const sr = runtimeFromExtension(filePath);

    if (!sr) {
      term.writeln(`\x1b[31m${consoleTextRef.current('unsupportedType', { file: filePath })}\x1b[0m`);
      term.writeln(`\x1b[2m${consoleTextRef.current('supportedTypes', { types: '.py, .lua' })}\x1b[0m`);
      writePrompt(term);
      return;
    }

    setSelectedEntryPoint(filePath);
    runFile(filePath);
  }

  function runFile(filePath: string) {
    const term = xtermRef.current;
    if (!term) return;

    const sr = runtimeFromExtension(filePath);
    if (!sr) return;

    // Abort any running execution
    if (isRunningRef.current) {
      scriptRunner.abort();
    }

    isRunningRef.current = true;
    setIsRunning(true);

    term.writeln(`\x1b[2m--- ${consoleTextRef.current('running', { file: filePath })} ---\x1b[0m`);

    scriptRunner.execute(projectId, sr, filePath).catch(err => {
      term.writeln(`\x1b[31m${consoleTextRef.current('execFailed', { error: String(err) })}\x1b[0m`);
      isRunningRef.current = false;
      setIsRunning(false);
      writePrompt(term);
    });
  }

  async function handleBashCommand(tokens: string[]) {
    const term = xtermRef.current;
    if (!term) return;

    try {
      const result = await vfsShell.execute(projectId, tokens);

      if (result.success) {
        if (result.stdout) {
          // Write each line individually to handle EOL properly
          const lines = result.stdout.split('\n');
          for (const line of lines) {
            term.writeln(line);
          }
        }
      } else {
        if (result.stderr) {
          term.writeln(`\x1b[31m${result.stderr}\x1b[0m`);
        }
      }
    } catch (err) {
      term.writeln(`\x1b[31m${consoleTextRef.current('error', { error: err instanceof Error ? err.message : consoleTextRef.current('unknownError') })}\x1b[0m`);
    }

    writePrompt(term);
  }

  function printHelp() {
    const term = xtermRef.current;
    if (!term) return;

    const say = consoleTextRef.current;
    term.writeln('');
    term.writeln(`\x1b[1m${say('helpCommands')}\x1b[0m`);
    term.writeln(`  \x1b[36mexec <file>\x1b[0m     ${say('helpExec')}`);
    term.writeln(`  \x1b[36mclear\x1b[0m           ${say('helpClear')}`);
    term.writeln(`  \x1b[36mhelp\x1b[0m            ${say('helpHelp')}`);
    term.writeln('');
    term.writeln(`\x1b[1m${say('helpVfs')}\x1b[0m`);
    term.writeln('  ls, cat, head, tail, grep, rg, find, mkdir, touch,');
    term.writeln('  rm, mv, cp, echo, sed, wc, tree, curl');
    term.writeln('');
    term.writeln(`\x1b[1m${say('helpOperators')}\x1b[0m ${say('helpOperatorList')}`);
    term.writeln('');

    writePrompt(term);
  }

  // --- Button handlers ---

  const handleRun = useCallback(() => {
    const ep = selectedEntryPoint || defaultEntryPoint;
    if (ep) runFile(ep);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryPoint, defaultEntryPoint, projectId]);

  const stopScript = useCallback(() => {
    scriptRunner.abort();
    isRunningRef.current = false;
    setIsRunning(false);
    const term = xtermRef.current;
    if (term) {
      term.writeln(`\x1b[33m--- ${consoleTextRef.current('scriptAborted')} ---\x1b[0m`);
      writePrompt(term);
    }
  }, []);

  const clearConsole = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  // Determine if we should show run/stop buttons
  const hasExecutableFiles = executableFiles.length > 0 || isTerminalRuntime;

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        icon={TerminalIcon}
        title={tw('tabs.console')}
        color="var(--button-terminal-active, #22c55e)"
        onClose={onClose}
        panelKey="console"
        actions={
          <>
            {hasExecutableFiles && (
              isRunning ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 text-destructive hover:text-destructive md:h-5 md:px-2 md:border-0 md:bg-transparent md:rounded-md"
                  onClick={stopScript}
                >
                  <Square className="h-2.5 w-2.5 md:h-3 md:w-3" />
                  <span className="text-xs">{tc('actions.stop')}</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:px-2 md:border-0 md:bg-transparent md:rounded-md"
                  onClick={handleRun}
                  disabled={!selectedEntryPoint && !defaultEntryPoint}
                >
                  <Play className="h-2.5 w-2.5 md:h-3 md:w-3" />
                  <span className="text-xs">{tw('run')}</span>
                </Button>
              )
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:px-2 md:border-0 md:bg-transparent md:rounded-md"
              onClick={clearConsole}
            >
              <Trash2 className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <span className="text-xs">{tc('actions.clear')}</span>
            </Button>
          </>
        }
      >
        {/* File dropdown (when executable files exist) */}
        {hasExecutableFiles && (
          <select
            value={selectedEntryPoint}
            onChange={(e) => setSelectedEntryPoint(e.target.value)}
            className="text-xs bg-background border border-border rounded px-1.5 py-0.5 max-w-[140px] ml-1"
          >
            {executableFiles.map(f => (
              <option key={f} value={f}>{f}</option>
            ))}
            {selectedEntryPoint && !executableFiles.includes(selectedEntryPoint) && (
              <option value={selectedEntryPoint}>{selectedEntryPoint}</option>
            )}
          </select>
        )}
      </PanelHeader>

      {/* Terminal area */}
      <div className="flex-1 overflow-hidden p-1" style={{ backgroundColor: '#1a1a2e' }}>
        <div ref={terminalRef} className="h-full w-full" />
      </div>
    </div>
  );
}
