/* eslint-disable @typescript-eslint/no-explicit-any -- 测试用假的 gateway / 事件形状。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DshSessionRunner } from './session.ts';

function fakeContext() {
  let listener: ((session: unknown, event: unknown) => void) | null = null;
  const calls: Array<{ namespace: string; method: string; args: any }> = [];
  const gateway = {
    async invoke(req: { namespace: string; method: string; args: any }) {
      calls.push(req);
      if (req.method === 'list') return { items: [{ sessionId: 'ses_1', title: 'One', running: false }] };
      if (req.method === 'prompt') return { accepted: true };
      return {};
    },
  };
  const ctx = {
    get: (name: string) => (name === 'typertGateway' ? gateway : undefined),
    connection: { createPeer: () => ({ dispose() {} }) },
    on: (_name: string, fn: typeof listener) => {
      listener = fn;
    },
    effect: () => {},
  };
  return { ctx, calls, emit: (session: unknown, event: unknown) => listener?.(session, event) };
}

test('listSessions 读取 session.list', async () => {
  const { ctx } = fakeContext();
  const runner = new DshSessionRunner(ctx);
  assert.deepEqual(await runner.listSessions(), [{ sessionId: 'ses_1', title: 'One', running: false }]);
});

test('ask 投递 prompt，等待 user/message + assistant 文本 + turn/end', async () => {
  const { ctx, calls, emit } = fakeContext();
  const runner = new DshSessionRunner(ctx);
  const answer = runner.ask('ses_1', '你好');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const prompt = calls.find((call) => call.method === 'prompt');
  assert.ok(prompt);
  const rpcId = prompt.args.request.requestId as string;
  emit({ id: 'ses_1' }, { type: 'turn/start', data: { turn: 1 } });
  emit({ id: 'ses_1' }, { type: 'user/message', data: { turn: 1, source: { rpcId } } });
  emit(
    { id: 'ses_1' },
    { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '你' } } },
  );
  emit(
    { id: 'ses_1' },
    { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '好' } } },
  );
  emit({ id: 'ses_1' }, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(await answer, '你好');
});

test('ask 忽略其他 session / turn 的事件，工具调用后只保留最终回答', async () => {
  const { ctx, calls, emit } = fakeContext();
  const runner = new DshSessionRunner(ctx);
  const answer = runner.ask('ses_1', '查一下');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rpcId = calls.find((call) => call.method === 'prompt')!.args.request.requestId as string;
  emit({ id: 'other' }, { type: 'user/message', data: { turn: 9, source: { rpcId } } });
  emit({ id: 'ses_1' }, { type: 'turn/start', data: { turn: 2 } });
  emit({ id: 'ses_1' }, { type: 'user/message', data: { turn: 2, source: { rpcId } } });
  emit(
    { id: 'ses_1' },
    { type: 'assistant/chunk', data: { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: '过程' } } },
  );
  emit({ id: 'ses_1' }, { type: 'tool/call', data: { turn: 2 } });
  emit(
    { id: 'ses_1' },
    {
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '最终回答' }] } },
    },
  );
  emit({ id: 'ses_1' }, { type: 'turn/end', data: { turn: 2 } });
  assert.equal(await answer, '最终回答');
});
