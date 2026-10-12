import orm from '../entity/orm';
import account from '../entity/account';
import sharedMailboxMember from '../entity/shared-mailbox-member';
import user from '../entity/user';
import email from '../entity/email';
import BizError from '../error/biz-error';
import verifyUtils from '../utils/verify-utils';
import settingService from './setting-service';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { isDel, userConst } from '../const/entity-const';

const sharedMailboxService = {
	assertAdmin(c) {
		if (c.get('user').email !== c.env.admin) {
			throw new BizError('Administrator access required', 403);
		}
	},

	async list(c) {
		this.assertAdmin(c);
		return orm(c).select().from(account).where(eq(account.shared, 1)).all();
	},

	async listForUser(c, userId) {
		if (c.get('user').email === c.env.admin) {
			return orm(c).select().from(account).where(and(eq(account.shared, 1), eq(account.isDel, isDel.NORMAL))).all();
		}
		return orm(c).select({ account }).from(account)
			.innerJoin(sharedMailboxMember, eq(sharedMailboxMember.accountId, account.accountId))
			.where(and(eq(sharedMailboxMember.userId, userId), eq(account.shared, 1), eq(account.isDel, isDel.NORMAL)))
			.all().then(rows => rows.map(row => row.account));
	},

	async create(c, params) {
		this.assertAdmin(c);
		const email = String(params.email || '').trim().toLowerCase();
		const name = String(params.name || '').trim();
		const { domainList } = await settingService.query(c);
		if (!verifyUtils.isEmail(email) || !domainList.some(domain => '@' + email.split('@')[1] === domain.toLowerCase())) {
			throw new BizError('Invalid shared mailbox address', 400);
		}
		if (name.length > 30) {
			throw new BizError('Mailbox name is too long', 400);
		}
		const existing = await orm(c).select({ accountId: account.accountId }).from(account)
			.where(sql`${account.email} COLLATE NOCASE = ${email}`).get();
		const existingUser = await orm(c).select({ userId: user.userId }).from(user)
			.where(sql`${user.email} COLLATE NOCASE = ${email}`).get();
		if (existing || existingUser) {
			throw new BizError('Address already exists', 409);
		}
		try {
			return await orm(c).insert(account).values({ email, name: name || email.split('@')[0], userId: 0, shared: 1 }).returning().get();
		} catch (error) {
			if (String(error.message).includes('UNIQUE')) throw new BizError('Address already exists', 409);
			throw error;
		}
	},

	async setActive(c, accountId, active) {
		this.assertAdmin(c);
		const row = await this.getShared(c, accountId);
		if (!row) throw new BizError('Shared mailbox not found', 404);
		await orm(c).update(account).set({ isDel: active ? isDel.NORMAL : isDel.DELETE })
			.where(eq(account.accountId, row.accountId)).run();
	},

	async members(c, accountId) {
		this.assertAdmin(c);
		const row = await this.getShared(c, accountId);
		if (!row) throw new BizError('Shared mailbox not found', 404);
		return orm(c).select({ userId: user.userId, email: user.email })
			.from(sharedMailboxMember).innerJoin(user, eq(user.userId, sharedMailboxMember.userId))
			.where(eq(sharedMailboxMember.accountId, row.accountId)).all();
	},

	async grant(c, accountId, userEmail) {
		this.assertAdmin(c);
		const row = await this.getShared(c, accountId);
		if (!row || row.isDel !== isDel.NORMAL) throw new BizError('Shared mailbox not found', 404);
		const member = await orm(c).select({ userId: user.userId }).from(user)
			.where(and(sql`${user.email} COLLATE NOCASE = ${String(userEmail || '').trim()}`, eq(user.isDel, isDel.NORMAL), eq(user.status, userConst.status.NORMAL))).get();
		if (!member) throw new BizError('User not found', 404);
		await orm(c).insert(sharedMailboxMember).values({ accountId: row.accountId, userId: member.userId }).onConflictDoNothing().run();
	},

	async revoke(c, accountId, userId) {
		this.assertAdmin(c);
		const row = await this.getShared(c, accountId);
		if (!row) throw new BizError('Shared mailbox not found', 404);
		await orm(c).delete(sharedMailboxMember).where(and(
			eq(sharedMailboxMember.accountId, row.accountId), eq(sharedMailboxMember.userId, Number(userId))
		)).run();
	},

	async removeUsers(c, userIds) {
		if (!userIds.length) return;
		await orm(c).delete(sharedMailboxMember).where(inArray(sharedMailboxMember.userId, userIds)).run();
	},

	getShared(c, accountId) {
		const id = Number(accountId);
		if (!Number.isSafeInteger(id) || id < 1) return null;
		return orm(c).select().from(account).where(and(eq(account.accountId, id), eq(account.shared, 1))).get();
	},

	async hasAccess(c, accountId, userId) {
		const row = await this.getShared(c, accountId);
		if (!row || row.isDel !== isDel.NORMAL) return false;
		if (c.get('user').email === c.env.admin) return true;
		const member = await orm(c).select({ userId: sharedMailboxMember.userId }).from(sharedMailboxMember)
			.where(and(eq(sharedMailboxMember.accountId, row.accountId), eq(sharedMailboxMember.userId, userId))).get();
		return !!member;
	},

	async requireAccess(c, accountId, userId) {
		if (!await this.hasAccess(c, accountId, userId)) {
			throw new BizError('Shared mailbox access denied', 403);
		}
	},

	async canManageEmails(c, emailIds, userId) {
		if (!emailIds.length || emailIds.some(id => !Number.isSafeInteger(id) || id < 1)) return false;
		const rows = await orm(c).select({ accountId: email.accountId, userId: email.userId }).from(email)
			.where(inArray(email.emailId, emailIds)).all();
		if (rows.length !== new Set(emailIds).size) return false;
		for (const row of rows) {
			if (row.userId !== 0 || !await this.hasAccess(c, row.accountId, userId)) return false;
		}
		return true;
	}
};

export default sharedMailboxService;
