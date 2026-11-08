'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { MultiAgentOrchestrator, type ContextBreakdown } from '@/lib/llm/multi-agent-orchestrator';
import { testScenarios, testTracks, testSequences } from '@/lib/testing/test-scenarios';
import type { AssertionResult, TestSequence } from '@/lib/testing/types';
import { ArrowLeft, Play, CheckCircle, XCircle, Clock, RefreshCw, ChevronDown, ChevronUp, Square, Download, Minus, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ModelSettingsPanel } from '@/components/settings/model-settings';
import { configManager } from '@/lib/config/storage';
import { AppHeader, HeaderAction } from '@/components/ui/app-header';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';

interface ToolCallDetail {
  name: string;
  status: 'success' | 'failed';
  args?: string;
  bashCommand?: string;
}

const KNOWN_TOOLS = new Set(['bash', 'shell']);

interface ToolStats {
  total: number;
  success: number;
  failed: number;
  invalid: number;
  invalidNames: string[];
  breakdown: Record<string, { total: number; success: number; failed: number }>;
  bashCommands: Record<string, number>;
}

function computeToolStats(details: ToolCallDetail[]): ToolStats {
  const breakdown: Record<string, { total: number; success: number; failed: number }> = {};
  const bashCommands: Record<string, number> = {};
  let success = 0, failed = 0, invalid = 0;
  const invalidNameSet = new Set<string>();

  for (const d of details) {
    if (!KNOWN_TOOLS.has(d.name)) {
      invalid++;
      invalidNameSet.add(d.name);
    } else if (d.status === 'success') {
      success++;
    } else {
      failed++;
    }

    if (!breakdown[d.name]) breakdown[d.name] = { total: 0, success: 0, failed: 0 };
    breakdown[d.name].total++;
    if (d.status === 'success') breakdown[d.name].success++;
    else breakdown[d.name].failed++;

    if (d.bashCommand) {
      bashCommands[d.bashCommand] = (bashCommands[d.bashCommand] || 0) + 1;
    }
  }

  return { total: details.length, success, failed, invalid, invalidNames: [...invalidNameSet], breakdown, bashCommands };
}

function formatCost(amount: number): string {
  if (amount > 0 && amount < 0.0001) return '< $0.0001';
  return `$${amount.toFixed(4)}`;
}

interface ProgressDelta {
  text?: string;
  snapshot?: string;
}

interface ProgressToolStatus {
  toolName?: string;
  status?: string;
  args?: string;
}

interface TestResult {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'stopped';
  executionTime?: number;
  errors?: string[];
  details?: string;
  toolCalls?: number;
  generationOutput?: string;
  totalCost?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCallDetails?: ToolCallDetail[];
  assertionResults?: AssertionResult[];
  assertionScore?: number;
  judgeResult?: { passed: boolean; reasoning: string };
  selfEvalCorrect?: boolean;
  exitReason?: string;
  nudgeCount?: number;
  contextBreakdowns?: ContextBreakdown[];
  sequenceId?: string;
  isSequenceHeader?: boolean;
}

interface RoundResult {
  id: string;
  name: string;
  status: 'success' | 'failed' | 'stopped';
  executionTime?: number;
  totalCost?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  toolCallDetails?: ToolCallDetail[];
  assertionResults?: AssertionResult[];
  assertionScore?: number;
  judgeResult?: { passed: boolean; reasoning: string };
  selfEvalCorrect?: boolean;
  errors?: string[];
  details?: string;
  exitReason?: string;
  nudgeCount?: number;
  contextBreakdowns?: ContextBreakdown[];
  sequenceId?: string;
  isSequenceHeader?: boolean;
}

interface AggregatedTestResult {
  id: string;
  name: string;
  roundCount: number;
  passCount: number;
  failCount: number;
  passRate: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  avgCost: number;
  totalCost: number;
  avgTokens: number;
  avgToolCalls: number;
  avgAssertionScore?: number;
  rounds: RoundResult[];
}

const allScenarioIds = testScenarios.map(s => s.id);

function buildSequenceResults(sequences: TestSequence[]): TestResult[] {
  const results: TestResult[] = [];
  for (const seq of sequences) {
    results.push({ id: seq.id, name: seq.name, status: 'pending', isSequenceHeader: true });
    for (const step of seq.steps) {
      results.push({ id: step.id, name: step.name, status: 'pending', sequenceId: seq.id });
    }
  }
  return results;
}

const allSequenceStepIds = testSequences.flatMap(s => [s.id, ...s.steps.map(st => st.id)]);

export default function TestGenerationPage() {
  const router = useRouter();
  const [testResults, setTestResults] = useState<TestResult[]>([
    ...testScenarios.map(scenario => ({
      id: scenario.id,
      name: scenario.name,
      status: 'pending' as const,
    })),
    ...buildSequenceResults(testSequences),
  ]);
  const [runningTests, setRunningTests] = useState<Set<string>>(new Set());
  const [concurrency, setConcurrency] = useState(3);
  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const orchestratorInstances = useRef<Map<string, MultiAgentOrchestrator>>(new Map());
  const [expandedTests, setExpandedTests] = useState<Set<string>>(new Set());
  const generationOutputRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const batchCancelledRef = useRef(false);
  const [overallStats, setOverallStats] = useState({
    total: 0,
    passed: 0,
    failed: 0,
    successRate: 0,
    totalCost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolStats: { total: 0, success: 0, failed: 0, invalid: 0, invalidNames: [] as string[], breakdown: {} } as ToolStats,
  });

  // Model settings popover state
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [currentModel, setCurrentModel] = useState('');

  // Judge model settings
  const [judgeModel, setJudgeModel] = useState('');

  // Multi-round state
  const [totalRounds, setTotalRounds] = useState(1);
  const [currentRound, setCurrentRound] = useState(0);
  const [roundHistory, setRoundHistory] = useState<RoundResult[][]>([]);
  const [benchmarkComplete, setBenchmarkComplete] = useState(false);
  const [showBenchmarkInfo, setShowBenchmarkInfo] = useState(false);
  const testResultsRef = useRef<TestResult[]>([]);

  useEffect(() => { testResultsRef.current = testResults; }, [testResults]);

  useEffect(() => {
    setCurrentModel(configManager.getDefaultModel());
  }, []);

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return 'Select Model';
    const parts = modelId.split('/');
    const modelName = parts[parts.length - 1];
    return modelName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const runSingleTest = async (scenarioId: string) => {
    const scenario = testScenarios.find(s => s.id === scenarioId);
    if (!scenario) return;

    const key = scenarioId;

    const startTime = Date.now();
    setRunningTests(prev => new Set([...prev, key]));
    setExpandedTests(prev => new Set([...prev, key]));

    // Update status to running
    setTestResults(prev => prev.map(result =>
      result.id === key
        ? { ...result, status: 'running', generationOutput: '' }
        : result
    ));

    let projectId = '';
    const toolDetails: ToolCallDetail[] = [];
    try {
      projectId = `test-${Date.now()}`;

      if (!scenario.skipProjectSetup) {
        const { vfs } = await import('@/lib/vfs');
        await vfs.init();
        await vfs.createProject(`Test: ${scenario.name}`, undefined, projectId);

        if (scenario.setupFiles) {
          for (const [filePath, content] of Object.entries(scenario.setupFiles)) {
            await vfs.createFile(projectId, filePath, content);
          }
        }
      }

      const appendOutput = (resultId: string, text: string) => {
        setTestResults(prev => prev.map(result =>
          result.id === resultId
            ? { ...result, generationOutput: (result.generationOutput || '') + text }
            : result
        ));
        setTimeout(() => {
          const outputElement = generationOutputRefs.current.get(resultId);
          if (outputElement) {
            outputElement.scrollTop = outputElement.scrollHeight;
          }
        }, 0);
      };

      appendOutput(key, `[config] evaluationMode=status\n`);

      let exitReason: string | undefined;
      let nudgeCount = 0;
      let agentStartTime = 0;
      let reasoningBuffer = '';

      const flushReasoning = () => {
        if (!reasoningBuffer.trim()) { reasoningBuffer = ''; return; }
        const text = reasoningBuffer.trim().replace(/\n{2,}/g, '\n');
        const preview = text.length > 300 ? text.substring(0, 150) + ' … ' + text.substring(text.length - 147) : text;
        appendOutput(scenarioId, `[thinking] ${preview}\n`);
        reasoningBuffer = '';
      };

      const orchestrator = new MultiAgentOrchestrator(
        projectId,
        scenario.agentType || 'orchestrator',
        (message, step) => {
          if (message === 'assistant_delta') {
            flushReasoning();
            const delta = step as ProgressDelta;
            const deltaText = delta?.text;
            const snapshot = delta?.snapshot;
            if (!deltaText && !snapshot) return;

            if (snapshot !== undefined) {
              setTestResults(prev => prev.map(result =>
                result.id === key
                  ? { ...result, generationOutput: snapshot }
                  : result
              ));
            } else if (deltaText) {
              appendOutput(key, deltaText);
            }

            setTimeout(() => {
              const outputElement = generationOutputRefs.current.get(key);
              if (outputElement) {
                outputElement.scrollTop = outputElement.scrollHeight;
              }
            }, 0);
          }

          if (message === 'reasoning_delta') {
            const data = step as { text?: string };
            if (data?.text) {
              reasoningBuffer += data.text;
            }
          }

          if (message === 'tool_status') {
            flushReasoning();
            const data = step as ProgressToolStatus;
            const toolName = data?.toolName || 'unknown';
            if (data?.status === 'executing') {
              let argSnippet = '';
              if (data?.args) {
                try {
                  const parsed = JSON.parse(data.args);
                  if (toolName === 'bash' || toolName === 'shell') argSnippet = parsed.command || parsed.cmd || '';
                } catch {}
                const isVerboseCmd = argSnippet.trimStart().startsWith('status ') || argSnippet.trimStart().startsWith('agent ') || argSnippet.trimStart().startsWith('delegate ');
                if (!isVerboseCmd && argSnippet.length > 80) argSnippet = argSnippet.substring(0, 77) + '...';
              }
              toolDetails.push({ name: toolName, status: 'success', args: argSnippet });
              agentStartTime = 0;
              appendOutput(scenarioId, `\n[tool] ${toolName}${argSnippet ? ` — ${argSnippet}` : ' ...'}\n`);
            } else if (data?.status === 'completed') {
              appendOutput(scenarioId, `[tool] ${toolName} done\n`);
            } else if (data?.status === 'failed') {
              const last = [...toolDetails].reverse().find(d => d.name === toolName);
              if (last) last.status = 'failed';
              appendOutput(scenarioId, `[tool] ${toolName} failed\n`);
            }
          }

          if (message === 'agent_progress') {
            const data = step as Record<string, unknown>;
            const innerEvent = data?.event as string;
            const agentIndex = data?.agentIndex as number || 1;
            const innerData = data?.data as Record<string, unknown>;
            const promptLabel = String(data?.agentPrompt || data?.delegatePrompt || '');

            // Track relative time from first subagent event
            if (!agentStartTime) agentStartTime = Date.now();
            const t = ((Date.now() - agentStartTime) / 1000).toFixed(1);
            const label = `subagent ${agentIndex} +${t}s`;

            if (innerEvent === 'agent_start') {
              const preview = promptLabel.length > 80 ? promptLabel.substring(0, 77) + '...' : promptLabel;
              appendOutput(scenarioId, `  [${label}] started — "${preview}"\n`);
            } else if (innerEvent === 'agent_done') {
              const elapsed = innerData?.elapsed || '?';
              const bodyPreview = String(innerData?.bodyPreview || '(no output)');
              const preview = bodyPreview.length > 100 ? bodyPreview.substring(0, 97) + '...' : bodyPreview;
              appendOutput(scenarioId, `  [${label}] done (${elapsed}s) — ${preview}\n`);
            } else if (innerEvent === 'tool_status' && innerData?.status === 'executing') {
              let cmd = '';
              try {
                const parsed = JSON.parse(String(innerData.args || '{}'));
                cmd = parsed?.cmd || '';
              } catch { cmd = String(innerData.args || ''); }
              const cmdPreview = cmd.length > 100 ? cmd.substring(0, 97) + '...' : cmd;
              appendOutput(scenarioId, `  [${label}] ${cmdPreview}\n`);
            } else if (innerEvent === 'tool_status' && innerData?.status === 'completed') {
              appendOutput(scenarioId, `  [${label}] tool done\n`);
            } else if (innerEvent === 'tool_status' && innerData?.status === 'failed') {
              appendOutput(scenarioId, `  [${label}] tool failed\n`);
            }
          }

          if (message === 'exit_reason') {
            flushReasoning();
            const data = step as Record<string, unknown>;
            exitReason = String(data?.reason || 'unknown');
            appendOutput(scenarioId, `\n[exit] ${exitReason} (iteration ${data?.iteration})\n`);
          }

          if (message === 'nudge') {
            const data = step as Record<string, unknown>;
            nudgeCount = Number(data?.attempt || 0);
            appendOutput(scenarioId, `[nudge] ${data?.attempt}/${data?.max}\n`);
          }
        },
        { chatMode: false }
      );

      orchestratorInstances.current.set(key, orchestrator);

      const result = await orchestrator.execute(scenario.prompt);

      const toolCallCount = (result.conversation || []).reduce((count, node) => {
        return count + node.messages.reduce((msgCount, msg) => {
          return msgCount + (msg.tool_calls?.length || 0);
        }, 0);
      }, 0);

      // Extract detailed tool calls from conversation (more authoritative — has args)
      const conversationToolDetails: ToolCallDetail[] = [];
      const toolResultMap = new Map<string, boolean>();
      for (const node of (result.conversation || [])) {
        for (const msg of node.messages) {
          if (msg.role === 'tool' && msg.tool_call_id) {
            const content = typeof msg.content === 'string' ? msg.content : '';
            toolResultMap.set(msg.tool_call_id, !content.startsWith('Error:'));
          }
        }
        for (const msg of node.messages) {
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              let argSnippet = '';
              let bashCommand: string | undefined;
              try {
                const parsed = JSON.parse(tc.function.arguments);
                if (tc.function.name === 'bash' || tc.function.name === 'shell') {
                  argSnippet = parsed.command || parsed.cmd || '';
                  const firstWord = argSnippet.trimStart().split(/\s+/)[0];
                  if (firstWord) bashCommand = firstWord;
                }
              } catch {}
              const isVerboseCmd = argSnippet.trimStart().startsWith('status ') || argSnippet.trimStart().startsWith('agent ') || argSnippet.trimStart().startsWith('delegate ');
              if (!isVerboseCmd && argSnippet.length > 80) argSnippet = argSnippet.substring(0, 77) + '...';

              const succeeded = toolResultMap.has(tc.id) ? toolResultMap.get(tc.id)! : true;
              conversationToolDetails.push({
                name: tc.function.name,
                status: succeeded ? 'success' : 'failed',
                args: argSnippet,
                bashCommand,
              });
            }
          }
        }
      }

      const finalToolDetails = conversationToolDetails.length > 0 ? conversationToolDetails : toolDetails;

      // Run programmatic assertions (before project cleanup)
      let assertionResults: AssertionResult[] = [];
      if (scenario.assertions && scenario.assertions.length > 0) {
        try {
          const { runAssertions } = await import('@/lib/testing/assertion-runner');
          assertionResults = await runAssertions(projectId, result.conversation || [], scenario.assertions);
        } catch (err) {
          console.warn('Assertion runner error:', err);
        }
      }

      // Run judge assertions (if configured)
      const judgeAssertions = scenario.assertions?.filter(a => a.type === 'judge') || [];
      let judgeResult: { passed: boolean; reasoning: string } | undefined;
      if (judgeAssertions.length > 0 && judgeModel) {
        try {
          const { vfs: vfsInst } = await import('@/lib/vfs');
          const files = await vfsInst.listFiles(projectId);
          const fileContents: Record<string, string> = {};
          for (const f of files) {
            if (typeof f.content === 'string') {
              fileContents[f.path] = f.content;
            }
          }

          const judgeProvider = configManager.getSelectedProvider();
          const judgeApiKey = configManager.getProviderApiKey(judgeProvider) || '';
          const { runJudgeEvaluation } = await import('@/lib/testing/judge');
          judgeResult = await runJudgeEvaluation(
            judgeAssertions[0].criteria,
            { prompt: scenario.prompt, files: fileContents, summary: result.summary },
            { provider: judgeProvider, apiKey: judgeApiKey, model: judgeModel }
          );

          assertionResults.push({
            assertion: judgeAssertions[0],
            passed: judgeResult.passed,
            actual: judgeResult.reasoning,
          });
        } catch (err) {
          console.warn('Judge evaluation error:', err);
        }
      }

      // Compute assertion score and determine pass/fail
      const assertionScore = assertionResults.length > 0
        ? (assertionResults.filter(r => r.passed).length / assertionResults.length) * 100
        : undefined;

      const testPassed = assertionResults.length > 0
        ? assertionResults.every(r => r.passed)
        : result.success;

      setTestResults(prev => prev.map(testResult =>
        testResult.id === key
          ? {
              ...testResult,
              status: testPassed ? 'success' : 'failed',
              executionTime: Date.now() - startTime,
              errors: testPassed
                ? undefined
                : assertionResults.length > 0
                  ? assertionResults.filter(r => !r.passed).map(r => r.assertion.description + (r.actual ? ` — ${r.actual}` : ''))
                  : [result.summary],
              details: result.summary,
              toolCalls: toolCallCount,
              totalCost: result.totalCost,
              promptTokens: result.totalUsage.promptTokens,
              completionTokens: result.totalUsage.completionTokens,
              totalTokens: result.totalUsage.totalTokens,
              toolCallDetails: finalToolDetails,
              assertionResults: assertionResults.length > 0 ? assertionResults : undefined,
              assertionScore,
              judgeResult,
              selfEvalCorrect: assertionResults.length > 0 ? result.success === testPassed : undefined,
              exitReason,
              nudgeCount: nudgeCount > 0 ? nudgeCount : undefined,
              contextBreakdowns: result.contextBreakdowns,
            }
          : testResult
      ));

      if (testPassed) {
        toast.success(`Test passed: ${scenario.name}`);
      } else {
        toast.error(`Test failed: ${scenario.name}`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      setTestResults(prev => prev.map(result =>
        result.id === key
          ? {
              ...result,
              status: 'failed',
              executionTime: Date.now() - startTime,
              errors: [errorMessage],
              details: `Error: ${errorMessage}`,
              toolCallDetails: toolDetails.length > 0 ? toolDetails : undefined,
            }
          : result
      ));

      toast.error(`Test error: ${scenario.name}`);
    }

    orchestratorInstances.current.delete(key);

    if (projectId && !scenario.skipProjectSetup) {
      try {
        const { vfs } = await import('@/lib/vfs');
        await vfs.deleteProject(projectId);
      } catch {}
    }

    setRunningTests(prev => { const next = new Set(prev); next.delete(key); return next; });
  };

  const checkSequenceRequirements = (sequence: typeof testSequences[0]): string | null => {
    if (!sequence.requires) return null;
    const provider = configManager.getSelectedProvider();
    for (const req of sequence.requires) {
      if (req === 'compaction' && !configManager.isCompactionEnabled(provider)) {
        return 'Compaction must be enabled in Settings for this test. Enable it for the current provider and try again.';
      }
    }
    return null;
  };

  const runSequence = async (sequenceId: string) => {
    const sequence = testSequences.find(s => s.id === sequenceId);
    if (!sequence) return;

    const requirementError = checkSequenceRequirements(sequence);
    if (requirementError) {
      setTestResults(prev => prev.map(r =>
        r.id === sequenceId
          ? { ...r, status: 'stopped', errors: [requirementError], details: requirementError }
          : r.sequenceId === sequenceId
            ? { ...r, status: 'stopped', details: 'Skipped — prerequisite not met' }
            : r
      ));
      toast.error(`Skipped: ${sequence.name} — ${requirementError}`);
      return;
    }

    const startTime = Date.now();
    setRunningTests(prev => new Set([...prev, sequenceId]));
    setExpandedTests(prev => new Set([...prev, sequenceId]));

    setTestResults(prev => prev.map(r =>
      r.id === sequenceId
        ? { ...r, status: 'running', generationOutput: '' }
        : r.sequenceId === sequenceId
          ? { ...r, status: 'pending', generationOutput: '' }
          : r
    ));

    let projectId = '';
    const allToolDetails: ToolCallDetail[] = [];

    try {
      projectId = `test-seq-${Date.now()}`;

      if (!sequence.skipProjectSetup) {
        const { vfs } = await import('@/lib/vfs');
        await vfs.init();
        await vfs.createProject(`Test Seq: ${sequence.name}`, undefined, projectId);

        if (sequence.setupFiles) {
          for (const [filePath, content] of Object.entries(sequence.setupFiles)) {
            await vfs.createFile(projectId, filePath, content);
          }
        }
      }

      const appendOutput = (resultId: string, text: string) => {
        setTestResults(prev => prev.map(result =>
          result.id === resultId
            ? { ...result, generationOutput: (result.generationOutput || '') + text }
            : result
        ));
        setTimeout(() => {
          const outputElement = generationOutputRefs.current.get(resultId);
          if (outputElement) {
            outputElement.scrollTop = outputElement.scrollHeight;
          }
        }, 0);
      };

      let exitReason: string | undefined;
      let nudgeCount = 0;
      let agentStartTime = 0;
      let reasoningBuffer = '';
      let activeStepId = sequenceId;

      const flushReasoning = () => {
        if (!reasoningBuffer.trim()) { reasoningBuffer = ''; return; }
        const text = reasoningBuffer.trim().replace(/\n{2,}/g, '\n');
        const preview = text.length > 300 ? text.substring(0, 150) + ' … ' + text.substring(text.length - 147) : text;
        appendOutput(activeStepId, `[thinking] ${preview}\n`);
        reasoningBuffer = '';
      };

      const stepToolDetails: ToolCallDetail[] = [];

      const orchestrator = new MultiAgentOrchestrator(
        projectId,
        sequence.agentType || 'orchestrator',
        (message, step) => {
          if (message === 'assistant_delta') {
            flushReasoning();
            const delta = step as ProgressDelta;
            const deltaText = delta?.text;
            const snapshot = delta?.snapshot;
            if (!deltaText && !snapshot) return;

            if (snapshot !== undefined) {
              setTestResults(prev => prev.map(result =>
                result.id === activeStepId
                  ? { ...result, generationOutput: snapshot }
                  : result
              ));
            } else if (deltaText) {
              appendOutput(activeStepId, deltaText);
            }
          }

          if (message === 'reasoning_delta') {
            const data = step as { text?: string };
            if (data?.text) reasoningBuffer += data.text;
          }

          if (message === 'tool_status') {
            flushReasoning();
            const data = step as ProgressToolStatus;
            const toolName = data?.toolName || 'unknown';
            if (data?.status === 'executing') {
              let argSnippet = '';
              let bashCommand: string | undefined;
              if (data?.args) {
                try {
                  const parsed = JSON.parse(data.args);
                  if (toolName === 'bash' || toolName === 'shell') {
                    argSnippet = parsed.command || parsed.cmd || '';
                    const firstWord = argSnippet.trimStart().split(/\s+/)[0];
                    if (firstWord) bashCommand = firstWord;
                  }
                } catch {}
                const isVerboseCmd = argSnippet.trimStart().startsWith('status ') || argSnippet.trimStart().startsWith('agent ') || argSnippet.trimStart().startsWith('delegate ');
                if (!isVerboseCmd && argSnippet.length > 80) argSnippet = argSnippet.substring(0, 77) + '...';
              }
              stepToolDetails.push({ name: toolName, status: 'success', args: argSnippet, bashCommand });
              agentStartTime = 0;
              appendOutput(activeStepId, `\n[tool] ${toolName}${argSnippet ? ` — ${argSnippet}` : ' ...'}\n`);
            } else if (data?.status === 'completed') {
              appendOutput(activeStepId, `[tool] ${toolName} done\n`);
            } else if (data?.status === 'failed') {
              const last = [...stepToolDetails].reverse().find(d => d.name === toolName);
              if (last) last.status = 'failed';
              appendOutput(activeStepId, `[tool] ${toolName} failed\n`);
            }
          }

          if (message === 'agent_progress') {
            const data = step as Record<string, unknown>;
            const innerEvent = data?.event as string;
            const agentIndex = data?.agentIndex as number || 1;
            const innerData = data?.data as Record<string, unknown>;
            const promptLabel = String(data?.agentPrompt || data?.delegatePrompt || '');

            if (!agentStartTime) agentStartTime = Date.now();
            const t = ((Date.now() - agentStartTime) / 1000).toFixed(1);
            const label = `subagent ${agentIndex} +${t}s`;

            if (innerEvent === 'agent_start') {
              const preview = promptLabel.length > 80 ? promptLabel.substring(0, 77) + '...' : promptLabel;
              appendOutput(activeStepId, `  [${label}] started — "${preview}"\n`);
            } else if (innerEvent === 'agent_done') {
              const elapsed = innerData?.elapsed || '?';
              const bodyPreview = String(innerData?.bodyPreview || '(no output)');
              const preview = bodyPreview.length > 100 ? bodyPreview.substring(0, 97) + '...' : bodyPreview;
              appendOutput(activeStepId, `  [${label}] done (${elapsed}s) — ${preview}\n`);
            } else if (innerEvent === 'tool_status' && innerData?.status === 'executing') {
              let cmd = '';
              try {
                const parsed = JSON.parse(String(innerData.args || '{}'));
                cmd = parsed?.cmd || '';
              } catch { cmd = String(innerData.args || ''); }
              const cmdPreview = cmd.length > 100 ? cmd.substring(0, 97) + '...' : cmd;
              appendOutput(activeStepId, `  [${label}] ${cmdPreview}\n`);
            } else if (innerEvent === 'tool_status' && innerData?.status === 'completed') {
              appendOutput(activeStepId, `  [${label}] tool done\n`);
            } else if (innerEvent === 'tool_status' && innerData?.status === 'failed') {
              appendOutput(activeStepId, `  [${label}] tool failed\n`);
            }
          }

          if (message === 'exit_reason') {
            flushReasoning();
            const data = step as Record<string, unknown>;
            exitReason = String(data?.reason || 'unknown');
            appendOutput(activeStepId, `\n[exit] ${exitReason} (iteration ${data?.iteration})\n`);
          }

          if (message === 'nudge') {
            const data = step as Record<string, unknown>;
            nudgeCount = Number(data?.attempt || 0);
            appendOutput(activeStepId, `[nudge] ${data?.attempt}/${data?.max}\n`);
          }
        },
        { chatMode: false }
      );

      orchestratorInstances.current.set(sequenceId, orchestrator);

      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalTokens = 0;
      let totalCost = 0;
      let allContextBreakdowns: ContextBreakdown[] = [];
      let sequencePassed = true;
      let prevPromptTokens = 0;
      let prevCompletionTokens = 0;
      let prevTotalTokens = 0;
      let prevCost = 0;
      let prevConversationLength = 0;

      for (const step of sequence.steps) {
        if (batchCancelledRef.current) break;

        activeStepId = step.id;
        stepToolDetails.length = 0;
        exitReason = undefined;

        setTestResults(prev => prev.map(r =>
          r.id === step.id ? { ...r, status: 'running', generationOutput: '' } : r
        ));
        setExpandedTests(prev => new Set([...prev, step.id]));

        appendOutput(step.id, `[step] ${step.name}\n[prompt] ${step.prompt}\n`);

        const stepStart = Date.now();
        const result = await orchestrator.execute(step.prompt);

        const stepTime = Date.now() - stepStart;
        const stepPromptTokens = result.totalUsage.promptTokens - prevPromptTokens;
        const stepCompletionTokens = result.totalUsage.completionTokens - prevCompletionTokens;
        const stepTotalTokens = result.totalUsage.totalTokens - prevTotalTokens;
        const stepCost = result.totalCost - prevCost;
        prevPromptTokens = result.totalUsage.promptTokens;
        prevCompletionTokens = result.totalUsage.completionTokens;
        prevTotalTokens = result.totalUsage.totalTokens;
        prevCost = result.totalCost;
        totalPromptTokens += stepPromptTokens;
        totalCompletionTokens += stepCompletionTokens;
        totalTokens += stepTotalTokens;
        totalCost += stepCost;
        if (result.contextBreakdowns) {
          allContextBreakdowns = [...allContextBreakdowns, ...result.contextBreakdowns];
        }

        const conversationToolDetails: ToolCallDetail[] = [];
        const toolResultMap = new Map<string, boolean>();
        const fullConversation = result.conversation || [];
        const newNodes = fullConversation.slice(prevConversationLength);
        prevConversationLength = fullConversation.length;
        for (const node of newNodes) {
          for (const msg of node.messages) {
            if (msg.role === 'tool' && msg.tool_call_id) {
              const content = typeof msg.content === 'string' ? msg.content : '';
              toolResultMap.set(msg.tool_call_id, !content.startsWith('Error:'));
            }
          }
          for (const msg of node.messages) {
            if (msg.tool_calls) {
              for (const tc of msg.tool_calls) {
                let argSnippet = '';
                let bashCommand: string | undefined;
                try {
                  const parsed = JSON.parse(tc.function.arguments);
                  if (tc.function.name === 'bash' || tc.function.name === 'shell') {
                    argSnippet = parsed.command || parsed.cmd || '';
                    const firstWord = argSnippet.trimStart().split(/\s+/)[0];
                    if (firstWord) bashCommand = firstWord;
                  }
                } catch {}
                const isVerboseCmd = argSnippet.trimStart().startsWith('status ') || argSnippet.trimStart().startsWith('agent ') || argSnippet.trimStart().startsWith('delegate ');
                if (!isVerboseCmd && argSnippet.length > 80) argSnippet = argSnippet.substring(0, 77) + '...';

                const succeeded = toolResultMap.has(tc.id) ? toolResultMap.get(tc.id)! : true;
                conversationToolDetails.push({
                  name: tc.function.name,
                  status: succeeded ? 'success' : 'failed',
                  args: argSnippet,
                  bashCommand,
                });
              }
            }
          }
        }

        const finalStepTools = conversationToolDetails.length > 0 ? conversationToolDetails : [...stepToolDetails];
        allToolDetails.push(...finalStepTools);

        let assertionResults: AssertionResult[] = [];
        if (step.assertions && step.assertions.length > 0) {
          try {
            const { runAssertions } = await import('@/lib/testing/assertion-runner');
            assertionResults = await runAssertions(projectId, result.conversation || [], step.assertions);
          } catch (err) {
            console.warn('Assertion runner error:', err);
          }
        }

        const judgeAssertions = step.assertions?.filter(a => a.type === 'judge') || [];
        if (judgeAssertions.length > 0 && judgeModel) {
          try {
            const { vfs: vfsInst } = await import('@/lib/vfs');
            const files = await vfsInst.listFiles(projectId);
            const fileContents: Record<string, string> = {};
            for (const f of files) {
              if (typeof f.content === 'string') fileContents[f.path] = f.content;
            }
            const judgeProvider = configManager.getSelectedProvider();
            const judgeApiKey = configManager.getProviderApiKey(judgeProvider) || '';
            const { runJudgeEvaluation } = await import('@/lib/testing/judge');
            const judgeResult = await runJudgeEvaluation(
              judgeAssertions[0].criteria,
              { prompt: step.prompt, files: fileContents, summary: result.summary },
              { provider: judgeProvider, apiKey: judgeApiKey, model: judgeModel }
            );
            assertionResults.push({
              assertion: judgeAssertions[0],
              passed: judgeResult.passed,
              actual: judgeResult.reasoning,
            });
          } catch (err) {
            console.warn('Judge evaluation error:', err);
          }
        }

        const assertionScore = assertionResults.length > 0
          ? (assertionResults.filter(r => r.passed).length / assertionResults.length) * 100
          : undefined;

        const stepPassed = assertionResults.length > 0
          ? assertionResults.every(r => r.passed)
          : result.success;

        if (!stepPassed) sequencePassed = false;

        const toolCallCount = (result.conversation || []).reduce((count, node) => {
          return count + node.messages.reduce((msgCount, msg) => {
            return msgCount + (msg.tool_calls?.length || 0);
          }, 0);
        }, 0);

        setTestResults(prev => prev.map(r =>
          r.id === step.id
            ? {
                ...r,
                status: stepPassed ? 'success' : 'failed',
                executionTime: stepTime,
                errors: stepPassed
                  ? undefined
                  : assertionResults.length > 0
                    ? assertionResults.filter(a => !a.passed).map(a => a.assertion.description + (a.actual ? ` — ${a.actual}` : ''))
                    : [result.summary],
                details: result.summary,
                toolCalls: toolCallCount,
                totalCost: stepCost,
                promptTokens: stepPromptTokens,
                completionTokens: stepCompletionTokens,
                totalTokens: stepTotalTokens,
                toolCallDetails: finalStepTools,
                assertionResults: assertionResults.length > 0 ? assertionResults : undefined,
                assertionScore,
                exitReason,
                contextBreakdowns: result.contextBreakdowns,
              }
            : r
        ));

        if (stepPassed) {
          toast.success(`Step passed: ${step.name}`);
        } else {
          toast.error(`Step failed: ${step.name}`);
        }
      }

      setTestResults(prev => prev.map(r =>
        r.id === sequenceId
          ? {
              ...r,
              status: sequencePassed ? 'success' : 'failed',
              executionTime: Date.now() - startTime,
              toolCalls: allToolDetails.length,
              totalCost,
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              totalTokens,
              toolCallDetails: allToolDetails,
              contextBreakdowns: allContextBreakdowns.length > 0 ? allContextBreakdowns : undefined,
              details: `${sequence.steps.length} steps — ${sequencePassed ? 'all passed' : 'some failed'}`,
            }
          : r
      ));

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      setTestResults(prev => prev.map(r =>
        r.id === sequenceId
          ? {
              ...r,
              status: 'failed',
              executionTime: Date.now() - startTime,
              errors: [errorMessage],
              details: `Error: ${errorMessage}`,
            }
          : r
      ));

      toast.error(`Sequence error: ${sequence.name}`);
    }

    orchestratorInstances.current.delete(sequenceId);

    if (projectId && !sequence.skipProjectSetup) {
      try {
        const { vfs } = await import('@/lib/vfs');
        await vfs.deleteProject(projectId);
      } catch {}
    }

    setRunningTests(prev => { const next = new Set(prev); next.delete(sequenceId); return next; });
  };

  const stopTest = (scenarioId: string) => {
    const orchestrator = orchestratorInstances.current.get(scenarioId);
    if (orchestrator) {
      orchestrator.stop();
      toast.info(`Stopping test: ${testScenarios.find(s => s.id === scenarioId)?.name || testSequences.find(s => s.id === scenarioId)?.name}`);
    }
  };

  /** Build initial pending result entries */
  const buildPendingResults = (scenarioIds: string[], sequenceIds?: string[]): TestResult[] => {
    const results: TestResult[] = [];
    const scenarios = testScenarios.filter(s => scenarioIds.includes(s.id));
    results.push(...scenarios.map(s => ({ id: s.id, name: s.name, status: 'pending' as const })));
    if (sequenceIds && sequenceIds.length > 0) {
      results.push(...buildSequenceResults(testSequences.filter(s => sequenceIds.includes(s.id))));
    }
    return results;
  };

  const runTrack = async (trackId: string) => {
    const isSequenceTrack = trackId === 'sequences';
    const isAllTrack = trackId === 'all';

    const scenarioIds = isSequenceTrack
      ? []
      : isAllTrack
        ? allScenarioIds
        : testTracks.find(t => t.id === trackId)?.scenarioIds || [];

    const sequenceIds = isSequenceTrack || isAllTrack
      ? testSequences.map(s => s.id)
      : [];

    if (scenarioIds.length === 0 && sequenceIds.length === 0) return;

    setActiveTrack(trackId);
    batchCancelledRef.current = false;
    setRoundHistory([]);
    setBenchmarkComplete(false);

    for (let round = 0; round < totalRounds; round++) {
      if (batchCancelledRef.current) break;
      setCurrentRound(round);

      setTestResults(buildPendingResults(scenarioIds, sequenceIds));

      // Build task queue: standalone tests first, then sequences
      const tasks: (() => Promise<void>)[] = [
        ...scenarioIds.map(id => () => runSingleTest(id)),
        ...sequenceIds.map(id => () => runSequence(id)),
      ];

      // Run with concurrency limit
      const limit = concurrency;
      let idx = 0;
      const runNext = async (): Promise<void> => {
        while (idx < tasks.length) {
          if (batchCancelledRef.current) return;
          const task = tasks[idx++];
          await task();
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => runNext()));

      const snapshot: RoundResult[] = testResultsRef.current
        .filter(r => r.status === 'success' || r.status === 'failed' || r.status === 'stopped')
        .map(r => ({
          id: r.id,
          name: r.name,
          status: r.status as 'success' | 'failed' | 'stopped',
          executionTime: r.executionTime,
          totalCost: r.totalCost,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.totalTokens,
          toolCalls: r.toolCalls,
          toolCallDetails: r.toolCallDetails,
          assertionResults: r.assertionResults,
          assertionScore: r.assertionScore,
          judgeResult: r.judgeResult,
          selfEvalCorrect: r.selfEvalCorrect,
          errors: r.errors,
          details: r.details,
          exitReason: r.exitReason,
          nudgeCount: r.nudgeCount,
          contextBreakdowns: r.contextBreakdowns,
          sequenceId: r.sequenceId,
          isSequenceHeader: r.isSequenceHeader,
        }));
      setRoundHistory(prev => [...prev, snapshot]);
    }

    setBenchmarkComplete(true);
    setActiveTrack(null);
  };

  // Derive overall stats from testResults reactively (exclude sequence headers to avoid double-counting)
  useEffect(() => {
    const completed = testResults.filter(r => r.status !== 'pending' && r.status !== 'running' && !r.isSequenceHeader);
    const passed = testResults.filter(r => r.status === 'success' && !r.isSequenceHeader);

    const totalCost = completed.reduce((sum, r) => sum + (r.totalCost || 0), 0);
    const promptTokens = completed.reduce((sum, r) => sum + (r.promptTokens || 0), 0);
    const completionTokens = completed.reduce((sum, r) => sum + (r.completionTokens || 0), 0);
    const totalTokens = completed.reduce((sum, r) => sum + (r.totalTokens || 0), 0);
    const allToolDetails = completed.flatMap(r => r.toolCallDetails || []);
    const toolStats = computeToolStats(allToolDetails);

    setOverallStats({
      total: completed.length,
      passed: passed.length,
      failed: completed.length - passed.length,
      successRate: completed.length > 0 ? (passed.length / completed.length) * 100 : 0,
      totalCost,
      promptTokens,
      completionTokens,
      totalTokens,
      toolStats,
    });
  }, [testResults]);

  const stopBenchmark = () => {
    batchCancelledRef.current = true;
    orchestratorInstances.current.forEach((orchestrator) => {
      orchestrator.stop();
    });
  };

  const resetTests = () => {
    stopBenchmark();
    setTestResults(buildPendingResults(allScenarioIds, testSequences.map(s => s.id)));
    setOverallStats({ total: 0, passed: 0, failed: 0, successRate: 0, totalCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolStats: { total: 0, success: 0, failed: 0, invalid: 0, invalidNames: [], breakdown: {}, bashCommands: {} } });
    setRunningTests(new Set());
    setActiveTrack(null);
    orchestratorInstances.current = new Map();
    setExpandedTests(new Set());
    setRoundHistory([]);
    setCurrentRound(0);
    setBenchmarkComplete(false);
  };

  const getStatusIcon = (status: TestResult['status']) => {
    switch (status) {
      case 'success': return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'failed': return <XCircle className="h-4 w-4 text-red-500" />;
      case 'stopped': return <Square className="h-4 w-4 text-orange-500" />;
      case 'running': return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin" />;
      default: return <Clock className="h-4 w-4 text-gray-400" />;
    }
  };

  // Compute per-track report data
  const trackReports = useMemo(() => {
    const reports: Record<string, {
      total: number;
      passed: number;
      failed: number;
      successRate: number;
      avgTime: number;
      totalToolCalls: number;
      totalCost: number;
      totalTokens: number;
      toolStats: ToolStats;
      totalAssertions: number;
      passedAssertions: number;
      assertionScore: number;
      selfEvalTotal: number;
      selfEvalCorrect: number;
      allDone: boolean;
      results: TestResult[];
    }> = {};

    for (const track of testTracks) {
      const trackResults = track.scenarioIds
        .map(id => testResults.find(r => r.id === id))
        .filter((r): r is TestResult => r !== undefined);

      const terminal = trackResults.filter(r => r.status === 'success' || r.status === 'failed' || r.status === 'stopped');
      const passed = terminal.filter(r => r.status === 'success');
      const allDone = terminal.length === trackResults.length && terminal.length > 0;
      const times = terminal.filter(r => r.executionTime).map(r => r.executionTime!);
      const avgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      const totalToolCalls = terminal.reduce((sum, r) => sum + (r.toolCalls || 0), 0);
      const totalCost = terminal.reduce((sum, r) => sum + (r.totalCost || 0), 0);
      const totalTokens = terminal.reduce((sum, r) => sum + (r.totalTokens || 0), 0);

      const allDetails = terminal.flatMap(r => r.toolCallDetails || []);
      const toolStats = computeToolStats(allDetails);

      const totalAssertions = terminal.reduce((sum, r) => sum + (r.assertionResults?.length || 0), 0);
      const passedAssertions = terminal.reduce((sum, r) =>
        sum + (r.assertionResults?.filter(a => a.passed).length || 0), 0);
      const assertionScore = totalAssertions > 0 ? (passedAssertions / totalAssertions) * 100 : 0;

      const selfEvalTotal = terminal.filter(r => r.selfEvalCorrect !== undefined).length;
      const selfEvalCorrectCount = terminal.filter(r => r.selfEvalCorrect === true).length;

      reports[track.id] = {
        total: trackResults.length,
        passed: passed.length,
        failed: terminal.length - passed.length,
        successRate: terminal.length > 0 ? (passed.length / terminal.length) * 100 : 0,
        avgTime,
        totalToolCalls,
        totalCost,
        totalTokens,
        toolStats,
        totalAssertions,
        passedAssertions,
        assertionScore,
        selfEvalTotal,
        selfEvalCorrect: selfEvalCorrectCount,
        allDone,
        results: trackResults,
      };
    }

    return reports;
  }, [testResults]);

  // Aggregated results across all rounds
  const aggregatedResults = useMemo((): AggregatedTestResult[] => {
    if (roundHistory.length === 0) return [];

    const scenarioMap = new Map<string, RoundResult[]>();
    for (const round of roundHistory) {
      for (const result of round) {
        const existing = scenarioMap.get(result.id) || [];
        existing.push(result);
        scenarioMap.set(result.id, existing);
      }
    }

    return Array.from(scenarioMap.entries()).map(([key, rounds]) => {
      const name = rounds[0].name;
      const passCount = rounds.filter(r => r.status === 'success').length;
      const failCount = rounds.length - passCount;
      const times = rounds.filter(r => r.executionTime).map(r => r.executionTime!);
      const costs = rounds.filter(r => r.totalCost !== undefined).map(r => r.totalCost!);
      const tokens = rounds.filter(r => r.totalTokens !== undefined).map(r => r.totalTokens!);
      const toolCalls = rounds.filter(r => r.toolCalls !== undefined).map(r => r.toolCalls!);
      const assertionScores = rounds.filter(r => r.assertionScore !== undefined).map(r => r.assertionScore!);

      return {
        id: key,
        name,
        roundCount: rounds.length,
        passCount,
        failCount,
        passRate: (passCount / rounds.length) * 100,
        avgTime: times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0,
        minTime: times.length > 0 ? Math.min(...times) : 0,
        maxTime: times.length > 0 ? Math.max(...times) : 0,
        avgCost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
        totalCost: costs.reduce((a, b) => a + b, 0),
        avgTokens: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
        avgToolCalls: toolCalls.length > 0 ? toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length : 0,
        avgAssertionScore: assertionScores.length > 0 ? assertionScores.reduce((a, b) => a + b, 0) / assertionScores.length : undefined,
        rounds,
      };
    });
  }, [roundHistory]);

  const aggregatedOverallStats = useMemo(() => {
    if (aggregatedResults.length === 0) return null;
    const nonHeaders = aggregatedResults.filter(r => {
      const orig = testResults.find(tr => tr.id === r.id);
      return !orig?.isSequenceHeader;
    });
    const totalTests = nonHeaders.reduce((sum, r) => sum + r.roundCount, 0);
    const totalPassed = nonHeaders.reduce((sum, r) => sum + r.passCount, 0);
    const totalFailed = nonHeaders.reduce((sum, r) => sum + r.failCount, 0);
    const totalCost = nonHeaders.reduce((sum, r) => sum + r.totalCost, 0);

    const allResults = roundHistory.flat().filter(r => !r.isSequenceHeader);
    const totalTokens = allResults.reduce((sum, r) => sum + (r.totalTokens || 0), 0);
    const promptTokens = allResults.reduce((sum, r) => sum + (r.promptTokens || 0), 0);
    const completionTokens = allResults.reduce((sum, r) => sum + (r.completionTokens || 0), 0);
    const allToolDetails = allResults.flatMap(r => r.toolCallDetails || []);
    const toolStats = computeToolStats(allToolDetails);

    return {
      totalTests,
      totalPassed,
      totalFailed,
      passRate: totalTests > 0 ? (totalPassed / totalTests) * 100 : 0,
      totalCost,
      totalTokens,
      promptTokens,
      completionTokens,
      toolStats,
      roundsCompleted: roundHistory.length,
    };
  }, [aggregatedResults, roundHistory]);

  const isRunning = runningTests.size > 0;

  // Export helpers
  const buildExportData = () => {
    const provider = configManager.getSelectedProvider();
    const model = currentModel;
    const dateStr = new Date().toISOString();

    const mapResultForExport = (r: RoundResult | TestResult) => ({
      id: r.id,
      name: r.name,
      status: r.status as 'success' | 'failed' | 'stopped',
      executionTime: r.executionTime,
      totalCost: r.totalCost,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      toolCalls: r.toolCalls,
      toolStats: r.toolCallDetails ? computeToolStats(r.toolCallDetails) : undefined,
      contextBreakdowns: r.contextBreakdowns,
      assertionScore: r.assertionScore,
      selfEvalCorrect: r.selfEvalCorrect,
      exitReason: r.exitReason,
      nudgeCount: r.nudgeCount,
      errors: r.errors,
      details: r.details,
    });

    const rounds = roundHistory.length > 0
      ? roundHistory.map((round, i) => ({ round: i + 1, results: round.filter(r => !r.isSequenceHeader).map(mapResultForExport) }))
      : [{
          round: 1,
          results: testResults
            .filter(r => (r.status === 'success' || r.status === 'failed' || r.status === 'stopped') && !r.isSequenceHeader)
            .map(mapResultForExport)
        }];

    const aggregated = aggregatedResults.length > 0
      ? aggregatedResults.map(r => ({
          id: r.id,
          name: r.name,
          roundCount: r.roundCount,
          passRate: r.passRate,
          avgTime: r.avgTime,
          minTime: r.minTime,
          maxTime: r.maxTime,
          avgCost: r.avgCost,
          totalCost: r.totalCost,
          avgTokens: r.avgTokens,
          avgToolCalls: r.avgToolCalls,
          avgAssertionScore: r.avgAssertionScore,
        }))
      : undefined;

    // Compute self-eval accuracy across all round data
    const selfEvalData = (() => {
      const allRoundResults = roundHistory.length > 0
        ? roundHistory.flat()
        : testResults.filter(r => r.status === 'success' || r.status === 'failed' || r.status === 'stopped');
      const withSelfEval = allRoundResults.filter(r => r.selfEvalCorrect !== undefined);
      const correct = withSelfEval.filter(r => r.selfEvalCorrect === true).length;
      return withSelfEval.length > 0 ? { selfEvalCorrect: correct, selfEvalTotal: withSelfEval.length } : {};
    })();

    const baseStats = aggregatedOverallStats || {
      totalTests: overallStats.total,
      totalPassed: overallStats.passed,
      totalFailed: overallStats.failed,
      passRate: overallStats.successRate,
      totalCost: overallStats.totalCost,
      totalTokens: overallStats.totalTokens,
      promptTokens: overallStats.promptTokens,
      completionTokens: overallStats.completionTokens,
      toolStats: overallStats.toolStats,
      roundsCompleted: roundHistory.length || (overallStats.total > 0 ? 1 : 0),
    };

    const summary = {
      ...baseStats,
      ...selfEvalData,
    };

    return {
      meta: {
        tool: 'OSW Studio Benchmark',
        date: dateStr,
        provider,
        model,
        judgeModel: judgeModel || undefined,
        evaluationMode: 'status',
        totalRounds: roundHistory.length || (overallStats.total > 0 ? 1 : 0),
      },
      rounds,
      aggregated,
      summary,
    };
  };

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getExportFilename = (ext: string) => {
    const modelSlug = currentModel.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const dateSlug = new Date().toISOString().split('T')[0];
    return `osws-benchmark-${modelSlug}-${dateSlug}.${ext}`;
  };

  const exportJSON = () => {
    const data = buildExportData();
    downloadFile(JSON.stringify(data, null, 2), getExportFilename('json'), 'application/json');
    toast.success('Benchmark results exported as JSON');
  };

  const exportMarkdown = () => {
    const data = buildExportData();
    const lines: string[] = [];
    lines.push('# OSW Studio Benchmark Report');
    lines.push('');
    lines.push(`**Date:** ${data.meta.date}`);
    lines.push(`**Provider:** ${data.meta.provider}`);
    lines.push(`**Model:** ${data.meta.model}`);
    if (data.meta.judgeModel) lines.push(`**Judge Model:** ${data.meta.judgeModel}`);
    lines.push(`**Evaluation Mode:** ${data.meta.evaluationMode}`);
    lines.push(`**Rounds:** ${data.meta.totalRounds}`);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total Tests | ${data.summary.totalTests} |`);
    lines.push(`| Passed | ${data.summary.totalPassed} |`);
    lines.push(`| Failed | ${data.summary.totalFailed} |`);
    lines.push(`| Pass Rate | ${data.summary.passRate.toFixed(1)}% |`);
    lines.push(`| Total Cost | $${data.summary.totalCost.toFixed(4)} |`);
    if (data.summary.totalTokens) {
      lines.push(`| Total Tokens | ${data.summary.totalTokens.toLocaleString()} (${data.summary.promptTokens?.toLocaleString() || 0} in / ${data.summary.completionTokens?.toLocaleString() || 0} out) |`);
    }
    if (data.summary.toolStats && data.summary.toolStats.total > 0) {
      const ts = data.summary.toolStats;
      let toolLine = `| Tool Calls | ${ts.total} (${ts.success} ok`;
      if (ts.failed > 0) toolLine += `, ${ts.failed} failed`;
      if (ts.invalid > 0) toolLine += `, ${ts.invalid} invalid: ${ts.invalidNames.join(', ')}`;
      toolLine += ') |';
      lines.push(toolLine);
    }
    lines.push(`| Rounds | ${data.summary.roundsCompleted} |`);
    if (data.summary.selfEvalTotal) {
      lines.push(`| Self-eval Accuracy | ${data.summary.selfEvalCorrect}/${data.summary.selfEvalTotal} (${((data.summary.selfEvalCorrect! / data.summary.selfEvalTotal) * 100).toFixed(1)}%) |`);
    }
    lines.push('');

    if (data.aggregated && data.aggregated.length > 0) {
      lines.push('## Per-Test Results (Multi-Round)');
      lines.push('');
      lines.push('| Test | Pass Rate | Avg Time | Avg Cost | Avg Tokens | Avg Tools |');
      lines.push('|------|-----------|----------|----------|------------|-----------|');
      for (const r of data.aggregated) {
        lines.push(`| ${r.name} | ${r.passRate.toFixed(0)}% | ${(r.avgTime / 1000).toFixed(1)}s | $${r.avgCost.toFixed(4)} | ${Math.round(r.avgTokens).toLocaleString()} | ${r.avgToolCalls.toFixed(1)} |`);
      }
    } else if (data.rounds.length > 0 && data.rounds[0].results.length > 0) {
      lines.push('## Results');
      lines.push('');
      lines.push('| Test | Status | Time | Cost | Tokens |');
      lines.push('|------|--------|------|------|--------|');
      for (const r of data.rounds[0].results) {
        const time = r.executionTime ? `${(r.executionTime / 1000).toFixed(1)}s` : '-';
        const cost = r.totalCost !== undefined ? `$${r.totalCost.toFixed(4)}` : '-';
        const tokens = r.totalTokens !== undefined ? r.totalTokens.toLocaleString() : '-';
        lines.push(`| ${r.name} | ${r.status} | ${time} | ${cost} | ${tokens} |`);
      }
    }

    // Shell command breakdown
    const allRoundResults = data.rounds.flatMap(r => r.results);
    const allShellCmds: Record<string, number> = {};
    for (const r of allRoundResults) {
      if (r.toolStats?.bashCommands) {
        for (const [cmd, count] of Object.entries(r.toolStats.bashCommands)) {
          allShellCmds[cmd] = (allShellCmds[cmd] || 0) + count;
        }
      }
    }
    if (Object.keys(allShellCmds).length > 0) {
      lines.push('');
      lines.push('## Shell Command Breakdown');
      lines.push('');
      lines.push('| Command | Count |');
      lines.push('|---------|-------|');
      const sorted = Object.entries(allShellCmds).sort((a, b) => b[1] - a[1]);
      for (const [cmd, count] of sorted) {
        lines.push(`| ${cmd} | ${count} |`);
      }
    }

    // Context breakdown (last snapshot per test = final state before last API call)
    const testsWithBreakdown = allRoundResults.filter(r => r.contextBreakdowns && r.contextBreakdowns.length > 0);
    if (testsWithBreakdown.length > 0) {
      lines.push('');
      lines.push('## Context Breakdown (chars at final API call)');
      lines.push('');
      lines.push('| Test | System | User | Asst Text | Tool Args | Tool Results | Reasoning | Total |');
      lines.push('|------|--------|------|-----------|-----------|-------------|-----------|-------|');
      for (const r of testsWithBreakdown) {
        const b = r.contextBreakdowns![r.contextBreakdowns!.length - 1];
        lines.push(`| ${r.name} | ${b.systemPromptChars.toLocaleString()} | ${b.userMessageChars.toLocaleString()} | ${b.assistantTextChars.toLocaleString()} | ${b.toolCallArgChars.toLocaleString()} | ${b.toolResultChars.toLocaleString()} | ${b.reasoningChars.toLocaleString()} | ${b.totalChars.toLocaleString()} |`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('*Generated by OSW Studio Benchmark*');

    downloadFile(lines.join('\n'), getExportFilename('md'), 'text/markdown');
    toast.success('Benchmark results exported as Markdown');
  };

  const getErrorCount = () => {
    const allResults: (RoundResult | TestResult)[] = roundHistory.length > 0
      ? roundHistory.flat()
      : testResults.filter(r => r.status === 'success' || r.status === 'failed' || r.status === 'stopped');
    const completed = allResults.filter(r => !r.isSequenceHeader);
    const failedTests = completed.filter(r => r.status === 'failed').length;
    const failedTools = completed.reduce((sum, r) =>
      sum + (r.toolCallDetails?.filter(t => t.status === 'failed').length || 0), 0);
    const invalidTools = completed.reduce((sum, r) =>
      sum + (r.toolCallDetails?.filter(t => !KNOWN_TOOLS.has(t.name)).length || 0), 0);
    const failedAssertions = completed.reduce((sum, r) =>
      sum + (r.assertionResults?.filter(a => !a.passed).length || 0), 0);
    return { failedTests, failedTools, invalidTools, failedAssertions, total: failedTests + failedTools + invalidTools + failedAssertions };
  };

  const exportErrors = () => {
    const allResults: (RoundResult | TestResult)[] = roundHistory.length > 0
      ? roundHistory.flat()
      : testResults.filter(r => r.status === 'success' || r.status === 'failed' || r.status === 'stopped');

    const completed = allResults.filter(r => !r.isSequenceHeader);
    const failedTests = completed.filter(r => r.status === 'failed');
    const testsWithFailedTools = completed.filter(r =>
      r.toolCallDetails?.some(t => t.status === 'failed' || !KNOWN_TOOLS.has(t.name)));
    const testsWithFailedAssertions = completed.filter(r =>
      r.assertionResults?.some(a => !a.passed));

    // Collect all tests that have any kind of error
    const errorTestIds = new Set<string>();
    for (const r of [...failedTests, ...testsWithFailedTools, ...testsWithFailedAssertions]) {
      errorTestIds.add(r.id);
    }
    const errorTests = completed.filter(r => errorTestIds.has(r.id));

    if (errorTests.length === 0) {
      toast.info('No errors to export');
      return;
    }

    const totalFailedTools = completed.reduce((sum, r) =>
      sum + (r.toolCallDetails?.filter(t => t.status === 'failed').length || 0), 0);
    const totalInvalidTools = completed.reduce((sum, r) =>
      sum + (r.toolCallDetails?.filter(t => !KNOWN_TOOLS.has(t.name)).length || 0), 0);
    const totalFailedAssertions = completed.reduce((sum, r) =>
      sum + (r.assertionResults?.filter(a => !a.passed).length || 0), 0);

    const lines: string[] = [];
    lines.push('# Benchmark Error Report');
    lines.push('');
    lines.push(`**Date:** ${new Date().toISOString()}`);
    lines.push(`**Model:** ${currentModel}`);
    lines.push('');
    lines.push('| Category | Count |');
    lines.push('|----------|-------|');
    lines.push(`| Failed tests | ${failedTests.length} / ${completed.length} |`);
    lines.push(`| Failed tool calls | ${totalFailedTools} |`);
    if (totalInvalidTools > 0) lines.push(`| Invalid tool calls | ${totalInvalidTools} |`);
    if (totalFailedAssertions > 0) lines.push(`| Failed assertions | ${totalFailedAssertions} |`);
    lines.push('');

    for (const r of errorTests) {
      const isFailed = r.status === 'failed';
      const failedToolsInTest = r.toolCallDetails?.filter(t => t.status === 'failed') || [];
      const invalidToolsInTest = r.toolCallDetails?.filter(t => !KNOWN_TOOLS.has(t.name)) || [];
      const failedAssertionsInTest = r.assertionResults?.filter(a => !a.passed) || [];

      lines.push('---');
      lines.push('');
      lines.push(`## ${isFailed ? '[FAILED] ' : ''}${r.name}`);
      lines.push('');

      const time = r.executionTime ? `${(r.executionTime / 1000).toFixed(1)}s` : '-';
      const cost = r.totalCost !== undefined ? formatCost(r.totalCost) : '-';
      const tokens = r.totalTokens !== undefined ? r.totalTokens.toLocaleString() : '-';
      const toolCount = r.toolCallDetails?.length || r.toolCalls || 0;
      lines.push(`Time: ${time} | Cost: ${cost} | Tokens: ${tokens} | Tools: ${toolCount} (${failedToolsInTest.length} failed)`);
      if (r.exitReason) lines.push(`Exit: ${r.exitReason}`);
      lines.push('');

      // Assertions (show all for context, mark pass/fail)
      if (r.assertionResults && r.assertionResults.length > 0) {
        lines.push('### Assertions');
        lines.push('');
        for (const ar of r.assertionResults) {
          const icon = ar.passed ? 'PASS' : 'FAIL';
          lines.push(`- **${icon}** ${ar.assertion.description}${ar.actual ? ` — ${ar.actual}` : ''}`);
        }
        lines.push('');
      }

      // Errors
      if (r.errors && r.errors.length > 0) {
        lines.push('### Errors');
        lines.push('');
        for (const err of r.errors) {
          lines.push(`- ${err}`);
        }
        lines.push('');
      }

      // Failed tool calls with args
      if (failedToolsInTest.length > 0) {
        lines.push(`### Failed Tool Calls (${failedToolsInTest.length})`);
        lines.push('');
        for (const t of failedToolsInTest) {
          lines.push(`- **${t.name}**${t.bashCommand ? ` \`${t.bashCommand}\`` : ''}`);
          if (t.args) {
            const preview = t.args.length > 300 ? t.args.substring(0, 300) + '...' : t.args;
            lines.push(`  \`\`\`\n  ${preview}\n  \`\`\``);
          }
        }
        lines.push('');
      }

      // Invalid tool names
      if (invalidToolsInTest.length > 0) {
        lines.push(`### Invalid Tool Calls (${invalidToolsInTest.length})`);
        lines.push('');
        for (const t of invalidToolsInTest) {
          lines.push(`- **${t.name}** — ${t.args || '(no args)'}`);
        }
        lines.push('');
      }

      // Generation output (the full trace)
      const genOutput = 'generationOutput' in r ? (r as TestResult).generationOutput : undefined;
      if (genOutput) {
        lines.push('### Generation Output');
        lines.push('');
        lines.push('```');
        lines.push(genOutput);
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('*Generated by OSW Studio Benchmark*');

    const parts: string[] = [];
    if (failedTests.length > 0) parts.push(`${failedTests.length} failed test(s)`);
    if (totalFailedTools > 0) parts.push(`${totalFailedTools} failed tool call(s)`);
    if (totalInvalidTools > 0) parts.push(`${totalInvalidTools} invalid tool(s)`);

    downloadFile(lines.join('\n'), getExportFilename('errors.md'), 'text/markdown');
    toast.success(`Exported ${parts.join(', ')} across ${errorTests.length} test(s)`);
  };

  const headerActions: HeaderAction[] = [
    {
      id: 'back',
      label: 'Back to Projects',
      icon: ArrowLeft,
      onClick: () => router.push('/'),
      variant: 'outline'
    }
  ];

  // Tooltip copy. The page is developer tooling and stays English, like the rest of its text.
  const waitForRun = 'Wait for the current run to finish';
  const runPlan = `${totalRounds} round${totalRounds > 1 ? 's' : ''}, ${concurrency} at a time`;

  return (
    <div className="h-screen flex flex-col">
      <AppHeader
        leftText={<>OSWS Benchmark <span className="text-xs font-normal text-muted-foreground ml-1">v260527</span></>}
        onLogoClick={() => router.push('/')}
        actions={headerActions}
      />

      <div className="flex-1 overflow-auto bg-background p-6">
        <div className="max-w-6xl mx-auto">

        {/* Benchmark Info */}
        <div className="border rounded-lg mb-6 overflow-hidden">
          <div className="px-4 py-3 text-sm">
            Evaluates how well a model performs with OSW Studio&apos;s agentic tool system.
            Select a provider and model, then run individual tracks or all tests.
            Sequences chain multiple prompts in one agent session to test multi-step workflows.
            Results include hard assertions (tool usage patterns, file state) and an optional judge model assessment.
          </div>
          {showBenchmarkInfo && (
            <div className="px-4 pb-4 text-sm border-t pt-3 space-y-3">
              <div>
                <h4 className="font-medium text-foreground mb-1">How it works</h4>
                <p>
                  Each test creates a virtual file system project, initializes an AI orchestrator with the selected model,
                  and sends one or more prompts. The orchestrator has access to a <code className="text-xs bg-muted px-1 py-0.5 rounded">bash</code> tool
                  for file operations (cat, sed, grep, mkdir, etc.) and a <code className="text-xs bg-muted px-1 py-0.5 rounded">status</code> command
                  for signaling task completion. After execution, assertions verify that the model used the right tools and produced correct output.
                </p>
              </div>
              <div>
                <h4 className="font-medium text-foreground mb-1">Standalone vs Sequences</h4>
                <p>
                  <strong>Standalone tests</strong> run a single prompt on a fresh project &mdash; used for setup agent tests
                  where each scenario needs an isolated environment.
                  <strong> Sequences</strong> chain multiple prompts on the same project and orchestrator, testing multi-turn
                  capabilities (read &rarr; edit &rarr; verify) in a single agent session. This mirrors real usage and
                  reduces token overhead by sharing the system prompt across steps.
                </p>
              </div>
              <div>
                <h4 className="font-medium text-foreground mb-1">Assertions</h4>
                <p>
                  <strong>Hard assertions</strong> check tool call arguments (<code className="text-xs bg-muted px-1 py-0.5 rounded">tool_args_match</code>),
                  file existence (<code className="text-xs bg-muted px-1 py-0.5 rounded">file_exists</code> / <code className="text-xs bg-muted px-1 py-0.5 rounded">file_not_exists</code>),
                  file content (<code className="text-xs bg-muted px-1 py-0.5 rounded">file_content_match</code>),
                  model output (<code className="text-xs bg-muted px-1 py-0.5 rounded">output_matches</code>),
                  and composites (<code className="text-xs bg-muted px-1 py-0.5 rounded">any_of</code> — passes if any sub-assertion matches).
                  The optional <strong>judge model</strong> provides a second-opinion quality assessment on top of hard assertions.
                </p>
              </div>
              <div>
                <h4 className="font-medium text-foreground mb-1">Cost</h4>
                <p>
                  Running the full benchmark uses significant API tokens. A full &ldquo;All&rdquo; run typically costs $0.30&ndash;$1.00+
                  depending on the model. Sequences are more token-efficient than running equivalent standalone tests since they
                  share a single system prompt across multiple steps. Run individual tracks to keep costs down while iterating.
                </p>
              </div>
            </div>
          )}
          <Tip label={showBenchmarkInfo ? undefined : 'How the benchmark works, what it checks and what it costs'}>
            <button
              onClick={() => setShowBenchmarkInfo(!showBenchmarkInfo)}
              className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex items-center justify-center gap-1 border-t"
            >
              {showBenchmarkInfo ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showBenchmarkInfo ? 'Less' : 'More'}
            </button>
          </Tip>
        </div>

        {/* Round progress indicator */}
        {totalRounds > 1 && activeTrack && (
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-2 mb-4 text-sm text-blue-800 dark:text-blue-200 flex items-center gap-2">
            <span>Round {currentRound + 1} of {totalRounds} ({roundHistory.length} completed)</span>
          </div>
        )}

        {/* Stats Overview */}
        {(() => {
          const expectedTotal = testResults.filter(r => !r.isSequenceHeader).length;
          const stats = benchmarkComplete && aggregatedOverallStats && roundHistory.length > 1
            ? {
                total: aggregatedOverallStats.totalTests,
                passed: aggregatedOverallStats.totalPassed,
                failed: aggregatedOverallStats.totalFailed,
                successRate: aggregatedOverallStats.passRate,
                totalCost: aggregatedOverallStats.totalCost,
                promptTokens: aggregatedOverallStats.promptTokens,
                completionTokens: aggregatedOverallStats.completionTokens,
                totalTokens: aggregatedOverallStats.totalTokens,
                toolStats: aggregatedOverallStats.toolStats,
                rounds: aggregatedOverallStats.roundsCompleted,
                expectedTotal: undefined as number | undefined,
              }
            : {
                total: overallStats.total,
                passed: overallStats.passed,
                failed: overallStats.failed,
                successRate: overallStats.successRate,
                totalCost: overallStats.totalCost,
                promptTokens: overallStats.promptTokens,
                completionTokens: overallStats.completionTokens,
                totalTokens: overallStats.totalTokens,
                toolStats: overallStats.toolStats,
                rounds: undefined as number | undefined,
                expectedTotal: isRunning ? expectedTotal : undefined,
              };

          return (
            <>
              <div className={`grid grid-cols-2 ${stats.rounds ? 'md:grid-cols-4 lg:grid-cols-7' : 'md:grid-cols-3 lg:grid-cols-6'} gap-4 mb-4`}>
                {stats.rounds !== undefined && (
                  <div className="bg-card border rounded-lg p-4">
                    <div className="text-sm font-medium text-muted-foreground mb-1">Rounds</div>
                    <div className="text-2xl font-bold">{stats.rounds}</div>
                  </div>
                )}
                <div className="bg-card border rounded-lg p-4">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Total Tests</div>
                  <div className="text-2xl font-bold">
                    {stats.expectedTotal ? <>{stats.total} <span className="text-base font-normal text-muted-foreground">/ {stats.expectedTotal}</span></> : stats.total}
                  </div>
                </div>
                <div className="bg-card border rounded-lg p-4">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Passed</div>
                  <div className="text-2xl font-bold text-green-600">{stats.passed}</div>
                </div>
                <div className="bg-card border rounded-lg p-4">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Failed</div>
                  <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
                </div>
                <div className="bg-card border rounded-lg p-4">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Pass Rate</div>
                  <div className="text-2xl font-bold">{stats.successRate.toFixed(1)}%</div>
                </div>
                <div className="bg-card border rounded-lg p-4">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Cost</div>
                  <div className="text-2xl font-bold">
                    {formatCost(stats.totalCost)}
                  </div>
                </div>
                <div className="bg-card border rounded-lg p-4">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Tokens</div>
                  <div className="text-2xl font-bold">{stats.totalTokens.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {stats.promptTokens.toLocaleString()} in &rarr; {stats.completionTokens.toLocaleString()} out
                  </div>
                </div>
              </div>

              {/* Tool usage summary */}
              {stats.toolStats.total > 0 && (() => {
                const ts = stats.toolStats;
                const knownEntries = Object.entries(ts.breakdown).filter(([name]) => KNOWN_TOOLS.has(name));
                return (
                  <div className="bg-card border rounded-lg overflow-hidden mb-6">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 border-b bg-muted/30">
                      <span className="text-sm font-medium">Tool Calls: {ts.total}</span>
                      <span className="text-sm text-green-600">{ts.success} successful</span>
                      {ts.failed > 0 && <span className="text-sm text-red-600">{ts.failed} failed</span>}
                      {ts.invalid > 0 && <span className="text-sm text-orange-500">{ts.invalid} invalid</span>}
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="text-left px-4 py-1.5 font-medium">Tool</th>
                          <th className="text-right px-4 py-1.5 font-medium">Total</th>
                          <th className="text-right px-4 py-1.5 font-medium text-green-600">OK</th>
                          <th className="text-right px-4 py-1.5 font-medium text-red-500">Failed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {knownEntries.map(([name, counts]) => (
                          <tr key={name} className="border-t border-border/50">
                            <td className="px-4 py-1.5 font-medium">{name}</td>
                            <td className="px-4 py-1.5 text-right text-muted-foreground">{counts.total}</td>
                            <td className="px-4 py-1.5 text-right text-green-600">{counts.success}</td>
                            <td className={`px-4 py-1.5 text-right ${counts.failed > 0 ? 'text-red-500 font-medium' : 'text-red-500/40'}`}>
                              {counts.failed}
                            </td>
                          </tr>
                        ))}
                        {ts.invalid > 0 && (
                          <tr className="border-t border-border/50">
                            <td className="px-4 py-1.5 font-medium text-orange-500">invalid</td>
                            <td className="px-4 py-1.5 text-right text-orange-500">{ts.invalid}</td>
                            <td className="px-4 py-1.5 text-right text-green-600/40">0</td>
                            <td className="px-4 py-1.5 text-right text-red-500 font-medium">{ts.invalid}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </>
          );
        })()}

        {/* Controls */}
        <div className="flex flex-wrap gap-3 mb-6">
          <Popover open={showModelSettings} onOpenChange={setShowModelSettings}>
            <PopoverTrigger asChild>
              <Tip label={showModelSettings ? undefined : 'Choose the model to test, and a judge model'}>
                <Button variant="outline">
                  <span>{getModelDisplayName(currentModel)}</span>
                  {showModelSettings ? (
                    <ChevronDown className="h-4 w-4 ml-2" />
                  ) : (
                    <ChevronUp className="h-4 w-4 ml-2" />
                  )}
                </Button>
              </Tip>
            </PopoverTrigger>
            <PopoverContent className="w-96" align="start" side="bottom" sideOffset={4} avoidCollisions={false}>
              <ModelSettingsPanel
                onClose={() => setShowModelSettings(false)}
                onModelChange={(modelId) => setCurrentModel(modelId)}
                showJudgeModel
                onJudgeModelChange={(modelId) => setJudgeModel(modelId)}
              />
            </PopoverContent>
          </Popover>

          <div className="inline-flex items-center rounded-md border border-input">
            <Tip label={isRunning ? waitForRun : totalRounds <= 1 ? 'One round is the least' : 'Fewer rounds'}>
              <button
                onClick={() => setTotalRounds(r => Math.max(1, r - 1))}
                disabled={isRunning || totalRounds <= 1}
                aria-label="Fewer rounds"
                className="h-9 w-8 inline-flex items-center justify-center rounded-l-md hover:bg-accent disabled:opacity-50 disabled:pointer-events-none"
              >
                <Minus className="h-3 w-3" />
              </button>
            </Tip>
            <span className="h-9 px-2 inline-flex items-center justify-center text-sm font-medium min-w-[5rem] border-x border-input select-none">
              {totalRounds} Round{totalRounds > 1 ? 's' : ''}
            </span>
            <Tip label={isRunning ? waitForRun : totalRounds >= 10 ? 'Ten rounds is the most' : 'More rounds; each one repeats the whole run'}>
              <button
                onClick={() => setTotalRounds(r => Math.min(10, r + 1))}
                disabled={isRunning || totalRounds >= 10}
                aria-label="More rounds"
                className="h-9 w-8 inline-flex items-center justify-center rounded-r-md hover:bg-accent disabled:opacity-50 disabled:pointer-events-none"
              >
                <Plus className="h-3 w-3" />
              </button>
            </Tip>
          </div>

          <div className="inline-flex items-center rounded-md border border-input">
            <Tip label={isRunning ? waitForRun : concurrency <= 1 ? 'One test at a time is the least' : 'Run fewer tests at once'}>
              <button
                onClick={() => setConcurrency(c => Math.max(1, c - 1))}
                disabled={isRunning || concurrency <= 1}
                aria-label="Run fewer tests at once"
                className="h-9 w-8 inline-flex items-center justify-center rounded-l-md hover:bg-accent disabled:opacity-50 disabled:pointer-events-none"
              >
                <Minus className="h-3 w-3" />
              </button>
            </Tip>
            <span className="h-9 px-2 inline-flex items-center justify-center text-sm font-medium min-w-[5rem] border-x border-input select-none">
              {concurrency}x Parallel
            </span>
            <Tip label={isRunning ? waitForRun : concurrency >= 8 ? 'Eight at a time is the most' : 'Run more tests at once'}>
              <button
                onClick={() => setConcurrency(c => Math.min(8, c + 1))}
                disabled={isRunning || concurrency >= 8}
                aria-label="Run more tests at once"
                className="h-9 w-8 inline-flex items-center justify-center rounded-r-md hover:bg-accent disabled:opacity-50 disabled:pointer-events-none"
              >
                <Plus className="h-3 w-3" />
              </button>
            </Tip>
          </div>

          {testTracks.map(track => (
            <Tip key={track.id} label={isRunning ? waitForRun : `Run its ${track.scenarioIds.length} tests: ${runPlan}`}>
              <Button
                onClick={() => runTrack(track.id)}
                disabled={isRunning}
                variant={activeTrack === track.id ? 'default' : 'outline'}
              >
                <Play className="h-4 w-4 mr-2" />
                {track.name} ({track.scenarioIds.length})
              </Button>
            </Tip>
          ))}
          <Tip label={isRunning ? waitForRun : `Run the ${testSequences.length} sequences: ${runPlan}`}>
            <Button
              onClick={() => runTrack('sequences')}
              disabled={isRunning}
              variant={activeTrack === 'sequences' ? 'default' : 'outline'}
            >
              <Play className="h-4 w-4 mr-2" />
              Sequences ({testSequences.length})
            </Button>
          </Tip>
          <Tip label={isRunning ? waitForRun : `Run every test and sequence: ${runPlan}`}>
            <Button
              onClick={() => runTrack('all')}
              disabled={isRunning}
              variant={activeTrack === 'all' ? 'default' : 'outline'}
            >
              <Play className="h-4 w-4 mr-2" />
              All ({allScenarioIds.length + testSequences.length})
            </Button>
          </Tip>
          {isRunning ? (
            <Tip label="Stop every running test">
              <Button variant="destructive" onClick={stopBenchmark}>
                <Square className="h-4 w-4 mr-2" />
                Stop
              </Button>
            </Tip>
          ) : (
            <Tip label="Clear every result and set all tests back to pending">
              <Button variant="outline" onClick={resetTests}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            </Tip>
          )}

          {(overallStats.total > 0 || roundHistory.length > 0) && (
            <>
              <div className="w-px h-6 bg-border self-center" />
              <Tip label={isRunning ? waitForRun : 'Download the results as JSON'}>
                <Button variant="outline" onClick={exportJSON} disabled={isRunning}>
                  <Download className="h-4 w-4 mr-2" />
                  JSON
                </Button>
              </Tip>
              <Tip label={isRunning ? waitForRun : 'Download the results as a Markdown report'}>
                <Button variant="outline" onClick={exportMarkdown} disabled={isRunning}>
                  <Download className="h-4 w-4 mr-2" />
                  Markdown
                </Button>
              </Tip>
              {(() => {
                const ec = getErrorCount();
                return ec.total > 0 ? (
                  <Tip label={isRunning ? waitForRun : 'Download the failures as a Markdown report'}>
                    <Button variant="outline" onClick={exportErrors} disabled={isRunning}>
                      <Download className="h-4 w-4 mr-2" />
                      Errors ({ec.total})
                    </Button>
                  </Tip>
                ) : null;
              })()}
            </>
          )}
        </div>

        {/* Test Results — grouped by track + sequences */}
        <div className="space-y-8">
          {/* Sequences */}
          {testResults.some(r => r.isSequenceHeader || r.sequenceId) && (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="h-px flex-1 bg-border" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Sequences
                </h2>
                <span className="text-xs text-muted-foreground">Multi-step chained tests</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="grid gap-4">
                {testSequences.map(seq => {
                  const headerResult = testResults.find(r => r.id === seq.id && r.isSequenceHeader);
                  const stepResults = testResults.filter(r => r.sequenceId === seq.id);
                  if (!headerResult) return null;

                  return (
                    <div key={seq.id} className="bg-card border rounded-lg overflow-hidden">
                      {/* Sequence header */}
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-1">
                          <div>
                            <div className="flex items-center gap-2 font-medium">
                              {getStatusIcon(headerResult.status)}
                              {seq.name}
                              <span className="text-sm font-normal text-muted-foreground">
                                ({seq.steps.length} steps)
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {headerResult.executionTime && (
                              <span className="text-sm text-muted-foreground">
                                {(headerResult.executionTime / 1000).toFixed(1)}s
                              </span>
                            )}
                            {headerResult.status === 'running' && runningTests.has(seq.id) ? (
                              <Tip label={`Stop ${seq.name}`}>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => stopTest(seq.id)}
                                >
                                  <Square className="h-3 w-3 mr-1" />
                                  Stop
                                </Button>
                              </Tip>
                            ) : (
                              <Tip label={isRunning ? waitForRun : `Run ${seq.name}: ${seq.steps.length} steps in one session`}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => runSequence(seq.id)}
                                  disabled={isRunning}
                                >
                                  <Play className="h-3 w-3 mr-1" />
                                  Run
                                </Button>
                              </Tip>
                            )}
                            <Tip label={expandedTests.has(seq.id) ? 'Hide the steps' : 'Show the steps'} align="end">
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={expandedTests.has(seq.id) ? 'Hide the steps' : 'Show the steps'}
                                onClick={() => {
                                  setExpandedTests(prev => {
                                    const newSet = new Set(prev);
                                    if (newSet.has(seq.id)) {
                                      newSet.delete(seq.id);
                                    } else {
                                      newSet.add(seq.id);
                                    }
                                    return newSet;
                                  });
                                }}
                              >
                                {expandedTests.has(seq.id) ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                )}
                              </Button>
                            </Tip>
                          </div>
                        </div>

                        {/* Aggregate stats for completed sequence */}
                        {(headerResult.status === 'success' || headerResult.status === 'failed') && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground mt-1">
                            {headerResult.totalCost !== undefined && (
                              <span><strong className="text-foreground">Cost:</strong> {formatCost(headerResult.totalCost)}</span>
                            )}
                            {headerResult.totalTokens !== undefined && (
                              <span><strong className="text-foreground">Tokens:</strong> {headerResult.totalTokens.toLocaleString()}</span>
                            )}
                            {headerResult.toolCalls !== undefined && (
                              <span><strong className="text-foreground">Tools:</strong> {headerResult.toolCalls}</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Step rows */}
                      {expandedTests.has(seq.id) && stepResults.length > 0 && (
                        <div className="border-t">
                          {stepResults.map(stepResult => {
                            const stepDef = seq.steps.find(s => s.id === stepResult.id);
                            return (
                              <div key={stepResult.id} className="border-b last:border-b-0">
                                <div className="px-4 py-3 bg-muted/20">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-sm">
                                      {getStatusIcon(stepResult.status)}
                                      <span className="font-medium">{stepResult.name}</span>
                                      {stepDef && (
                                        <span className="text-xs text-muted-foreground truncate max-w-md">
                                          — {stepDef.prompt.substring(0, 80)}{stepDef.prompt.length > 80 ? '...' : ''}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {stepResult.executionTime && (
                                        <span className="text-xs text-muted-foreground">
                                          {(stepResult.executionTime / 1000).toFixed(1)}s
                                        </span>
                                      )}
                                      {stepResult.totalTokens !== undefined && (
                                        <span className="text-xs text-muted-foreground">
                                          {stepResult.totalTokens.toLocaleString()} tok
                                        </span>
                                      )}
                                      {(stepResult.generationOutput || expandedTests.has(stepResult.id)) && (
                                        <Tip label={expandedTests.has(stepResult.id) ? 'Hide the output' : 'Show the output'} align="end">
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 w-6 p-0"
                                            aria-label={expandedTests.has(stepResult.id) ? 'Hide the output' : 'Show the output'}
                                            onClick={() => {
                                              setExpandedTests(prev => {
                                                const newSet = new Set(prev);
                                                if (newSet.has(stepResult.id)) {
                                                  newSet.delete(stepResult.id);
                                                } else {
                                                  newSet.add(stepResult.id);
                                                }
                                                return newSet;
                                              });
                                            }}
                                          >
                                            {expandedTests.has(stepResult.id) ? (
                                              <ChevronUp className="h-3 w-3" />
                                            ) : (
                                              <ChevronDown className="h-3 w-3" />
                                            )}
                                          </Button>
                                        </Tip>
                                      )}
                                    </div>
                                  </div>

                                  {/* Step assertions */}
                                  {stepResult.assertionResults && stepResult.assertionResults.length > 0 && (
                                    <div className="mt-1 space-y-0.5 font-mono text-xs">
                                      {stepResult.assertionResults.map((ar, i) => (
                                        <div key={i} className="flex items-start gap-1.5">
                                          <span className={ar.passed ? 'text-green-500' : 'text-red-500'}>
                                            {ar.passed ? '✓' : '✗'}
                                          </span>
                                          <span className={ar.passed ? 'text-muted-foreground' : 'text-foreground'}>
                                            {ar.assertion.description}
                                          </span>
                                          {!ar.passed && ar.actual && (
                                            <span className="text-red-400 truncate max-w-sm">— {ar.actual}</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {stepResult.errors && stepResult.errors.length > 0 && (
                                    <div className="mt-1 text-xs text-red-600">
                                      {stepResult.errors.join(', ')}
                                    </div>
                                  )}
                                </div>

                                {/* Step generation output */}
                                {expandedTests.has(stepResult.id) && stepResult.generationOutput && (
                                  <div className="px-4 py-2 bg-muted/10">
                                    <div
                                      className="bg-muted/50 rounded-md p-3 max-h-48 overflow-y-auto"
                                      ref={(el) => {
                                        if (el) generationOutputRefs.current.set(stepResult.id, el);
                                      }}
                                    >
                                      <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80">
                                        {stepResult.generationOutput}
                                      </pre>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {testTracks.map(track => {
            const report = trackReports[track.id];
            return (
              <div key={track.id}>
                {/* Track header */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-px flex-1 bg-border" />
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    {track.name}
                  </h2>
                  <span className="text-xs text-muted-foreground">{track.description}</span>
                  <div className="h-px flex-1 bg-border" />
                </div>

                {/* Scenarios in this track */}
                <div className="grid gap-4">
                  {track.scenarioIds.map(scenarioId => {
                    const matchingResults = testResults.filter(r => r.id === scenarioId);
                    const scenario = testScenarios.find(s => s.id === scenarioId);
                    if (matchingResults.length === 0 || !scenario) return null;

                    return matchingResults.map(result => (
                      <div key={result.id} className="bg-card border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <div className="flex items-center gap-2 font-medium">
                              {getStatusIcon(result.status)}
                              {result.name}
                              <span className="text-sm font-normal text-muted-foreground">
                                ({scenario.category})
                              </span>
                            </div>
                            <div className="text-sm text-muted-foreground mt-1">
                              {scenario.prompt.substring(0, 100)}...
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {result.executionTime && (
                              <span className="text-sm text-muted-foreground">
                                {(result.executionTime / 1000).toFixed(1)}s
                              </span>
                            )}
                            {result.status === 'running' && runningTests.has(result.id) ? (
                              <Tip label={`Stop ${result.name}`}>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => stopTest(result.id)}
                                >
                                  <Square className="h-3 w-3 mr-1" />
                                  Stop
                                </Button>
                              </Tip>
                            ) : (
                              <Tip label={isRunning ? waitForRun : `Run ${result.name} on its own`}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => runSingleTest(result.id)}
                                  disabled={isRunning}
                                >
                                  <Play className="h-3 w-3 mr-1" />
                                  Test
                                </Button>
                              </Tip>
                            )}
                            {(result.status === 'running' || result.generationOutput || expandedTests.has(result.id)) && (
                              <Tip label={expandedTests.has(result.id) ? 'Hide the output' : 'Show the output'} align="end">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={expandedTests.has(result.id) ? 'Hide the output' : 'Show the output'}
                                  onClick={() => {
                                    setExpandedTests(prev => {
                                      const newSet = new Set(prev);
                                      if (newSet.has(result.id)) {
                                        newSet.delete(result.id);
                                      } else {
                                        newSet.add(result.id);
                                      }
                                      return newSet;
                                    });
                                  }}
                                >
                                  {expandedTests.has(result.id) ? (
                                    <ChevronUp className="h-3 w-3" />
                                  ) : (
                                    <ChevronDown className="h-3 w-3" />
                                  )}
                                </Button>
                              </Tip>
                            )}
                          </div>
                        </div>
                        {/* Generation Output Display */}
                        {(result.status === 'running' || expandedTests.has(result.id)) && (result.generationOutput) && (
                          <div className="mt-3 pt-3 border-t">
                            <div className="flex items-center gap-2 mb-2">
                              <div className="text-sm font-medium text-muted-foreground">Generation Output</div>
                              {result.status === 'running' && (
                                <div className="flex items-center gap-1">
                                  <RefreshCw className="h-3 w-3 animate-spin" />
                                  <span className="text-xs text-muted-foreground">Generating...</span>
                                </div>
                              )}
                            </div>
                            <div
                              className="bg-muted/50 rounded-md p-3 max-h-64 overflow-y-auto"
                              ref={(el) => {
                                if (el) {
                                  generationOutputRefs.current.set(result.id, el);
                                }
                              }}
                            >
                              <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80">
                                {result.generationOutput || ''}
                              </pre>
                            </div>
                          </div>
                        )}

                        {(result.status === 'success' || result.status === 'failed' || result.status === 'stopped') && (
                          <div className="mt-3 pt-3 border-t space-y-2 text-sm">
                            {result.details && (
                              <div>
                                <strong>Result:</strong> {result.details}
                              </div>
                            )}
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                              {result.totalCost !== undefined && (
                                <span>
                                  <strong className="text-foreground">Cost:</strong>{' '}
                                  {formatCost(result.totalCost)}
                                </span>
                              )}
                              {result.totalTokens !== undefined && (
                                <span>
                                  <strong className="text-foreground">Tokens:</strong>{' '}
                                  {(result.promptTokens || 0).toLocaleString()} &rarr; {(result.completionTokens || 0).toLocaleString()} ({result.totalTokens.toLocaleString()} total)
                                </span>
                              )}
                              {result.toolCalls !== undefined && (
                                <span>
                                  <strong className="text-foreground">Tool Calls:</strong> {result.toolCalls}
                                </span>
                              )}
                            </div>
                            {result.toolCallDetails && result.toolCallDetails.length > 0 && (() => {
                              const ts = computeToolStats(result.toolCallDetails);
                              return (
                                <div className="mt-1">
                                  <div className="text-xs text-muted-foreground mb-1">
                                    <span className="font-medium text-foreground">{ts.total} tool call{ts.total !== 1 ? 's' : ''}</span>
                                    {' — '}
                                    <span className="text-green-600">{ts.success} ok</span>
                                    {ts.failed > 0 && <>, <span className="text-red-500">{ts.failed} failed</span></>}
                                    {ts.invalid > 0 && <>, <span className="text-orange-500">{ts.invalid} invalid</span></>}
                                  </div>
                                  <div className="space-y-0.5 font-mono text-xs">
                                    {result.toolCallDetails.map((tc, i) => {
                                      const isInvalid = !KNOWN_TOOLS.has(tc.name);
                                      return (
                                        <div key={i} className="flex items-center gap-1.5">
                                          <span className={tc.status === 'success' && !isInvalid ? 'text-green-500' : isInvalid ? 'text-orange-500' : 'text-red-500'}>
                                            {tc.status === 'success' && !isInvalid ? '\u2713' : '\u2717'}
                                          </span>
                                          <span className={`font-semibold ${isInvalid ? 'text-orange-500' : ''}`}>{tc.name}</span>
                                          {isInvalid && (
                                            <span className="text-orange-500 text-[10px] border border-orange-400/50 rounded px-1">invalid</span>
                                          )}
                                          {tc.args && (
                                            <span className="text-muted-foreground truncate max-w-md">
                                              &mdash; {tc.args}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}
                            {result.assertionResults && result.assertionResults.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-dashed">
                                <div className="text-xs font-medium text-muted-foreground mb-1">
                                  Assertions: {result.assertionResults.filter(a => a.passed).length}/{result.assertionResults.length} passed
                                  {result.assertionScore !== undefined && ` (${result.assertionScore.toFixed(0)}%)`}
                                </div>
                                <div className="space-y-0.5 font-mono text-xs">
                                  {result.assertionResults.map((ar, i) => (
                                    <div key={i} className="flex items-start gap-1.5">
                                      <span className={ar.passed ? 'text-green-500' : 'text-red-500'}>
                                        {ar.passed ? '\u2713' : '\u2717'}
                                      </span>
                                      <span className={ar.passed ? 'text-muted-foreground' : 'text-foreground'}>
                                        {ar.assertion.description}
                                      </span>
                                      {!ar.passed && ar.actual && (
                                        <span className="text-red-400 truncate max-w-sm">
                                          &mdash; {ar.actual}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {result.errors && result.errors.length > 0 && (
                              <div className="text-red-600">
                                <strong>Errors:</strong> {result.errors.join(', ')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ));
                  })}
                </div>

                {/* Track Report — shown when all tests in this track are done */}
                {report.allDone && (
                  <div className="mt-4 bg-muted/40 border rounded-lg p-4">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3">
                      <h3 className="text-sm font-semibold">{track.name} Track Report</h3>
                      <span className="text-xs text-muted-foreground">
                        Passed: {report.passed}/{report.total} ({report.successRate.toFixed(1)}%)
                        {report.totalAssertions > 0 && (
                          <>&nbsp;|&nbsp; Assertions: {report.passedAssertions}/{report.totalAssertions} ({report.assertionScore.toFixed(0)}%)</>
                        )}
                        {report.selfEvalTotal > 0 && (
                          <>&nbsp;|&nbsp; Self-eval accuracy: {report.selfEvalCorrect}/{report.selfEvalTotal}</>
                        )}
                        &nbsp;|&nbsp; Avg time: {(report.avgTime / 1000).toFixed(1)}s
                        &nbsp;|&nbsp; Cost: {formatCost(report.totalCost)}
                        &nbsp;|&nbsp; Tokens: {report.totalTokens.toLocaleString()}
                        &nbsp;|&nbsp; Tool calls: {report.totalToolCalls}
                        {' ('}
                        <span className="text-green-600">{report.toolStats.success} ok</span>
                        {report.toolStats.failed > 0 && <>, <span className="text-red-500">{report.toolStats.failed} fail</span></>}
                        {report.toolStats.invalid > 0 && <>, <span className="text-orange-500">{report.toolStats.invalid} invalid</span></>}
                        {')'}
                        {Object.keys(report.toolStats.breakdown).length > 0 && (
                          <> &mdash; {Object.entries(report.toolStats.breakdown)
                            .filter(([name]) => KNOWN_TOOLS.has(name))
                            .map(([name, counts], i) => (
                            <span key={name}>
                              {i > 0 ? ', ' : ''}
                              {name}: {counts.total}
                              {counts.failed > 0 && <span className="text-red-500"> ({counts.failed}&#x2717;)</span>}
                            </span>
                          ))}</>
                        )}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {report.results.map(r => {
                        const isPass = r.status === 'success';
                        return (
                          <div key={r.id} className="flex items-center gap-2 text-xs font-mono">
                            <span className={isPass ? 'text-green-500' : 'text-red-500'}>
                              {isPass ? '\u2713' : '\u2717'}
                            </span>
                            <span className="w-48 truncate">{r.id}</span>
                            <span className="w-16 text-right text-muted-foreground">
                              {r.executionTime ? `${(r.executionTime / 1000).toFixed(1)}s` : '—'}
                            </span>
                            <span className="w-20 text-right text-muted-foreground">
                              {r.totalCost !== undefined ? formatCost(r.totalCost) : ''}
                            </span>
                            <span className="w-20 text-right text-muted-foreground">
                              {r.totalTokens !== undefined ? `${r.totalTokens.toLocaleString()} tok` : ''}
                            </span>
                            <span className="w-32 text-muted-foreground">
                              {r.toolCallDetails && r.toolCallDetails.length > 0 ? (() => {
                                const ts = computeToolStats(r.toolCallDetails);
                                return (
                                  <>
                                    {ts.total} tools
                                    {' ('}
                                    <span className="text-green-600">{ts.success}</span>
                                    {ts.failed > 0 && <>/<span className="text-red-500">{ts.failed}</span></>}
                                    {ts.invalid > 0 && <>/<span className="text-orange-500">{ts.invalid}!</span></>}
                                    {')'}
                                  </>
                                );
                              })() : r.toolCalls !== undefined ? `${r.toolCalls} tools` : ''}
                            </span>
                            {r.assertionScore !== undefined && (
                              <span className={`w-16 text-right ${r.assertionScore === 100 ? 'text-green-500' : r.assertionScore > 0 ? 'text-yellow-500' : 'text-red-500'}`}>
                                {r.assertionScore.toFixed(0)}%
                              </span>
                            )}
                            {r.errors && r.errors.length > 0 && (
                              <span className="text-red-500 truncate">— {r.errors[0]}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Aggregated Results Table — multi-round only */}
        {benchmarkComplete && roundHistory.length > 1 && aggregatedResults.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-px flex-1 bg-border" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Aggregated Results ({roundHistory.length} Rounds)
              </h2>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="bg-card border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Test</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Pass Rate</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Avg Time</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Min/Max</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Avg Cost</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Avg Tokens</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Avg Tools</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Assert %</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregatedResults.map(r => (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <td className="px-4 py-2 font-medium">{r.name}</td>
                      <td className={`px-4 py-2 text-right font-semibold ${
                        r.passRate === 100 ? 'text-green-500' : r.passRate > 0 ? 'text-yellow-500' : 'text-red-500'
                      }`}>
                        {r.passRate.toFixed(0)}%
                        <span className="text-xs font-normal text-muted-foreground ml-1">
                          ({r.passCount}/{r.roundCount})
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {(r.avgTime / 1000).toFixed(1)}s
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground text-xs">
                        {(r.minTime / 1000).toFixed(1)}s / {(r.maxTime / 1000).toFixed(1)}s
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {formatCost(r.avgCost)}
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {Math.round(r.avgTokens).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {r.avgToolCalls.toFixed(1)}
                      </td>
                      <td className={`px-4 py-2 text-right ${
                        r.avgAssertionScore !== undefined
                          ? r.avgAssertionScore === 100 ? 'text-green-500' : r.avgAssertionScore > 0 ? 'text-yellow-500' : 'text-red-500'
                          : 'text-muted-foreground'
                      }`}>
                        {r.avgAssertionScore !== undefined ? `${r.avgAssertionScore.toFixed(0)}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
