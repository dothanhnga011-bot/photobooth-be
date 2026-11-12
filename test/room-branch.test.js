import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { Room, User } from '../src/models/index.js';

let memory, admin, owner;
const room = name => ({ name, description: '', kind: 'polaroid', flip: 'on', active: true });
before(async () => {
  config.secret = 'room-form-test-secret-not-for-production';
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  owner = await User.create({ name: 'Admin', email: 'rooms@test.local', role: 'admin', active: true,
    password: await bcrypt.hash('TestPassword!123', 10) });
  admin = request.agent(app);
  await admin.post('/api/auth/login').send({ email: owner.email, password: 'TestPassword!123' }).expect(200);
});
beforeEach(async () => {
  await Room.deleteMany({});
  await User.updateOne({ _id: owner._id }, { branch: '' });
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });

test('the first machine can be created without a branch field', async () => {
  const created = (await admin.post('/api/admin/rooms').send(room('Máy đầu tiên')).expect(200)).body;
  assert.equal(created.branch, 'Mặc định');
  assert.equal(created.kind, 'polaroid');
});

test('new machines inherit an active machine, while edits without a branch preserve the stored value', async () => {
  await Room.create({ ...room('Máy đã ngừng'), branch: 'Cũ', active: false });
  const existing = await Room.create({ ...room('Máy đang chạy'), branch: 'HN' });
  const created = (await admin.post('/api/admin/rooms').send(room('Máy mới')).expect(200)).body;
  assert.equal(created.branch, 'HN');
  const edited = (await admin.put(`/api/admin/rooms/${existing._id}`)
    .send({ ...room('Đổi tên máy'), description: 'Đã chỉnh sửa' }).expect(200)).body;
  assert.equal(edited.branch, 'HN');
  assert.equal(edited.description, 'Đã chỉnh sửa');
  const legacy = (await admin.post('/api/admin/rooms').send({ ...room('Client cũ'), branch: 'HCM' }).expect(200)).body;
  assert.equal(legacy.branch, 'HCM');
});

test('the admin account branch takes precedence when creating a machine without a branch', async () => {
  await User.updateOne({ _id: owner._id }, { branch: 'HCM' });
  await Room.create({ ...room('Máy cơ sở khác'), branch: 'HN' });
  const created = (await admin.post('/api/admin/rooms').send(room('Máy theo tài khoản')).expect(200)).body;
  assert.equal(created.branch, 'HCM');
});
