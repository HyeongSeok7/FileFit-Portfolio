import 'reflect-metadata';
import { randomBytes, randomUUID, createHash, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ArgumentsHost, Body, Catch, Controller, Delete, ExceptionFilter, Get, HttpException, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Pool } from 'pg';
import { ApiError, object, password, positiveInt, rules, title, username, uuid } from './validation';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, max: 10 });
pool.on('error', (error) => console.error('Database connection error:', error));
const scrypt = promisify(rawScrypt);
const authAttempts = new Map<string, { count: number; reset: number }>();

function checkAuthRate(key: string, max = 10) {
  const now = Date.now();
  if (authAttempts.size > 10000) for (const [item, value] of authAttempts) if (value.reset <= now) authAttempts.delete(item);
  const entry = authAttempts.get(key);
  if (!entry || entry.reset <= now) { authAttempts.set(key, { count: 1, reset: now + 15 * 60_000 }); return; }
  if (entry.count >= max) throw new ApiError(429, 'RATE_LIMITED', '시도 횟수가 많습니다. 15분 후 다시 시도해 주세요.', true);
  entry.count++;
}
function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
async function hashPassword(value: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(value: string, stored: string) {
  const [scheme, salt, hex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(value, salt, expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
async function createSession(user: { id: string; username: string }) {
  const token = randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')", [tokenHash(token), user.id]);
  return { token, user };
}
async function authenticate(req: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{30,})$/.exec(req.header('authorization') ?? '');
  if (!match) throw new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
  const hash = tokenHash(match[1]);
  const result = await pool.query<{ id: string; username: string }>('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [hash]);
  if (!result.rows[0]) throw new ApiError(401, 'UNAUTHORIZED', '로그인이 만료되었습니다. 다시 로그인해 주세요.');
  return { ...result.rows[0], tokenHash: hash };
}
function saved(row: Record<string, unknown>) {
  return { id: row.id, title: row.title, rules: row.rules, version: row.version, shareId: row.shareId, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
const columns = 'id, title, rules, version, share_id AS "shareId", created_at AS "createdAt", updated_at AS "updatedAt"';
async function ownerRow(userId: string, id: string) {
  const result = await pool.query(`SELECT ${columns} FROM rule_sets WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', '저장한 조건을 찾을 수 없습니다.');
  return result.rows[0];
}

@Catch()
class JsonErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof ApiError) return response.status(error.status).json({ code: error.code, message: error.message, retryable: error.retryable });
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return response.status(status).json({ code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message: status === 404 ? '요청한 주소를 찾을 수 없습니다.' : '요청 내용을 확인해 주세요.', retryable: false });
    }
    console.error('Unhandled API error:', error);
    return response.status(500).json({ code: 'INTERNAL_ERROR', message: '서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', retryable: true });
  }
}

@Controller('api')
class ApiController {
  @Get('live')
  live() { return { ok: true }; }

  @Get('health')
  async health() { await pool.query('SELECT 1'); return { ok: true }; }

  @Post('auth/register')
  async register(@Body() body: unknown, @Req() req: Request) {
    const input = object(body);
    const name = username(input.username);
    const secret = password(input.password);
    checkAuthRate(`register:${req.ip}`, 20);
    const digest = await hashPassword(secret);
    const user = { id: randomUUID(), username: name };
    try { await pool.query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [user.id, name, digest]); }
    catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'USERNAME_TAKEN', '이미 사용 중인 아이디입니다.');
      throw error;
    }
    return createSession(user);
  }

  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: Request) {
    const input = object(body);
    const name = username(input.username);
    const secret = password(input.password);
    checkAuthRate(`login:${req.ip}:${name}`);
    const result = await pool.query<{ id: string; username: string; password_hash: string }>('SELECT id, username, password_hash FROM users WHERE username = $1', [name]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(secret, user.password_hash))) throw new ApiError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 맞지 않습니다.');
    return createSession({ id: user.id, username: user.username });
  }

  @Get('auth/me')
  async me(@Req() req: Request) { const { id, username: name } = await authenticate(req); return { id, username: name }; }

  @Post('auth/logout')
  async logout(@Req() req: Request) {
    const user = await authenticate(req);
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [user.tokenHash]);
    return { ok: true };
  }

  @Get('rule-sets')
  async list(@Req() req: Request, @Query('q') q?: string, @Query('page') pageText?: string, @Query('limit') limitText?: string) {
    const user = await authenticate(req);
    const page = positiveInt(pageText, 1, 100000);
    const limit = positiveInt(limitText, 6, 50);
    if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw new ApiError(400, 'INVALID_QUERY', '검색어는 100자 이내로 입력해 주세요.');
    const search = `%${(q ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const where = "user_id = $1 AND title ILIKE $2 ESCAPE '\\'";
    const count = await pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM rule_sets WHERE ${where}`, [user.id, search]);
    const items = await pool.query(`SELECT ${columns} FROM rule_sets WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $3 OFFSET $4`, [user.id, search, limit, (page - 1) * limit]);
    return { items: items.rows.map(saved), total: Number(count.rows[0].total), page, limit };
  }

  @Post('rule-sets')
  async create(@Req() req: Request, @Body() body: unknown) {
    const user = await authenticate(req);
    const input = object(body);
    const result = await pool.query(`INSERT INTO rule_sets (id, user_id, title, rules) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${columns}`, [randomUUID(), user.id, title(input.title), JSON.stringify(rules(input.rules))]);
    return saved(result.rows[0]);
  }

  @Get('rule-sets/:id')
  async get(@Req() req: Request, @Param('id') idText: string) {
    const user = await authenticate(req);
    return saved(await ownerRow(user.id, uuid(idText)));
  }

  @Patch('rule-sets/:id')
  async update(@Req() req: Request, @Param('id') idText: string, @Body() body: unknown) {
    const user = await authenticate(req);
    const id = uuid(idText);
    const input = object(body);
    const version = input.expectedVersion;
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw new ApiError(400, 'INVALID_VERSION', '저장한 조건의 버전이 올바르지 않습니다.');
    if (input.title === undefined && input.rules === undefined) throw new ApiError(400, 'INVALID_INPUT', '바꿀 내용을 입력해 주세요.');
    const name = input.title === undefined ? null : title(input.title);
    const criteria = input.rules === undefined ? null : rules(input.rules);
    const result = await pool.query(`UPDATE rule_sets SET title = COALESCE($3, title), rules = COALESCE($4::jsonb, rules), version = version + 1, updated_at = now() WHERE id = $1 AND user_id = $2 AND version = $5 RETURNING ${columns}`, [id, user.id, name, criteria ? JSON.stringify(criteria) : null, version]);
    if (result.rows[0]) return saved(result.rows[0]);
    await ownerRow(user.id, id);
    throw new ApiError(409, 'VERSION_CONFLICT', '다른 곳에서 이 조건을 먼저 수정했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.');
  }

  @Delete('rule-sets/:id')
  async remove(@Req() req: Request, @Param('id') idText: string) {
    const user = await authenticate(req);
    const result = await pool.query('DELETE FROM rule_sets WHERE id = $1 AND user_id = $2 RETURNING id', [uuid(idText), user.id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', '저장한 조건을 찾을 수 없습니다.');
    return { ok: true };
  }

  @Post('rule-sets/:id/share')
  async share(@Req() req: Request, @Param('id') idText: string) {
    const user = await authenticate(req);
    const result = await pool.query('UPDATE rule_sets SET share_id = COALESCE(share_id, $3::uuid) WHERE id = $1 AND user_id = $2 RETURNING share_id AS "shareId"', [uuid(idText), user.id, randomUUID()]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', '저장한 조건을 찾을 수 없습니다.');
    return result.rows[0];
  }

  @Delete('rule-sets/:id/share')
  async unshare(@Req() req: Request, @Param('id') idText: string) {
    const user = await authenticate(req);
    const result = await pool.query('UPDATE rule_sets SET share_id = NULL WHERE id = $1 AND user_id = $2 RETURNING id', [uuid(idText), user.id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', '저장한 조건을 찾을 수 없습니다.');
    return { ok: true };
  }

  @Get('shared/:id')
  async shared(@Param('id') idText: string) {
    const result = await pool.query('SELECT title, rules, updated_at AS "updatedAt" FROM rule_sets WHERE share_id = $1', [uuid(idText)]);
    if (!result.rows[0]) throw new ApiError(404, 'SHARE_NOT_FOUND', '공유 링크가 없거나 더는 사용할 수 없습니다.');
    return result.rows[0];
  }
}

@Module({ controllers: [ApiController] })
class ApiModule {}

async function bootstrap() {
  const app = await NestFactory.create(ApiModule, { bodyParser: true });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalFilters(new JsonErrorFilter());
  const origins = (process.env.FRONTEND_ORIGIN ?? '').split(',').map((item) => item.trim().replace(/\/$/, '')).filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'], credentials: false });
  const port = Number(process.env.PORT || 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`Filefit API listening on ${port}`);
}
bootstrap().catch((error) => { console.error(error); process.exitCode = 1; void pool.end(); });
