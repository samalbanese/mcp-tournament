import { describe, expect, it } from 'vitest';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('OpenRouter e2e prerequisites', () => {
  it('has credentials when explicitly enabled', () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
  });
});
