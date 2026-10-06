import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Lightweight logger with env-controlled levels
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };
const envLevel = (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_LOG_LEVEL as LogLevel)) || 'warn';

function shouldLog(threshold: LogLevel) {
  return levelOrder[envLevel] <= levelOrder[threshold];
}

export const logger = {
  debug: (...args: any[]) => { if (shouldLog('debug')) console.debug(...args); },
  info:  (...args: any[]) => { if (shouldLog('info')) console.info(...args); },
  warn:  (...args: any[]) => { if (shouldLog('warn')) console.warn(...args); },
  error: (...args: any[]) => { if (shouldLog('error')) console.error(...args); },
};
