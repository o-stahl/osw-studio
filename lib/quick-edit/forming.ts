import { parseCommand, type ActionKind } from '@/lib/agent-activity/parse-command';
import { extractPartialCmd } from '@/components/chat-panel/event-processor';

/**
 * A tool call the model is still writing: what it does, so far as its command says, and how many
 * lines of a file it has written. A write names its action in its first few characters, long
 * before the file it carries has arrived.
 */
export interface FormingStep {
  kind: ActionKind;
  path: string | null;
  /** Lines of the heredoc written so far; zero for a command that carries no file. */
  lines: number;
}

/** A heredoc on the command's first line: `cat > a.html << 'EOF'`, `ss /a.css <<EOF`. */
const HEREDOC = /<<-?\s*['"]?\w+['"]?/;

/** What a command written so far does, or null while it names nothing yet. */
export function describeCommand(command: string): FormingStep | null {
  const parsed = parseCommand(command);
  if (!parsed) return null;
  const [first, ...rest] = command.split('\n');
  return { kind: parsed.kind, path: parsed.path, lines: HEREDOC.test(first) ? rest.length : 0 };
}

/** What a tool call's arguments say so far, or null while they name no command yet. */
export function describeForming(args: string): FormingStep | null {
  const command = extractPartialCmd(args);
  return command ? describeCommand(command) : null;
}
