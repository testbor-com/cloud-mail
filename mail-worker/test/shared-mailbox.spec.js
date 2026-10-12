import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbInit } from '../src/init/init';
import sharedMailboxService from '../src/service/shared-mailbox-service';
import emailService from '../src/service/email-service';
import attService from '../src/service/att-service';
import r2Service from '../src/service/r2-service';
import { email as receiveEmail } from '../src/email/email';
import kvConst from '../src/const/kv-const';
import app from '../src/hono/webs';
import jwtUtils from '../src/utils/jwt-utils';
import publicService from '../src/service/public-service';

const admin = { userId: 1, email: 'admin@example.com' };
const alice = { userId: 2, email: 'alice@example.com' };
const bob = { userId: 3, email: 'bob@example.com' };
const carol = { userId: 4, email: 'carol@example.com' };
const context = currentUser => ({
	env,
	get: key => key === 'user' ? currentUser : key === 'setting' ? {
		domainList: ['@example.com'], send: 0, resendTokens: {}, r2Domain: '', noRecipient: 1
	} : undefined
});

beforeAll(async () => {
	await env.db.prepare(`CREATE TABLE account (
		account_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
		status INTEGER NOT NULL DEFAULT 0, latest_email_time TEXT, create_time TEXT DEFAULT CURRENT_TIMESTAMP,
		user_id INTEGER NOT NULL, all_receive INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
		is_del INTEGER NOT NULL DEFAULT 0
	)`).run();
	await env.db.prepare(`CREATE UNIQUE INDEX idx_account_email_nocase ON account(email COLLATE NOCASE)`).run();
	await dbInit.v3_4DB({ env });
	await dbInit.v3_4DB({ env });
	await env.db.prepare(`CREATE TABLE user (user_id INTEGER PRIMARY KEY, email TEXT NOT NULL,
		type INTEGER NOT NULL DEFAULT 1, password TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL DEFAULT '',
		status INTEGER NOT NULL DEFAULT 0, create_time TEXT DEFAULT CURRENT_TIMESTAMP, active_time TEXT,
		create_ip TEXT, active_ip TEXT, os TEXT, browser TEXT, device TEXT, sort TEXT DEFAULT '0',
		send_count TEXT DEFAULT '0', reg_key_id INTEGER NOT NULL DEFAULT 0,
		is_del INTEGER NOT NULL DEFAULT 0)`).run();
	await env.db.prepare(`CREATE TABLE role (role_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
		key TEXT NOT NULL, description TEXT, ban_email TEXT NOT NULL DEFAULT '',
		ban_email_type INTEGER NOT NULL DEFAULT 0, avail_domain TEXT DEFAULT '', sort INTEGER,
		is_default INTEGER DEFAULT 0, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		user_id INTEGER, send_count INTEGER, send_type TEXT DEFAULT 'count', account_count INTEGER)`).run();
	await env.db.prepare(`INSERT INTO role(role_id, name, key, send_type) VALUES (1, 'Restricted', 'restricted', 'ban')`).run();
	await env.db.prepare(`CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
		perm_key TEXT, pid INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 2, sort INTEGER)`).run();
	await env.db.prepare(`CREATE TABLE role_perm (id INTEGER PRIMARY KEY, role_id INTEGER, perm_id INTEGER)`).run();
	await env.db.prepare(`CREATE TABLE email (
		email_id INTEGER PRIMARY KEY, send_email TEXT, name TEXT, account_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL, subject TEXT, code TEXT NOT NULL DEFAULT '', text TEXT,
		content TEXT, cc TEXT DEFAULT '[]', bcc TEXT DEFAULT '[]', recipient TEXT,
		to_email TEXT NOT NULL DEFAULT '', to_name TEXT NOT NULL DEFAULT '', in_reply_to TEXT DEFAULT '',
		relation TEXT DEFAULT '', message_id TEXT DEFAULT '', type INTEGER NOT NULL DEFAULT 0,
		status INTEGER NOT NULL DEFAULT 0, resend_email_id TEXT, message TEXT,
		unread INTEGER NOT NULL DEFAULT 0, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		is_del INTEGER NOT NULL DEFAULT 0
	)`).run();
	await env.db.prepare(`CREATE TABLE star (star_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL, email_id INTEGER NOT NULL)`).run();
	await env.db.prepare(`CREATE TABLE attachments (att_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL, email_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
		key TEXT NOT NULL, filename TEXT, mime_type TEXT, size INTEGER,
		status INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0,
		disposition TEXT, related TEXT, content_id TEXT, encoding TEXT,
		create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
	for (const person of [admin, alice, bob, carol]) {
		await env.db.prepare('INSERT INTO user(user_id, email) VALUES (?, ?)').bind(person.userId, person.email).run();
	}
});

describe('shared mailbox access', () => {
	it('creates one address, grants access, revokes it immediately, and archives it', async () => {
		const adminContext = context(admin);
		const mailbox = await sharedMailboxService.create(adminContext, { email: 'Info@Example.com', name: 'Info' });
		expect(mailbox.email).toBe('info@example.com');
		await expect(sharedMailboxService.create(adminContext, { email: 'INFO@example.com' })).rejects.toMatchObject({ code: 409 });
		await expect(sharedMailboxService.create(adminContext, { email: admin.email })).rejects.toMatchObject({ code: 409 });
		await expect(sharedMailboxService.create(context(alice), { email: 'sales@example.com' })).rejects.toMatchObject({ code: 403 });
		await sharedMailboxService.grant(adminContext, mailbox.accountId, alice.email);
		expect(await sharedMailboxService.hasAccess(context(alice), mailbox.accountId, alice.userId)).toBe(true);
		expect(await sharedMailboxService.hasAccess(context(bob), mailbox.accountId, bob.userId)).toBe(false);
		expect((await sharedMailboxService.listForUser(context(alice), alice.userId)).map(row => row.email)).toContain('info@example.com');
		await env.db.prepare('INSERT INTO email(email_id, account_id, user_id) VALUES (1, ?, 0)').bind(mailbox.accountId).run();
		const inbox = await emailService.list(context(alice), { accountId: mailbox.accountId, type: 0, size: 10, full: 0 }, alice.userId);
		expect(inbox.list.map(row => row.emailId)).toEqual([1]);
		await expect(emailService.list(context(bob), { accountId: mailbox.accountId, type: 0, size: 10, full: 0 }, bob.userId)).rejects.toMatchObject({ code: 403 });
		expect((await emailService.thread(context(alice), { emailId: 1 }, alice.userId)).map(row => row.emailId)).toEqual([1]);
		await expect(emailService.thread(context(bob), { emailId: 1 }, bob.userId)).rejects.toMatchObject({ code: 403 });
		await emailService.requireEmailAccess(context(alice), [1], alice.userId);
		await expect(emailService.requireEmailAccess(context(bob), [1], bob.userId)).rejects.toMatchObject({ code: 403 });
		await sharedMailboxService.revoke(adminContext, mailbox.accountId, alice.userId);
		await expect(emailService.requireEmailAccess(context(alice), [1], alice.userId)).rejects.toMatchObject({ code: 403 });
		await sharedMailboxService.grant(adminContext, mailbox.accountId, alice.email);
		await sharedMailboxService.setActive(adminContext, mailbox.accountId, false);
		expect(await sharedMailboxService.hasAccess(context(alice), mailbox.accountId, alice.userId)).toBe(false);
		await sharedMailboxService.setActive(adminContext, mailbox.accountId, true);
		expect(await sharedMailboxService.hasAccess(context(alice), mailbox.accountId, alice.userId)).toBe(true);
		const key = 'shared/attachments/test-file.txt';
		await attService.addAtt(adminContext, [{
			userId: 0, emailId: 1, accountId: mailbox.accountId, key,
			filename: 'test-file.txt', mimeType: 'text/plain', size: 6,
			content: new TextEncoder().encode('secret')
		}], true);
		const stored = await r2Service.getObj(adminContext, key);
		expect(await stored.text()).not.toBe('secret');
		const response = await attService.getSharedFile(context(alice), key, alice.userId);
		expect(await response.text()).toBe('secret');
		await expect(attService.getSharedFile(context(bob), key, bob.userId)).rejects.toMatchObject({ code: 403 });
		await sharedMailboxService.revoke(adminContext, mailbox.accountId, alice.userId);
		await expect(attService.getSharedFile(context(alice), key, alice.userId)).rejects.toMatchObject({ code: 403 });
	});

	it('stores inbound mail once for all members and permits sending as the shared address', async () => {
		const adminContext = context(admin);
		const mailbox = await sharedMailboxService.create(adminContext, { email: 'sales@example.com' });
		await sharedMailboxService.grant(adminContext, mailbox.accountId, alice.email);
		await sharedMailboxService.grant(adminContext, mailbox.accountId, bob.email);
		await env.kv.put(kvConst.SETTING, JSON.stringify({
			receive: 0, noRecipient: 1, aiCode: 1, emailPrefixFilter: '', r2Domain: '',
			forwardStatus: 1, tgBotStatus: 1, webhookStatus: 1
		}));
		const raw = `From: Customer <customer@outside.test>\r\nTo: sales@example.com\r\nSubject: Question\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello sales`;
		const message = {
			to: mailbox.email,
			from: 'customer@outside.test',
			raw: new Response(raw).body,
			setReject: reason => { throw new Error(reason); }
		};
		await receiveEmail(message, env, {});
		const received = await env.db.prepare('SELECT * FROM email WHERE account_id = ? AND type = 0').bind(mailbox.accountId).all();
		expect(received.results).toHaveLength(1);
		const aliceInbox = await emailService.list(context(alice), { accountId: mailbox.accountId, type: 0, size: 10, full: 0 }, alice.userId);
		const bobInbox = await emailService.list(context(bob), { accountId: mailbox.accountId, type: 0, size: 10, full: 0 }, bob.userId);
		expect(aliceInbox.list[0].emailId).toBe(received.results[0].email_id);
		expect(bobInbox.list[0].emailId).toBe(received.results[0].email_id);
		await expect(emailService.send(context(carol), {
			accountId: mailbox.accountId, receiveEmail: [mailbox.email], content: '', text: 'No', subject: 'No'
		}, carol.userId)).rejects.toMatchObject({ code: 403 });
		const sent = await emailService.send(context(alice), {
			accountId: mailbox.accountId, receiveEmail: [mailbox.email], content: '<p>Reply</p>', text: 'Reply', subject: 'Reply'
		}, alice.userId);
		expect(sent[0].userId).toBe(0);
		expect(sent[0].sendEmail).toBe(mailbox.email);
		const copies = await env.db.prepare('SELECT * FROM email WHERE account_id = ?').bind(mailbox.accountId).all();
		expect(copies.results).toHaveLength(3);
		await env.db.prepare(`INSERT INTO account(email, name, user_id) VALUES ('admin@example.com', 'Admin', 1)`).run();
		const sender = await env.db.prepare(`SELECT account_id FROM account WHERE email = 'admin@example.com'`).first();
		await emailService.send(context(admin), {
			accountId: sender.account_id, receiveEmail: [mailbox.email], content: '<p>Attachment</p>',
			text: 'Attachment', subject: 'File', attachments: [{ filename: 'note.txt', type: 'text/plain', content: btoa('hello') }]
		}, admin.userId);
		const attachedMail = await env.db.prepare(`SELECT email_id FROM email WHERE account_id = ? AND subject = 'File'`).bind(mailbox.accountId).first();
		const attachment = await env.db.prepare('SELECT key FROM attachments WHERE email_id = ?').bind(attachedMail.email_id).first();
		expect(attachment.key.startsWith('shared/attachments/')).toBe(true);
		const stored = await r2Service.getObj(adminContext, attachment.key);
		expect(await stored.text()).not.toBe('hello');
		const file = await attService.getSharedFile(context(alice), attachment.key, alice.userId);
		expect(await file.text()).toBe('hello');
		await env.db.prepare(`INSERT INTO account(email, name, user_id) VALUES ('bob@example.com', 'Bob', 3)`).run();
		await emailService.send(context(alice), {
			accountId: mailbox.accountId, receiveEmail: [bob.email], content: '<p>Shared sender</p>',
			text: 'Shared sender', subject: 'For Bob',
			attachments: [{ filename: 'reply.txt', type: 'text/plain', content: btoa('reply') }]
		}, alice.userId);
		const bobAccount = await env.db.prepare(`SELECT account_id FROM account WHERE email = 'bob@example.com'`).first();
		const personalInbox = await emailService.list(context(bob), { accountId: bobAccount.account_id, type: 0, size: 10, full: 0 }, bob.userId);
		expect(personalInbox.list.map(row => row.subject)).toContain('For Bob');
		const bobFile = await env.db.prepare(`SELECT a.key FROM attachments a JOIN email e ON e.email_id = a.email_id WHERE e.account_id = ? AND e.subject = 'For Bob'`).bind(bobAccount.account_id).first();
		expect(bobFile.key.startsWith('attachments/')).toBe(true);
		const publicCopy = await r2Service.getObj(adminContext, bobFile.key);
		expect(await publicCopy.text()).toBe('reply');
	});

	it('enforces admin and member permissions through the HTTP routes', async () => {
		await env.kv.put(kvConst.SETTING, JSON.stringify({
			receive: 0, send: 0, noRecipient: 1, aiCode: 1, emailPrefixFilter: '',
			resendTokens: {}, r2Domain: '', forwardStatus: 1, tgBotStatus: 1, webhookStatus: 1
		}));
		const auth = async person => {
			const token = `token-${person.userId}`;
			await env.kv.put(kvConst.AUTH_INFO + person.userId, JSON.stringify({
				tokens: [token], user: person, refreshTime: new Date().toISOString()
			}));
			return jwtUtils.generateToken({ env }, { userId: person.userId, token });
		};
		const adminJwt = await auth(admin);
		const aliceJwt = await auth(alice);
		const carolJwt = await auth(carol);
		const request = async (path, jwt, method = 'GET', body) => {
			const response = await app.fetch(new Request('http://example.com' + path, {
				method, headers: { Authorization: jwt, ...(body ? { 'Content-Type': 'application/json' } : {}) },
				...(body ? { body: JSON.stringify(body) } : {})
			}), env, {});
			return response.json();
		};
		expect((await request('/sharedMailbox/create', aliceJwt, 'POST', { email: 'support@example.com' })).code).toBe(403);
		const created = await request('/sharedMailbox/create', adminJwt, 'POST', { email: 'support@example.com' });
		expect(created.code).toBe(200);
		const accountId = created.data.accountId;
		expect((await request('/email/send', carolJwt, 'POST', {
			accountId, receiveEmail: ['support@example.com'], content: '', text: 'No', subject: 'No'
		})).code).toBe(403);
		expect((await request('/sharedMailbox/grant', adminJwt, 'POST', { accountId, userEmail: alice.email })).code).toBe(200);
		const sent = await request('/email/send', aliceJwt, 'POST', {
			accountId, receiveEmail: ['support@example.com'], content: '<p>Hi</p>', text: 'Hi', subject: 'Hi'
		});
		expect(sent.code).toBe(200);
		const list = await request(`/email/list?accountId=${accountId}&type=0&size=10&full=0`, aliceJwt);
		expect(list.data.list).toHaveLength(1);
		const visibleToMember = await emailService.allList(context(alice), { type: 'receive', size: 50, full: 1 });
		const visibleToNonmember = await emailService.allList(context(carol), { type: 'receive', size: 50, full: 1 });
		expect(visibleToMember.list.some(row => row.accountId === accountId)).toBe(true);
		expect(visibleToNonmember.list.some(row => row.accountId === accountId)).toBe(false);
		const publicList = await publicService.emailList({ env }, { toEmail: 'support@example.com' });
		expect(publicList).toHaveLength(0);
		await request(`/sharedMailbox/revoke?accountId=${accountId}&userId=${alice.userId}`, adminJwt, 'DELETE');
		expect((await request(`/email/list?accountId=${accountId}&type=0&size=10&full=0`, aliceJwt)).code).toBe(403);
	});
});
