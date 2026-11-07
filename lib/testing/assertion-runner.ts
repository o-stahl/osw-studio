import { TestAssertion, AssertionResult } from './types';
import type { ConversationNode } from '@/lib/llm/multi-agent-orchestrator';
import type { VirtualFileSystem } from '@/lib/vfs';

function truncate(str: string, max = 100): string {
  return str.length > max ? str.substring(0, max - 3) + '...' : str;
}

function getAssistantText(conversation: ConversationNode[]): string {
  const parts: string[] = [];
  for (const node of conversation) {
    for (const msg of node.messages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          parts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if ('text' in block) parts.push(block.text);
          }
        }
      }
    }
  }
  return parts.join('\n');
}

function getToolOutputText(conversation: ConversationNode[], toolName: string): string {
  // Map tool_call_id → tool function name
  const callIdToName = new Map<string, string>();
  for (const node of conversation) {
    for (const msg of node.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          callIdToName.set(tc.id, tc.function.name);
        }
      }
    }
  }

  // Collect tool result content for matching tool name
  const parts: string[] = [];
  for (const node of conversation) {
    for (const msg of node.messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        const name = callIdToName.get(msg.tool_call_id);
        if (name === toolName) {
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (content) parts.push(content);
        }
      }
    }
  }

  return parts.join('\n');
}

function getToolCalls(conversation: ConversationNode[]) {
  const calls: Array<{ name: string; args: string }> = [];
  for (const node of conversation) {
    for (const msg of node.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          calls.push({ name: tc.function.name, args: tc.function.arguments });
        }
      }
    }
  }
  return calls;
}

async function evaluateOne(
  assertion: TestAssertion,
  projectId: string,
  conversation: ConversationNode[],
  vfs: VirtualFileSystem,
): Promise<{ passed: boolean; actual?: string }> {
  switch (assertion.type) {
    case 'file_exists': {
      const exists = await vfs.fileExists(projectId, assertion.path);
      return { passed: exists, actual: exists ? 'file exists' : 'file not found' };
    }

    case 'file_not_exists': {
      const exists = await vfs.fileExists(projectId, assertion.path);
      return { passed: !exists, actual: exists ? 'file exists (unexpected)' : 'file not found (expected)' };
    }

    case 'file_contains': {
      const file = await vfs.readFile(projectId, assertion.path);
      const content = typeof file.content === 'string' ? file.content : '';
      const found = content.toLowerCase().includes(assertion.value.toLowerCase());
      return { passed: found, actual: found ? `contains "${truncate(assertion.value, 40)}"` : truncate(content, 80) };
    }

    case 'file_not_contains': {
      const file = await vfs.readFile(projectId, assertion.path);
      const content = typeof file.content === 'string' ? file.content : '';
      const found = content.toLowerCase().includes(assertion.value.toLowerCase());
      return { passed: !found, actual: found ? `still contains "${truncate(assertion.value, 40)}"` : 'value absent (expected)' };
    }

    case 'file_matches': {
      const file = await vfs.readFile(projectId, assertion.path);
      const content = typeof file.content === 'string' ? file.content : '';
      const re = new RegExp(assertion.pattern, 'i');
      const match = re.exec(content);
      return { passed: !!match, actual: match ? `matched: "${truncate(match[0], 40)}"` : truncate(content, 80) };
    }

    case 'file_matches_any': {
      const re = new RegExp(assertion.pattern, 'i');
      for (const filePath of assertion.paths) {
        try {
          const file = await vfs.readFile(projectId, filePath);
          const content = typeof file.content === 'string' ? file.content : '';
          const match = re.exec(content);
          if (match) return { passed: true, actual: `matched in ${filePath}: "${truncate(match[0], 40)}"` };
        } catch {
          // File doesn't exist, try next
        }
      }
      return { passed: false, actual: `pattern not found in any of: ${assertion.paths.join(', ')}` };
    }

    case 'valid_json': {
      const file = await vfs.readFile(projectId, assertion.path);
      const content = typeof file.content === 'string' ? file.content : '';
      try {
        JSON.parse(content);
        return { passed: true, actual: 'valid JSON' };
      } catch {
        return { passed: false, actual: `invalid JSON: ${truncate(content, 60)}` };
      }
    }

    case 'tool_used': {
      const calls = getToolCalls(conversation);
      let found = calls.some(c => c.name === assertion.toolName);
      if (!found && assertion.toolName === 'write') {
        const fileWritePattern = /^\s*(cat\s*>|sed\s+-i|write\s+|echo\s+.*>)/;
        found = calls.some(c => {
          if (c.name !== 'bash' && c.name !== 'shell') return false;
          try {
            const args = JSON.parse(c.args);
            const cmd = typeof args === 'string' ? args : args.command || args.cmd || '';
            return typeof cmd === 'string' && fileWritePattern.test(cmd);
          } catch {
            return fileWritePattern.test(c.args);
          }
        });
        if (found) return { passed: true, actual: 'file edited via bash command' };
      }
      return {
        passed: found,
        actual: found
          ? `${assertion.toolName} was called`
          : `tools used: ${[...new Set(calls.map(c => c.name))].join(', ') || 'none'}`,
      };
    }

    case 'tool_args_match': {
      const calls = getToolCalls(conversation);
      const re = new RegExp(assertion.pattern, 'i');
      const matching = calls.filter(c => c.name === assertion.toolName && re.test(c.args));
      if (matching.length > 0) {
        return { passed: true, actual: `matched args: ${truncate(matching[0].args, 60)}` };
      }
      const toolCalls = calls.filter(c => c.name === assertion.toolName);
      return {
        passed: false,
        actual: toolCalls.length > 0
          ? `${toolCalls.length} ${assertion.toolName} call(s), none matched pattern`
          : `${assertion.toolName} not called`,
      };
    }

    case 'output_matches': {
      const text = getAssistantText(conversation);
      const re = new RegExp(assertion.pattern, 'i');
      const match = re.exec(text);
      return { passed: !!match, actual: match ? `matched: "${truncate(match[0], 40)}"` : `no match in ${text.length} chars of output` };
    }

    case 'tool_output_matches': {
      const text = getToolOutputText(conversation, assertion.toolName);
      const re = new RegExp(assertion.pattern, 'i');
      const match = re.exec(text);
      return { passed: !!match, actual: match ? `matched: "${truncate(match[0], 40)}"` : `no match in ${text.length} chars of tool output` };
    }

    case 'any_of': {
      const subResults: { desc: string; actual?: string }[] = [];
      for (const sub of assertion.assertions) {
        const r = await evaluateOne(sub, projectId, conversation, vfs);
        if (r.passed) return { passed: true, actual: r.actual };
        subResults.push({ desc: sub.description, actual: r.actual });
      }
      return {
        passed: false,
        actual: subResults.map(r => `${r.desc}: ${r.actual}`).join(' | '),
      };
    }

    case 'judge':
      return { passed: false, actual: 'judge assertions handled separately' };
  }
}

export async function runAssertions(
  projectId: string,
  conversation: ConversationNode[],
  assertions: TestAssertion[]
): Promise<AssertionResult[]> {
  // The VFS of the run being checked: a server run's own, which the browser's `vfs` is not.
  const { getActiveVFS } = await import('@/lib/vfs');
  const vfs = getActiveVFS();
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    if (assertion.type === 'judge') continue;

    let result: { passed: boolean; actual?: string };
    try {
      result = await evaluateOne(assertion, projectId, conversation, vfs);
    } catch (err) {
      result = { passed: false, actual: err instanceof Error ? err.message : String(err) };
    }

    results.push({ assertion, passed: result.passed, actual: result.actual });
  }

  return results;
}
