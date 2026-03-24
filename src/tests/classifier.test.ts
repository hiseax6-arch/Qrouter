import { describe, expect, test } from 'vitest';
import {
  classifyChatCompletionChunk,
  classifyChatCompletionResult,
} from '../domain/classify.js';

describe('classifyChatCompletionResult', () => {
  test('classifies empty 200 response as empty_success', () => {
    const result = classifyChatCompletionResult({
      choices: [
        {
          message: {
            role: 'assistant',
            content: ''
          }
        }
      ]
    });

    expect(result).toEqual({
      kind: 'empty_success',
      reason: 'no_semantic_payload',
      retryable: true
    });
  });

  test('classifies tool-call-only response as semantic_success', () => {
    const result = classifyChatCompletionResult({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'lookup_weather',
                  arguments: '{"city":"Shanghai"}'
                }
              }
            ]
          }
        }
      ]
    });

    expect(result).toEqual({
      kind: 'semantic_success',
      reason: 'tool_call'
    });
  });
});

describe('classifyChatCompletionChunk', () => {
  test('classifies whitespace-only streaming delta as empty_success', () => {
    const result = classifyChatCompletionChunk({
      choices: [
        {
          delta: {
            role: 'assistant',
            content: '   '
          }
        }
      ]
    });

    expect(result).toEqual({
      kind: 'empty_success',
      reason: 'no_semantic_payload',
      retryable: true
    });
  });

  test('classifies streaming text delta as semantic_success', () => {
    const result = classifyChatCompletionChunk({
      choices: [
        {
          delta: {
            role: 'assistant',
            content: 'hello'
          }
        }
      ]
    });

    expect(result).toEqual({
      kind: 'semantic_success',
      reason: 'text'
    });
  });
});
