import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWeixinApi,
  extractWeixinText,
  orderWeixinMessages,
  splitWeixinText,
  weixinMessageId,
} from './weixin-api.ts';

test('extractWeixinText / weixinMessageId', () => {
  assert.equal(extractWeixinText({ item_list: [{ type: 1, text_item: { text: ' 你好 ' } }] }), '你好');
  assert.equal(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }), '语音转写');
  assert.equal(extractWeixinText({ item_list: [] }), null);
  assert.equal(weixinMessageId({ message_id: 123 }), '123');
  assert.equal(weixinMessageId({ client_id: 'c1' }), 'c1');
});

test('splitWeixinText 按 1800 字切分且不超限', () => {
  const text = 'a'.repeat(1_500) + '\n' + 'b'.repeat(1_500);
  const chunks = splitWeixinText(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_800));
  assert.equal(chunks.join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('orderWeixinMessages 按 seq 排序且缺字段时保持原序', () => {
  const ordered = orderWeixinMessages([
    { seq: 2, id: 'b' },
    { seq: 1, id: 'a' },
  ]);
  assert.deepEqual(
    ordered.map((x) => (x as { id: string }).id),
    ['a', 'b'],
  );
  const raw = [{ id: 'b' }, { id: 'a' }];
  assert.deepEqual(orderWeixinMessages(raw), raw);
});

test('createWeixinApi：beginLogin 归一化二维码，sendText 发送文本并切分', async () => {
  const calls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers as Record<string, string>,
    });
    if (String(input).includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-token', qrcode_img_content: 'https://weixin.qq.com/x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const api = createWeixinApi({ fetchImpl });
  const login = await api.beginLogin({ localTokens: ['old'] });
  assert.equal(login.qrcode, 'qr-token');
  assert.equal(login.qrcodeUrl, 'https://weixin.qq.com/x');
  await api.sendText({
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'token',
    toUserId: 'wxid_1',
    text: '你好',
    contextToken: 'ctx',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers?.['iLink-App-Id'], 'bot');
  assert.equal(calls[1].headers?.Authorization, 'Bearer token');
  assert.equal((calls[1].body as { msg: { to_user_id: string } }).msg.to_user_id, 'wxid_1');
});

test('createWeixinApi：微信服务拒绝发送时抛 send-rejected', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ret: -2 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const api = createWeixinApi({ fetchImpl });
  await assert.rejects(
    api.sendText({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', toUserId: 'u', text: 'x' }),
    (error: { code?: string }) => error.code === 'send-rejected',
  );
});
