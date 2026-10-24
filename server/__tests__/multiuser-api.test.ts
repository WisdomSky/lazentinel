import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { AuthDatabase } from '../auth-db.js';
import { AuthService } from '../auth.js';
import { AppDatabase } from '../db.js';
import { ProductService } from '../service.js';
import {
  DEFAULT_PRODUCT_URL,
  FakeScraper,
  silentLogger,
} from './helpers/fakes.js';

type Agent = ReturnType<typeof request.agent>;

let db: AppDatabase;
let authDb: AuthDatabase;
let auth: AuthService;
let scraper: FakeScraper;
let service: ProductService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new AppDatabase(':memory:');
  authDb = new AuthDatabase(':memory:');
  auth = new AuthService(authDb);
  scraper = new FakeScraper();
  service = new ProductService(db, scraper, {
    staggerMs: 0,
    logger: silentLogger,
  });
  app = createApp({
    service,
    auth,
    multiUser: true,
    cookieSecure: false,
  });
});

afterEach(() => {
  service.stop();
  db.close();
  authDb.close();
});

async function register(
  agent: Agent,
  email: string,
  password = 'secret',
): Promise<void> {
  await agent
    .post('/api/auth/register')
    .send({ email, password, confirmPassword: password })
    .expect(201);
}

async function login(agent: Agent, email: string, password = 'secret'): Promise<void> {
  await agent.post('/api/auth/login').send({ email, password }).expect(200);
}

async function registerAndLogin(
  agent: Agent,
  email: string,
  password = 'secret',
): Promise<void> {
  await register(agent, email, password);
  await login(agent, email, password);
}

function expectNoOwnerFields(product: Record<string, unknown>): void {
  expect(product).not.toHaveProperty('userId');
  expect(product).not.toHaveProperty('user_id');
  expect(product).not.toHaveProperty('ownerId');
}

describe('multi-user HTTP API', () => {
  it('exposes a public session endpoint with unauthenticated state', async () => {
    const agent = request.agent(app);

    const response = await agent.get('/api/auth/session').expect(200);
    expect(response.body).toEqual({
      multiUser: true,
      authenticated: false,
      user: null,
    });
    expect(response.headers['cache-control']).toBe('no-store');

    await registerAndLogin(agent, 'Alice@Example.com');

    const authenticated = await agent.get('/api/auth/session').expect(200);
    expect(authenticated.body).toEqual({
      multiUser: true,
      authenticated: true,
      user: { email: 'alice@example.com' },
    });
  });

  it('registers without auto-login and rejects duplicate or mismatched registrations', async () => {
    const agent = request.agent(app);

    const created = await agent
      .post('/api/auth/register')
      .send({
        email: 'Alice@Example.com',
        password: 'secret',
        confirmPassword: 'secret',
      })
      .expect(201);
    expect(created.body).toEqual({ user: { email: 'alice@example.com' } });
    expect(created.headers['set-cookie']).toBeUndefined();

    const stillSignedOut = await agent.get('/api/auth/session').expect(200);
    expect(stillSignedOut.body.authenticated).toBe(false);

    const duplicate = await agent
      .post('/api/auth/register')
      .send({
        email: 'ALICE@EXAMPLE.COM',
        password: 'other',
        confirmPassword: 'other',
      })
      .expect(409);
    expect(duplicate.body).toEqual({ error: expect.any(String) });

    const mismatch = await agent
      .post('/api/auth/register')
      .send({
        email: 'bob@example.com',
        password: 'one',
        confirmPassword: 'two',
      })
      .expect(400);
    expect(mismatch.body).toEqual({ error: expect.any(String) });

    expect(authDb.countUsers()).toBe(1);
  });

  it('logs in with an HttpOnly session cookie and logs out', async () => {
    const agent = request.agent(app);
    await register(agent, 'alice@example.com');

    const response = await agent
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'secret' })
      .expect(200);
    expect(response.body).toEqual({ user: { email: 'alice@example.com' } });

    const rawCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? (rawCookie as string[]) : [];
    const sessionCookie = cookies.find((cookie) =>
      cookie.startsWith('lazentinel_session='),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie ?? '').toMatch(/HttpOnly/);
    expect(sessionCookie ?? '').toMatch(/SameSite=Lax/i);
    expect(sessionCookie ?? '').not.toMatch(/;\s*Secure/i);

    const session = await agent.get('/api/auth/session').expect(200);
    expect(session.body.authenticated).toBe(true);

    await agent.post('/api/auth/logout').expect(204);

    await agent.get('/api/products').expect(401);
    const afterLogout = await agent.get('/api/auth/session').expect(200);
    expect(afterLogout.body).toEqual({
      multiUser: true,
      authenticated: false,
      user: null,
    });
  });

  it('marks the session cookie Secure when cookieSecure is enabled', async () => {
    const secureApp = createApp({
      service,
      auth,
      multiUser: true,
      cookieSecure: true,
    });
    const agent = request.agent(secureApp);
    await register(agent, 'secure@example.com');

    const response = await agent
      .post('/api/auth/login')
      .send({ email: 'secure@example.com', password: 'secret' })
      .expect(200);

    const rawCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? (rawCookie as string[]) : [];
    const sessionCookie = cookies.find((cookie) =>
      cookie.startsWith('lazentinel_session='),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie ?? '').toMatch(/;\s*Secure/i);
    expect(sessionCookie ?? '').toMatch(/HttpOnly/);
  });

  it('returns 401 for wrong credentials and for every protected endpoint when signed out', async () => {
    const agent = request.agent(app);
    await register(agent, 'alice@example.com');

    const wrong = await agent
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrong' })
      .expect(401);
    expect(wrong.body).toEqual({ error: 'Invalid email or password.' });

    const signedOut = request.agent(app);
    await signedOut.get('/api/products').expect(401);
    await signedOut
      .post('/api/products')
      .send({ url: DEFAULT_PRODUCT_URL })
      .expect(401);
    await signedOut.get('/api/settings').expect(401);
    await signedOut
      .put('/api/settings')
      .send({ trackingIntervalSeconds: 60 })
      .expect(401);
  });

  it('scopes products per account while allowing both accounts to track the same URL', async () => {
    const alice = request.agent(app);
    const bob = request.agent(app);
    await registerAndLogin(alice, 'alice@example.com', 'alice-password');
    await registerAndLogin(bob, 'bob@example.com', 'bob-password');

    const aliceCreated = await alice
      .post('/api/products')
      .send({ url: DEFAULT_PRODUCT_URL })
      .expect(201);
    const bobCreated = await bob
      .post('/api/products')
      .send({ url: DEFAULT_PRODUCT_URL })
      .expect(201);
    const aliceId = aliceCreated.body.product.id as number;
    const bobId = bobCreated.body.product.id as number;
    expect(aliceId).not.toBe(bobId);

    const aliceList = await alice.get('/api/products').expect(200);
    const bobList = await bob.get('/api/products').expect(200);
    expect(aliceList.body.products.map((product: { id: number }) => product.id)).toEqual([
      aliceId,
    ]);
    expect(bobList.body.products.map((product: { id: number }) => product.id)).toEqual([
      bobId,
    ]);
    expectNoOwnerFields(aliceList.body.products[0] as Record<string, unknown>);
    expectNoOwnerFields(bobList.body.products[0] as Record<string, unknown>);

    await alice
      .post('/api/products')
      .send({ url: DEFAULT_PRODUCT_URL })
      .expect(409);

    await bob.delete(`/api/products/${aliceId}`).expect(404);
    await bob.post(`/api/products/${aliceId}/refresh`).expect(404);

    const aliceAfter = await alice.get('/api/products').expect(200);
    expect(aliceAfter.body.products.map((product: { id: number }) => product.id)).toEqual([
      aliceId,
    ]);
    expect(db.getProduct(aliceId)).not.toBeNull();
  });

  it('does not expose a settings update endpoint to authenticated owners', async () => {
    const alice = request.agent(app);
    await registerAndLogin(alice, 'alice@example.com');

    const response = await alice
      .put('/api/settings')
      .send({ trackingIntervalSeconds: 60 })
      .expect(404);
    expect(response.body).toEqual({ error: 'API route not found.' });

    const readBack = await alice.get('/api/settings').expect(200);
    expect(readBack.body).toEqual({ trackingIntervalSeconds: 300 });
  });

  it('hides legacy owner-0 products from authenticated accounts without deleting them', async () => {
    const legacy = db.createProduct(
      {
        url: 'https://www.lazada.sg/products/legacy-i1.html',
        title: 'Legacy Product',
        currency: 'SGD',
      },
      50,
      0,
    );

    const alice = request.agent(app);
    await registerAndLogin(alice, 'alice@example.com');

    const list = await alice.get('/api/products').expect(200);
    expect(list.body.products).toEqual([]);
    expect(db.getProduct(legacy.id)).toMatchObject({ id: legacy.id, userId: 0 });
    expect(db.listProducts(0).map((product) => product.id)).toEqual([legacy.id]);
  });
});
