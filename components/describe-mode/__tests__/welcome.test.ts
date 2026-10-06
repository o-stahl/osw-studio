import { describe, it, expect } from 'vitest';
import en from '@/messages/en.json';
import { WELCOME_TEXT } from '../welcome';

describe('Describe welcome', () => {
  it('shows in English exactly what the agent reads', () => {
    expect(en.describe.welcome).toBe(WELCOME_TEXT);
  });
});
