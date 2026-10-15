import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const base = process.env.API_URL || 'http://127.0.0.1:3001';
const suffix = randomBytes(5).toString('hex');
const pass = `smoke-pass-${suffix}-123`;
const rules = { formats: ['JPG', 'PDF', 'DOCX'], minEachBytes: null, maxEachBytes: 5_000_000, maxTotalBytes: null, maxFiles: 3, maxPages: null, width: 1200, height: 1600 };

async function call(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

const health = await call('/api/health');
assert.equal(health.status, 200);
assert.equal(health.data.ok, true);
assert.equal((await call('/api/live')).data.ok, true);
const first = await call('/api/auth/register', { method: 'POST', body: { username: `smoke_${suffix}`, password: pass } });
assert.equal(first.status, 201);
assert.ok(first.data.token);
const second = await call('/api/auth/register', { method: 'POST', body: { username: `other_${suffix}`, password: pass } });
assert.equal(second.status, 201);
const token = first.data.token;
const otherToken = second.data.token;
assert.equal((await call('/api/auth/me', { token })).data.username, `smoke_${suffix}`);
assert.equal((await call('/api/rule-sets')).status, 401);
const invalid = await call('/api/rule-sets', { method: 'POST', token, body: { title: 'bad', rules: { ...rules, width: -1 } } });
assert.equal(invalid.status, 400);
assert.equal(invalid.data.code, 'INVALID_RULES');
const empty = await call('/api/rule-sets', { method: 'POST', token, body: { title: 'empty', rules: { formats: [], minEachBytes: null, maxEachBytes: null, maxTotalBytes: null, maxFiles: null, maxPages: null, width: null, height: null } } });
assert.equal(empty.status, 400);
assert.equal(empty.data.code, 'EMPTY_RULES');
const created = await call('/api/rule-sets', { method: 'POST', token, body: { title: '지원서 사진', rules } });
assert.equal(created.status, 201);
assert.equal(created.data.version, 1);
const id = created.data.id;
assert.equal((await call(`/api/rule-sets/${id}`, { token: otherToken })).status, 404);
const list = await call('/api/rule-sets?q=%EC%A7%80%EC%9B%90&page=1&limit=6', { token });
assert.equal(list.data.total, 1);
assert.equal(list.data.items[0].id, id);
const update = await call(`/api/rule-sets/${id}`, { method: 'PATCH', token, body: { title: '입사지원 사진', rules, expectedVersion: 1 } });
assert.equal(update.status, 200);
assert.equal(update.data.version, 2);
const conflict = await call(`/api/rule-sets/${id}`, { method: 'PATCH', token, body: { title: '덮어쓰기', expectedVersion: 1 } });
assert.equal(conflict.status, 409);
assert.equal(conflict.data.code, 'VERSION_CONFLICT');
const share = await call(`/api/rule-sets/${id}/share`, { method: 'POST', token });
assert.equal(share.status, 201);
assert.ok(share.data.shareId);
const publicRule = await call(`/api/shared/${share.data.shareId}`);
assert.equal(publicRule.data.title, '입사지원 사진');
assert.deepEqual(publicRule.data.rules, rules);
assert.equal((await call(`/api/rule-sets/${id}/share`, { method: 'DELETE', token })).status, 200);
assert.equal((await call(`/api/shared/${share.data.shareId}`)).status, 404);
assert.equal((await call(`/api/rule-sets/${id}`, { method: 'DELETE', token: otherToken })).status, 404);
assert.equal((await call(`/api/rule-sets/${id}`, { method: 'DELETE', token })).status, 200);
assert.equal((await call('/api/submissions')).status, 401);
const invalidSubmission = await call('/api/submissions', { method: 'POST', token, body: { title: '지원', dueDate: '2026-02-30' } });
assert.equal(invalidSubmission.status, 400);
const submission = await call('/api/submissions', { method: 'POST', token, body: {
  title: '웹 개발자 지원', destination: '테스트 회사', dueDate: '2026-12-31', status: 'preparing',
  checklist: [{ id: 'resume', label: '이력서', done: false }],
} });
assert.equal(submission.status, 201);
assert.equal(submission.data.version, 1);
assert.equal(submission.data.checklist[0].label, '이력서');
assert.equal(submission.data.fileNameRule, '');
const submissionId = submission.data.id;
assert.equal((await call(`/api/submissions/${submissionId}`, { token: otherToken })).status, 404);
const submissionList = await call('/api/submissions?q=%ED%85%8C%EC%8A%A4%ED%8A%B8&page=1&limit=6', { token });
assert.equal(submissionList.status, 200);
assert.equal(submissionList.data.total, 1);
assert.equal(submissionList.data.items[0].id, submissionId);
const submissionUpdate = await call(`/api/submissions/${submissionId}`, { method: 'PATCH', token, body: {
  status: 'ready', checklist: [{ id: 'resume', label: '이력서', done: true }], expectedVersion: 1,
} });
assert.equal(submissionUpdate.status, 200);
assert.equal(submissionUpdate.data.version, 2);
assert.equal(submissionUpdate.data.checklist[0].done, true);
const submissionConflict = await call(`/api/submissions/${submissionId}`, { method: 'PATCH', token, body: { title: '충돌', expectedVersion: 1 } });
assert.equal(submissionConflict.status, 409);
assert.equal(submissionConflict.data.code, 'VERSION_CONFLICT');
const planInput = {
  submission: {
    title: '공고에서 만든 지원 계획', destination: '테스트 기관', dueDate: '2026-11-30', status: 'preparing',
    checklist: [{ id: 'resume', label: '이력서', done: false }, { id: 'portfolio', label: '포트폴리오', done: false }],
  },
  ruleSet: { title: '테스트 기관 제출 조건', rules },
  fileNameRule: '지원자명_서류명.pdf',
};
assert.equal((await call('/api/notice-plans', { method: 'POST', body: planInput })).status, 401);
const invalidPlan = await call('/api/notice-plans', { method: 'POST', token, body: { ...planInput, noticeText: '서버에 보내지 않음' } });
assert.equal(invalidPlan.status, 400);
assert.equal(invalidPlan.data.code, 'INVALID_NOTICE_PLAN');
const plan = await call('/api/notice-plans', { method: 'POST', token, body: planInput });
assert.equal(plan.status, 201);
assert.equal(plan.data.submission.title, planInput.submission.title);
assert.equal(plan.data.submission.fileNameRule, planInput.fileNameRule);
assert.equal(plan.data.submission.ruleSetId, plan.data.ruleSet.id);
assert.deepEqual(plan.data.ruleSet.rules, rules);
assert.equal((await call(`/api/submissions/${plan.data.submission.id}`, { token: otherToken })).status, 404);
assert.equal((await call(`/api/rule-sets/${plan.data.ruleSet.id}`, { token: otherToken })).status, 404);
assert.equal((await call(`/api/submissions/${plan.data.submission.id}`, { token })).data.ruleSetId, plan.data.ruleSet.id);
const editedPlan = await call(`/api/submissions/${plan.data.submission.id}`, { method: 'PATCH', token, body: { expectedVersion: 1, fileNameRule: '지원자명-서류명.pdf' } });
assert.equal(editedPlan.status, 200);
assert.equal(editedPlan.data.fileNameRule, '지원자명-서류명.pdf');
const planWithoutRules = await call('/api/notice-plans', { method: 'POST', token, body: { ...planInput, ruleSet: null } });
assert.equal(planWithoutRules.status, 201);
assert.equal(planWithoutRules.data.ruleSet, null);
assert.equal(planWithoutRules.data.submission.ruleSetId, null);
assert.equal((await call(`/api/rule-sets/${plan.data.ruleSet.id}`, { method: 'DELETE', token })).status, 200);
assert.equal((await call(`/api/submissions/${plan.data.submission.id}`, { token })).data.ruleSetId, null);
assert.equal((await call(`/api/submissions/${plan.data.submission.id}`, { method: 'DELETE', token })).status, 200);
assert.equal((await call(`/api/submissions/${planWithoutRules.data.submission.id}`, { method: 'DELETE', token })).status, 200);
assert.equal((await call(`/api/submissions/${submissionId}`, { method: 'DELETE', token: otherToken })).status, 404);
assert.equal((await call(`/api/submissions/${submissionId}`, { method: 'DELETE', token })).status, 200);
assert.equal((await call('/api/auth/logout', { method: 'POST', token })).status, 201);
assert.equal((await call('/api/auth/me', { token })).status, 401);
const login = await call('/api/auth/login', { method: 'POST', body: { username: `smoke_${suffix}`, password: pass } });
assert.equal(login.status, 201);
console.log('API smoke test passed: auth, rules, submission cases, notice plans, validation, ownership, version conflict, share and revocation.');
