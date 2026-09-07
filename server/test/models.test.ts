import { describe, expect, it } from 'vitest';

import { parseOpenCodeModels } from '../src/models.js';

describe('the opencode model catalog', () => {
  it('keeps model ids and ignores plugin logging', () => {
    expect(
      parseOpenCodeModels(
        '[plugin] initialized\nopenai/gpt-5.6-sol\nllama.cpp/qwen3.6\n\nopenai/gpt-5.6-sol\n',
      ),
    ).toEqual(['llama.cpp/qwen3.6', 'openai/gpt-5.6-sol']);
  });
});
