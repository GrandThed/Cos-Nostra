import { test } from 'node:test';
import assert from 'node:assert/strict';

import { testApp, testEnv } from './helpers.js';
import { clips, posts, reactions, users } from '../src/db/schema.js';

const READY = 'readyclip001';
const PENDING = 'pendingclip1';
const TITLE = 'Ace <script>alert(1)</script> & "win"';

async function seed(app) {
  const [user] = await app.db
    .insert(users)
    .values({ discordId: '123456789', username: 'benja', avatar: 'abc123' })
    .returning();
  const base = {
    userId: user.id,
    game: 'Counter-Strike 2',
    durationMs: 21500,
    width: 1920,
    height: 1080,
    keyAv1: 'k/av1.mp4',
    keyH264: 'k/h264.mp4',
    keyThumb: 'k/thumb.jpg',
  };
  await app.db.insert(clips).values([
    { ...base, id: READY, title: TITLE, status: 'ready', recordedAt: new Date('2026-09-01T12:00:00Z') },
    { ...base, id: PENDING, title: 'Not yet', status: 'pending', recordedAt: new Date('2026-09-02T12:00:00Z') },
  ]);
  const [post] = await app.db
    .insert(posts)
    .values({ clipId: READY, guildId: 'g', channelId: 'c', messageId: 'm1' })
    .returning();
  await app.db.insert(reactions).values([
    { postId: post.id, userDiscordId: 'u1', emoji: '🔥' },
    { postId: post.id, userDiscordId: 'u2', emoji: '🔥' },
    { postId: post.id, userDiscordId: 'u3', emoji: '🔥', removedAt: new Date() },
  ]);
}

test('player page renders a ready clip with AV1 first and H.264 fallback', async () => {
  const app = await testApp();
  try {
    await seed(app);
    const res = await app.inject({ method: 'GET', url: `/c/${READY}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    const html = res.body;

    const av1 = `${testEnv.PUBLIC_URL}/clips/${READY}/av1`;
    const h264 = `${testEnv.PUBLIC_URL}/clips/${READY}/h264`;
    const thumb = `${testEnv.PUBLIC_URL}/clips/${READY}/thumb`;
    const av1Src = `<source src="${av1}" type='video/mp4; codecs="av01.0.08M.08"'>`;
    const h264Src = `<source src="${h264}" type='video/mp4; codecs="avc1.640028"'>`;
    assert.ok(html.includes(av1Src), 'av1 source');
    assert.ok(html.includes(h264Src), 'h264 source');
    assert.ok(html.indexOf(av1Src) < html.indexOf(h264Src), 'av1 before h264');
    assert.ok(html.includes(`poster="${thumb}"`));
    assert.ok(html.includes('<video controls playsinline'));

    assert.ok(html.includes(`<meta property="og:video" content="${h264}">`));
    assert.ok(html.includes(`<meta property="og:video:secure_url" content="${h264}">`));
    assert.ok(html.includes(`<meta property="og:image" content="${thumb}">`));
    assert.ok(html.includes('<meta name="twitter:card" content="player">'));

    assert.ok(!html.includes('<script>'), 'raw script tag must not appear');
    assert.ok(html.includes('Ace &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;win&quot;'));
    assert.ok(html.includes('benja'));
    assert.ok(html.includes('https://cdn.discordapp.com/avatars/123456789/abc123.png?size=64'));
    assert.ok(html.includes('2026-09-01'));
    assert.ok(html.includes('0:22'));
    assert.ok(html.includes('2 reactions'));
    assert.ok(html.includes(`href="${h264}" download`));
    assert.ok(html.includes('name="viewport"'));
    assert.ok(Buffer.byteLength(html) < 6000, `page is ${Buffer.byteLength(html)} bytes`);
  } finally {
    await app.close();
  }
});

test('pending and unknown clips answer 404 HTML', async () => {
  const app = await testApp();
  try {
    await seed(app);
    for (const id of [PENDING, 'nope']) {
      const res = await app.inject({ method: 'GET', url: `/c/${id}` });
      assert.equal(res.statusCode, 404, id);
      assert.match(res.headers['content-type'], /^text\/html/);
      assert.ok(res.body.includes('Clip not found'));
    }
  } finally {
    await app.close();
  }
});

test('recent clips page lists ready clips only', async () => {
  const app = await testApp();
  try {
    await seed(app);
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.ok(res.body.includes(`href="/c/${READY}"`));
    assert.ok(!res.body.includes(PENDING));
    assert.ok(!res.body.includes('<script>'));
    assert.ok(res.body.includes(`${testEnv.PUBLIC_URL}/clips/${READY}/thumb`));
  } finally {
    await app.close();
  }
});
