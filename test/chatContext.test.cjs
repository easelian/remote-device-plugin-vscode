const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const exportsForTest = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../out/chatContext.js'), 'utf8'), {
  exports: exportsForTest,
  require: () => ({}),
});
const { toolResultText } = exportsForTest;
const model = { maxInputTokens: 16_384 };
const textBlock = (value) => ({ type: 'text', text: JSON.stringify(value) });
const render = (value, selectedModel = model) => JSON.parse(toolResultText(value, selectedModel));

test('tool result removes equivalent JSON text despite nested property order', () => {
  const structuredContent = { rows: [{ id: 1, details: { ready: true, value: null } }], count: 1 };
  const result = {
    content: [textBlock({ count: 1, rows: [{ details: { value: null, ready: true }, id: 1 }] })],
    structuredContent,
    isError: false,
    _meta: { cursor: 'next' },
  };
  const before = JSON.stringify(result);
  assert.deepEqual(render(result), { ...result, content: [] });
  assert.equal(JSON.stringify(result), before, 'normalization must not mutate the result');
});

test('tool result retains differing values, keys, array order, types and malformed JSON', () => {
  const structuredContent = { rows: [1, 2], ready: true };
  const result = {
    structuredContent,
    content: [
      textBlock({ rows: [2, 1], ready: true }),
      textBlock({ rows: [1, 2], ready: false }),
      textBlock({ rows: [1, 2], other: true }),
      textBlock({ rows: { 0: 1, 1: 2 }, ready: true }),
      textBlock({ rows: [1, 2], ready: 'true' }),
      { type: 'text', text: 'not JSON' },
      { type: 'text', text: '{"rows":' },
    ],
  };
  assert.deepEqual(render(result), result);
});

test('tool result preserves errors, metadata, annotations and mixed multimedia content', () => {
  const structuredContent = { error: 'operation failed' };
  const retained = [
    { type: 'text', text: 'Additional error details' },
    { ...textBlock(structuredContent), annotations: { audience: ['user'] } },
    { ...textBlock(structuredContent), _meta: { source: 'device' } },
    { type: 'image', data: 'synthetic-image', mimeType: 'image/png' },
    { type: 'audio', data: 'synthetic-audio', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'test://file', text: 'synthetic file' } },
  ];
  const result = {
    isError: true,
    structuredContent,
    content: [textBlock(structuredContent), ...retained],
    _meta: { requestId: 'synthetic-request' },
    customStatus: 'failed',
  };
  assert.deepEqual(render(result), { ...result, content: retained });
});

test('tool result without a structured object retains its original representation', () => {
  for (const structuredContent of [undefined, null, 'plain text', 1, false]) {
    const result = { structuredContent, content: [textBlock({ value: 1 })], isError: true };
    assert.equal(toolResultText(result, model), JSON.stringify(result));
  }
});

test('normalization avoids truncation when the single representation fits the limit', () => {
  const structuredContent = { data: 'x'.repeat(700) };
  const result = { content: [textBlock(structuredContent)], structuredContent };
  assert.ok(JSON.stringify(result).length > 1000);
  assert.deepEqual(render(result, { maxInputTokens: 500 }), { ...result, content: [] });
});

test('oversized normalized results retain explicit partial-result and error markers', () => {
  const structuredContent = { data: 'x'.repeat(2000) };
  const result = { content: [textBlock(structuredContent)], structuredContent, isError: true };
  const normalized = { ...result, content: [] };
  const rendered = render(result, { maxInputTokens: 500 });
  assert.equal(rendered.rdh_context_truncated, true);
  assert.equal(rendered.isError, true);
  assert.equal(rendered.originalCharacters, JSON.stringify(normalized).length);
  assert.ok(rendered.preview.length <= 1000);
  assert.match(rendered.preview, /omitted/);
  assert.match(rendered.instruction, /partial tool result/);
});
