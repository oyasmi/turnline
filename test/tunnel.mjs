import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const cwd = new URL('..', import.meta.url);
const state = mkdtempSync(join(tmpdir(), 'turnline-tunnel-'));
const firstHost = 'first.turnline.test';
const secondHost = 'second.turnline.test';
const fixtureKey = 'pk_fixture_only';
const answer = {
  id: 'assistant_1', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
  content: [{ type: 'output_text', text: '这是浏览器直连的回复。' }],
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function pipiclawFixture() {
  const conversations = new Map();
  const requests = [];
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };
  async function readBody(incoming) {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    return JSON.parse(body);
  }
  async function respond(incoming, response) {
    const url = new URL(incoming.url, 'http://localhost');
    if (url.pathname === '/v1/models/pipiclaw') return json(response, { id: 'pipiclaw' });
    if (url.pathname === '/v1/conversations' && incoming.method === 'POST') {
      incoming.resume();
      const id = 'conv_' + (conversations.size + 1).toString(16).padStart(32, '0');
      conversations.set(id, { items: [], metadata: {} });
      return json(response, { id });
    }
    const match = /^\/v1\/conversations\/(conv_[a-f0-9]{32})$/.exec(url.pathname);
    if (match) {
      const id = match[1];
      const conversation = conversations.get(id);
      if (!conversation) return json(response, { error: { message: 'Unknown conversation' } }, 404);
      if (incoming.method === 'POST') Object.assign(conversation.metadata, (await readBody(incoming)).metadata);
      return json(response, { id, metadata: conversation.metadata });
    }
    if (url.pathname.endsWith('/items')) {
      const items = conversations.get(url.pathname.split('/')[3])?.items;
      if (!items) return json(response, { error: { message: 'Unknown conversation' } }, 404);
      const ordered = url.searchParams.get('order') === 'desc' ? items.slice().reverse() : items;
      const after = url.searchParams.get('after');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const remaining = after ? ordered.slice(ordered.findIndex(item => item.id === after) + 1) : ordered;
      return json(response, { data: remaining.slice(0, limit), has_more: remaining.length > limit });
    }
    if (url.pathname !== '/v1/responses') return json(response, {}, 404);
    if (incoming.method !== 'POST') return json(response, {}, 426);
    const request = await readBody(incoming);
    const items = conversations.get(request.conversation)?.items;
    if (!items) return json(response, { error: { message: 'Unknown conversation' } }, 404);
    requests.push(request);
    const input = { id: 'user_' + requests.length, type: 'message', role: 'user', status: 'completed',
      content: [{ type: 'input_text', text: request.input }] };
    const reply = { ...answer, id: 'assistant_' + requests.length };
    items.push(input, reply);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: reply }) + '\n\n');
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [reply] } }) + '\n\n');
  }
  return { respond, requests };
}

const directFixture = pipiclawFixture();
const relayFixture = pipiclawFixture();
let turnline, edge, pipiclaw, localPipiclaw, browser;
try {
  const certPath = join(state, 'edge.pem');
  const keyPath = join(state, 'edge-key.pem');
  execFileSync('openssl', ['req', '-x509', '-days', '1', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=' + firstHost, '-addext', 'subjectAltName=DNS:' + firstHost + ',DNS:' + secondHost + ',IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath], { stdio: 'pipe' });
  const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  const publicKey = new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' });
  const pin = Buffer.from(await crypto.subtle.digest('SHA-256', publicKey)).toString('base64');

  const pipiclawRequests = [];
  let preflights = 0;
  pipiclaw = createServer(tls, (incoming, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (incoming.method === 'OPTIONS') {
      preflights++;
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      }).end();
      return;
    }
    pipiclawRequests.push({ path: incoming.url, method: incoming.method, authorization: incoming.headers.authorization,
      cookie: incoming.headers.cookie, origin: incoming.headers.origin });
    if (incoming.headers.authorization !== 'Bearer ' + fixtureKey) {
      response.writeHead(401).end();
    } else {
      void directFixture.respond(incoming, response);
    }
  });
  const pipiclawUrl = 'https://127.0.0.1:' + await listen(pipiclaw);

  const socketDirectory = join(state, 'state', 'webapi');
  mkdirSync(socketDirectory, { recursive: true });
  const socketRequests = [];
  localPipiclaw = createHttpServer((incoming, response) => {
    socketRequests.push({ path: incoming.url, authorization: incoming.headers.authorization });
    void relayFixture.respond(incoming, response);
  });
  localPipiclaw.listen(join(socketDirectory, 'api.sock'));
  await once(localPipiclaw, 'listening');

  turnline = spawn('uv', ['run', '--no-sync', 'python', 'server.py', '--port', '0', '--state-dir', state], {
    cwd, env: { ...process.env, PIPICLAW_HOME: state }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const backend = new URL(await new Promise((resolve, reject) => {
    turnline.once('error', reject);
    turnline.once('exit', code => reject(new Error('Turnline exited with ' + code)));
    turnline.stdout.once('data', chunk => resolve(String(chunk).trim().split(' ').at(-1)));
  }));

  const turnlineRequests = [];
  function forward(incoming) {
    const { host, authorization } = incoming.headers;
    turnlineRequests.push({ host, path: incoming.url, authorization });
    const headers = { ...incoming.headers, host: backend.host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' };
    return request(new URL(incoming.url, backend), { method: incoming.method, headers });
  }
  edge = createServer(tls, (incoming, response) => {
    const upstream = forward(incoming);
    upstream.on('response', reply => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    response.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  edge.on('upgrade', (incoming, client, head) => {
    const upstream = forward(incoming);
    upstream.on('response', () => client.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('upgrade', (reply, socket, early) => {
      const headers = [];
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        headers.push(reply.rawHeaders[index] + ': ' + reply.rawHeaders[index + 1]);
      }
      client.write('HTTP/1.1 101 Switching Protocols\r\n' + headers.join('\r\n') + '\r\n\r\n');
      if (early.length) client.write(early);
      if (head.length) socket.write(head);
      client.on('error', () => socket.destroy());
      socket.on('error', () => client.destroy());
      client.on('close', () => socket.destroy());
      socket.on('close', () => client.destroy());
      client.pipe(socket).pipe(client);
    });
    upstream.end();
  });
  const port = await listen(edge);
  const first = 'https://' + firstHost + ':' + port;
  const second = 'https://' + secondHost + ':' + port;

  browser = await chromium.launch({ channel: process.env.TURNLINE_TEST_BROWSER_CHANNEL, args: [
    '--ignore-certificate-errors-spki-list=' + pin,
    '--host-resolver-rules=MAP *.turnline.test 127.0.0.1',
    '--no-proxy-server',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ] });
  const page = await browser.newPage({ permissions: ['microphone'] });
  async function waitFor(selector, text) {
    try {
      await page.waitForFunction(
        ([target, value]) => document.querySelector(target)?.textContent.includes(value),
        [selector, text], { timeout: 15_000 });
    } catch (error) {
      const status = await page.locator('#backend-label, #status, #error, #direct-error').allTextContents();
      throw new Error('Expected ' + text + ' on ' + selector + '. Browser state: ' + status.join(' / '), { cause: error });
    }
  }

  async function sendText(text) {
    await page.getByRole('textbox', { name: '文字消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await waitFor('.entry.assistant:last-child .content', answer.content[0].text);
  }

  async function switchConversation(title) {
    await page.getByRole('button', { name: '历史会话' }).click();
    const picker = page.getByRole('dialog', { name: '历史会话' });
    await picker.getByRole('button', { name: title, exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    await waitFor('.entry.user .content', title);
  }

  async function verifyHistory(fixture, firstTitle, secondTitle) {
    const firstId = fixture.requests[0].conversation;
    await page.getByRole('button', { name: '新对话' }).click();
    await page.getByRole('button', { name: '确认清空？' }).click();
    await page.reload();
    await page.locator('#empty').waitFor({ state: 'visible' });
    await sendText(secondTitle);
    assert.notEqual(fixture.requests[1].conversation, firstId);
    await switchConversation(firstTitle);
    assert.equal(await page.locator('.entry.user').count(), 1);
    await sendText('继续之前的对话');
    assert.equal(fixture.requests[2].conversation, firstId);
    await page.reload();
    await waitFor('.entry.user:nth-last-child(2) .content', '继续之前的对话');
    await switchConversation(secondTitle);
    assert.equal(await page.locator('.entry.user').count(), 1);
  }

  await page.goto(first);
  await waitFor('#backend-label', 'PipiClaw 已连接');
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.getByRole('link', { name: '浏览器直连' }).click();
  await waitFor('#backend-label', '等待设置');
  assert.equal(new URL(page.url()).pathname, '/direct');
  assert.equal(await page.evaluate(() => isSecureContext), true);
  await page.getByRole('button', { name: '设置直连' }).click();
  await page.getByLabel('PipiClaw 地址').fill(pipiclawUrl);
  await page.getByLabel('PipiClaw Key', { exact: true }).fill(fixtureKey);
  await page.getByRole('button', { name: '测试并连接' }).click();
  await waitFor('#backend-label', 'PipiClaw 已连接');
  await page.getByRole('button', { name: '开始通话' }).click();
  await waitFor('#status', '正在聆听');
  await page.getByRole('textbox', { name: '文字消息' }).fill('测试浏览器直连');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitFor('.entry.assistant .content', '这是浏览器直连的回复');
  await waitFor('#metric-audio', 'ms');
  await page.getByRole('button', { name: '挂断' }).click();
  await page.reload();
  await waitFor('#backend-label', 'PipiClaw 已连接');
  await waitFor('.entry.assistant .content', '这是浏览器直连的回复');
  await page.setViewportSize({ width: 360, height: 640 });
  await verifyHistory(directFixture, '测试浏览器直连', '另一条浏览器直连会话');
  assert.ok(!pipiclawRequests.some(entry => entry.method === 'GET' && /^\/v1\/conversations(?:\?|$)/.test(entry.path)));
  assert.ok(!await page.evaluate(key => Object.values(localStorage).some(value => value.includes(key)), fixtureKey));
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.getByRole('link', { name: '服务端中转' }).click();
  await waitFor('#backend-label', 'PipiClaw 已连接');
  assert.equal(new URL(page.url()).pathname, '/');

  await page.goto(second);
  await waitFor('#backend-label', 'PipiClaw 已连接');
  await sendText('测试同机中转');
  await verifyHistory(relayFixture, '测试同机中转', '另一条同机中转会话');
  const cookies = await page.context().cookies(second);
  assert.ok(cookies.some(cookie => cookie.name === '__Host-turnline' && cookie.secure && cookie.httpOnly));
  assert.ok(turnlineRequests.some(entry => entry.host === firstHost + ':' + port && entry.path === '/speech/voice'));
  assert.ok(turnlineRequests.some(entry => entry.host === secondHost + ':' + port &&
    entry.path === '/api/pipiclaw/v1/responses'));
  assert.ok(turnlineRequests.every(entry => !entry.authorization &&
    (entry.host !== firstHost + ':' + port || !entry.path.startsWith('/api/pipiclaw/'))));
  assert.ok(socketRequests.some(entry => entry.path === '/v1/responses'));
  assert.ok(socketRequests.every(entry => !entry.authorization));
  assert.ok(preflights > 0 && pipiclawRequests.some(entry => entry.path === '/v1/responses'));
  assert.ok(pipiclawRequests.every(entry =>
    entry.authorization === 'Bearer ' + fixtureKey && !entry.cookie && entry.origin === first));
  console.log('HTTPS, WSS, PCM, direct CORS/SSE, and conversation switching in both connection modes passed.');
} finally {
  await browser?.close();
  edge?.close();
  pipiclaw?.close();
  localPipiclaw?.close();
  if (turnline && turnline.exitCode === null && turnline.signalCode === null) {
    turnline.kill();
    await once(turnline, 'exit');
  }
  rmSync(state, { recursive: true, force: true });
}
