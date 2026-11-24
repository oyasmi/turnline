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
const conversation = 'conv_' + 'c'.repeat(32);
const answer = {
  id: 'assistant_1', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
  content: [{ type: 'output_text', text: '这是浏览器直连的回复。' }],
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function pipiclawResponse(incoming, response) {
  if (incoming.url === '/v1/responses') {
    incoming.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: answer }) + '\n\n');
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [answer] } }) + '\n\n');
  } else {
    const body = incoming.url === '/v1/models/pipiclaw' ? { id: 'pipiclaw' }
      : incoming.url === '/v1/conversations' ? { id: conversation }
        : { data: [answer], has_more: false };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
}

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
    pipiclawRequests.push({ path: incoming.url, authorization: incoming.headers.authorization,
      cookie: incoming.headers.cookie, origin: incoming.headers.origin });
    if (incoming.headers.authorization !== 'Bearer ' + fixtureKey) {
      response.writeHead(401).end();
    } else {
      pipiclawResponse(incoming, response);
    }
  });
  const pipiclawUrl = 'https://127.0.0.1:' + await listen(pipiclaw);

  const socketDirectory = join(state, 'state', 'webapi');
  mkdirSync(socketDirectory, { recursive: true });
  const socketRequests = [];
  localPipiclaw = createHttpServer((incoming, response) => {
    socketRequests.push({ path: incoming.url, authorization: incoming.headers.authorization });
    pipiclawResponse(incoming, response);
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

  browser = await chromium.launch({ args: [
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

  await page.goto(first);
  await waitFor('#backend-label', 'Pipiclaw 已连接');
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.getByRole('link', { name: '浏览器直连' }).click();
  await waitFor('#backend-label', '等待设置');
  assert.equal(new URL(page.url()).pathname, '/direct');
  assert.equal(await page.evaluate(() => isSecureContext), true);
  await page.getByRole('button', { name: '设置直连' }).click();
  await page.getByLabel('Pipiclaw 地址').fill(pipiclawUrl);
  await page.getByLabel('Pipiclaw Key', { exact: true }).fill(fixtureKey);
  await page.getByRole('button', { name: '测试并连接' }).click();
  await waitFor('#backend-label', 'Pipiclaw 已连接');
  await page.getByRole('button', { name: '开始通话' }).click();
  await waitFor('#status', '正在聆听');
  await page.getByRole('textbox', { name: '文字消息' }).fill('测试浏览器直连');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitFor('.entry.assistant .content', '这是浏览器直连的回复');
  await waitFor('#metric-audio', 'ms');
  await page.getByRole('button', { name: '挂断' }).click();
  await page.reload();
  await waitFor('#backend-label', 'Pipiclaw 已连接');
  await waitFor('.entry.assistant .content', '这是浏览器直连的回复');
  assert.ok(!await page.evaluate(key => Object.values(localStorage).some(value => value.includes(key)), fixtureKey));
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.getByRole('link', { name: '服务端中转' }).click();
  await waitFor('#backend-label', 'Pipiclaw 已连接');
  assert.equal(new URL(page.url()).pathname, '/');

  await page.goto(second);
  await waitFor('#backend-label', 'Pipiclaw 已连接');
  await page.getByRole('textbox', { name: '文字消息' }).fill('测试同机中转');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitFor('.entry.assistant .content', answer.content[0].text);
  await page.reload();
  await waitFor('.entry.assistant .content', answer.content[0].text);
  const cookies = await page.context().cookies(second);
  assert.ok(cookies.some(cookie => cookie.name === '__Host-turnline' && cookie.secure && cookie.httpOnly));
  assert.ok(turnlineRequests.some(entry => entry.host === firstHost + ':' + port && entry.path === '/speech/listen'));
  assert.ok(turnlineRequests.some(entry => entry.host === firstHost + ':' + port && entry.path === '/speech/synthesize'));
  assert.ok(turnlineRequests.some(entry => entry.host === secondHost + ':' + port &&
    entry.path === '/api/pipiclaw/v1/responses'));
  assert.ok(turnlineRequests.every(entry => !entry.authorization &&
    (entry.host !== firstHost + ':' + port || !entry.path.startsWith('/api/pipiclaw/'))));
  assert.ok(socketRequests.some(entry => entry.path === '/v1/responses'));
  assert.ok(socketRequests.every(entry => !entry.authorization));
  assert.ok(preflights > 0 && pipiclawRequests.some(entry => entry.path === '/v1/responses'));
  assert.ok(pipiclawRequests.every(entry =>
    entry.authorization === 'Bearer ' + fixtureKey && !entry.cookie && entry.origin === first));
  console.log('Two HTTPS addresses, automatic socket relay, WSS, PCM, direct CORS/SSE, and history recovery passed.');
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
