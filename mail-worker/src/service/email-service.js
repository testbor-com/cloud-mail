import orm from '../entity/orm';
import email from '../entity/email';
import { emailListColumns, emailBriefColumns, EMAIL_LIST_TEXT_LEN } from '../lib/email-list-columns';
import { attConst, emailConst, isDel, settingConst } from '../const/entity-const';
import { and, desc, eq, gt, inArray, notInArray, lt, count, asc, sql, ne, or, like, lte, gte } from 'drizzle-orm';
import { star } from '../entity/star';
import settingService from './setting-service';
import accountService from './account-service';
import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import { Resend } from 'resend';
import attService from './att-service';
import { parseHTML } from 'linkedom';
import userService from './user-service';
import roleService from './role-service';
import user from '../entity/user';
import starService from './star-service';
import dayjs from 'dayjs';
import kvConst from '../const/kv-const';
import { t } from '../i18n/i18n'
import domainUtils from '../utils/domain-uitls';
import account from "../entity/account";
import { att } from '../entity/att';
import telegramService from './telegram-service';
import sharedMailboxService from './shared-mailbox-service';

const emailService = {

	async list(c, params, userId) {

		let { emailId, type, accountId, size, timeSort, allReceive, full } = params;

		size = Number(size);
		type = Number(type);
		emailId = Number(emailId) || 0;
		timeSort = Number(timeSort);
		accountId = Number(accountId);
		allReceive = Number(allReceive);
		full = Number(full);

		if (isNaN(type)) {
			type = 0;
		}

		if (isNaN(accountId)) {
			throw new BizError(t('emptyAccountId'));
		}

		if (isNaN(size)) {
			size = 10;
		}

		if (isNaN(full)) {
			full = 1;
		}

		full = full === 1;

		if (size > 50) {
			size = 50;
		}

		const accountRow = await accountService.selectById(c, accountId);
		if (isNaN(allReceive)) allReceive = accountRow?.allReceive || 0;
		const shared = accountRow?.shared === 1;
		if (shared) {
			await sharedMailboxService.requireAccess(c, accountId, userId);
			allReceive = 0;
		}

		const ownerId = shared ? 0 : userId;
		const filters = this.emailListFilters({ userId: ownerId, accountId, type, allReceive, emailId, timeSort });
		const countFilters = this.emailListFilters({ userId: ownerId, accountId, type, allReceive, withCursor: false });
		const columns = full ? emailListColumns : emailBriefColumns;

		const query = orm(c)
			.select({
				...columns,
				starId: star.starId
			})
			.from(email)
			.leftJoin(
				star,
				and(
					eq(star.emailId, email.emailId),
					eq(star.userId, userId)
				)
			)
			.innerJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(and(...filters));

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = query.limit(size).all();

		const totalQuery = orm(c).select({ total: count() }).from(email)
			.innerJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(and(...countFilters))
			.get();

		const latestEmailQuery = orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId,
		}).from(email).where(
			and(
				eq(email.userId, ownerId),
				eq(email.type, type),
				eq(email.isDel, isDel.NORMAL),
				allReceive ? undefined : eq(email.accountId, accountId)
			))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		list = list.map(item => ({
			...item,
			isStar: item.starId != null ? 1 : 0
		}));

		if (full) {
			await this.emailAddAtt(c, list);
		} else {
			this.applyListText(list);
		}

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: accountId,
				userId: ownerId,
			}
		}

		return { list, total: totalRow.total, latestEmail };
	},

	toListText(item) {
		const raw = emailUtils.formatText(item.text) || emailUtils.htmlToText(item.content);
		return raw.replace(/\s+/g, ' ').trim().slice(0, EMAIL_LIST_TEXT_LEN);
	},

	applyListText(list) {
		for (const item of list) {
			item.listText = this.toListText(item);
			delete item.text;
			delete item.content;
		}
		return list;
	},

	emailListFilters({ userId, accountId, type, allReceive, emailId, timeSort, withCursor = true }) {
		const conditions = [
			eq(email.userId, userId),
			eq(email.type, type),
			eq(email.isDel, isDel.NORMAL),
			eq(account.isDel, isDel.NORMAL),
		];
		if (!allReceive) {
			conditions.push(eq(email.accountId, accountId));
		}
		if (withCursor && emailId) {
			conditions.push(timeSort ? gt(email.emailId, emailId) : lt(email.emailId, emailId));
		}
		return conditions;
	},

	async thread(c, params, userId, admin = false) {
		const emailId = Number(params.emailId);
		if (!Number.isSafeInteger(emailId) || emailId < 1) {
			throw new BizError(t('notExistEmail'), 404);
		}

		const selected = await orm(c).select().from(email).where(and(
			eq(email.emailId, emailId),
			admin ? undefined : eq(email.isDel, isDel.NORMAL)
		)).get();
		if (!selected) {
			throw new BizError(t('notExistEmail'), 404);
		}
		const shared = selected.accountId > 0 && !!(await sharedMailboxService.getShared(c, selected.accountId));
		if (shared && (!admin || c.get('user').email !== c.env.admin)) {
			await sharedMailboxService.requireAccess(c, selected.accountId, userId);
		} else if (!admin && selected.userId !== userId) {
			throw new BizError(t('notExistEmail'), 404);
		}

		const ownerId = selected.userId;
		const messages = new Map([[selected.emailId, selected]]);
		const searched = new Set();
		const pending = new Set([
			selected.messageId,
			selected.inReplyTo,
			...this.messageReferences(selected.relation)
		].filter(Boolean));

		while (pending.size) {
			const ids = [...pending].slice(0, 50);
			ids.forEach(id => {
				pending.delete(id);
				searched.add(id);
			});
			const rows = await orm(c).select().from(email).where(and(
				eq(email.userId, ownerId),
				shared ? eq(email.accountId, selected.accountId) : undefined,
				admin ? undefined : eq(email.isDel, isDel.NORMAL),
				or(
					inArray(email.messageId, ids),
					inArray(email.inReplyTo, ids),
					...ids.map(id => sql`instr(${email.relation}, ${id}) > 0`)
				)
			)).all();

			for (const row of rows) {
				if (messages.has(row.emailId)) continue;
				const references = this.messageReferences(row.relation);
				if (!ids.includes(row.messageId) && !ids.includes(row.inReplyTo) &&
					!references.some(id => ids.includes(id))) continue;
				messages.set(row.emailId, row);
				for (const id of [row.messageId, row.inReplyTo, ...references]) {
					if (id && !searched.has(id)) pending.add(id);
				}
			}
		}

		const list = [...messages.values()].sort((a, b) =>
			a.createTime.localeCompare(b.createTime) || a.emailId - b.emailId);
		await this.emailAddAtt(c, list);
		if (!admin) {
			const stars = await orm(c).select({ emailId: star.emailId }).from(star)
				.where(and(eq(star.userId, userId), inArray(star.emailId, [...messages.keys()]))).all();
			const starred = new Set(stars.map(item => item.emailId));
			list.forEach(item => item.isStar = starred.has(item.emailId) ? 1 : 0);
		}
		return list;
	},

	messageReferences(value) {
		if (!value) return [];
		const references = String(value).match(/<[^>]+>/g);
		return references || String(value).split(/\s+/).filter(Boolean);
	},

	allEmailListFilters({ emailId, name, subject, accountEmail, userEmail, type, timeSort, withCursor = true }) {
		const conditions = [];

		if (type === 'send') {
			conditions.push(eq(email.type, emailConst.type.SEND));
		}

		if (type === 'receive') {
			conditions.push(eq(email.type, emailConst.type.RECEIVE));
		}

		if (type === 'delete') {
			conditions.push(eq(email.isDel, isDel.DELETE));
		}

		if (type === 'noone') {
			conditions.push(eq(email.status, emailConst.status.NOONE));
		}

		if (userEmail) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${userEmail + '%'}`);
		}

		if (accountEmail) {
			conditions.push(
				or(
					sql`${email.toEmail} COLLATE NOCASE LIKE ${accountEmail + '%'}`,
					sql`${email.sendEmail} COLLATE NOCASE LIKE ${accountEmail + '%'}`,
				)
			);
		}

		if (name) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${name + '%'}`);
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${subject + '%'}`);
		}

		if (withCursor && emailId) {
			conditions.push(timeSort ? gt(email.emailId, emailId) : lt(email.emailId, emailId));
		}

		return conditions;
	},

	async delete(c, params, userId) {
		const { emailIds } = params;
		const emailIdList = emailIds.split(',').map(Number);
		await this.requireEmailAccess(c, emailIdList, userId);
		const { syncDelete } = await settingService.query(c);

		if (syncDelete === settingConst.syncDelete.OPEN) {
			const owned = await orm(c).select({ emailId: email.emailId }).from(email)
				.where(inArray(email.emailId, emailIdList))
				.all();
			const ownedIds = owned.map(row => row.emailId);
			if (ownedIds.length) {
				await this.physicsDelete(c, { emailIds: ownedIds.join(',') });
			}
			return;
		}

		await orm(c).update(email).set({ isDel: isDel.DELETE }).where(
			inArray(email.emailId, emailIdList))
			.run();
	},

	async requireEmailAccess(c, emailIds, userId) {
		if (!Array.isArray(emailIds) || !emailIds.length || emailIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
			throw new BizError('Invalid message ID', 400);
		}
		const rows = await orm(c).select({
			emailId: email.emailId, userId: email.userId, accountId: email.accountId, shared: account.shared
		}).from(email).leftJoin(account, eq(account.accountId, email.accountId))
			.where(and(inArray(email.emailId, emailIds), eq(email.isDel, isDel.NORMAL))).all();
		if (rows.length !== new Set(emailIds).size) throw new BizError('Message not found', 404);
		for (const row of rows) {
			const allowed = row.shared === 1 ? await sharedMailboxService.hasAccess(c, row.accountId, userId) : row.userId === userId;
			if (!allowed) {
				throw new BizError('Message access denied', 403);
			}
		}
	},

	async requireSharedOperations(c, emailIds, userId) {
		if (c.get('user').email === c.env.admin || !emailIds.length) return;
		const rows = await orm(c).select({ accountId: email.accountId }).from(email)
			.innerJoin(account, eq(account.accountId, email.accountId))
			.where(and(inArray(email.emailId, emailIds), eq(account.shared, 1))).all();
		for (const accountId of new Set(rows.map(row => row.accountId))) {
			await sharedMailboxService.requireAccess(c, accountId, userId);
		}
	},

	receive(c, params, cidAttList, r2domain) {
		params.content = this.imgReplace(params.content, cidAttList, r2domain)
		return orm(c).insert(email).values({ ...params }).returning().get();
	},

	//Send email
	async send(c, params, userId) {

		let {
			accountId, //Sender account ID
			name, //Sender name
			sendType, //Send type
			emailId, //Email ID, provided when replying
			receiveEmail, //Recipient email addresses
			text, //Plain-text email body
			content, //Email content
			subject, //Email subject
			attachments = [] //Attachments
		} = params;

		const { resendTokens, r2Domain, send, domainList } = await settingService.query(c);

		let imageDataList = [];
		let html = content;

		//Check whether sending is disabled
		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		const userRow = await userService.selectById(c, userId);
		const roleRow = await roleService.selectById(c, userRow.type);
		const accountRow = await accountService.selectById(c, accountId);

		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}

		if (accountRow.shared) {
			await sharedMailboxService.requireAccess(c, accountId, userId);
		} else if (accountRow.userId !== userId) {
			throw new BizError(t('sendEmailNotCurUser'));
		}

		//Check whether all recipients are internal mailboxes
		const allInternal = receiveEmail.every(email => {
			const domain = '@' + emailUtils.getDomain(email);
			return domainList.includes(domain);
		});

		if (c.env.admin !== userRow.email && !accountRow.shared) {

			//Sending is disabled
			if (roleRow.sendType === 'ban') {
				throw new BizError(t('bannedSend'), 403);
			}

			//Sending is disabled
			if (roleRow.sendType === 'internal' && !allInternal) {
				throw new BizError(t('onlyInternalSend'), 403);
			}

		}

		//For non-admin users, enforce the role send limit
		if (c.env.admin !== userRow.email && !accountRow.shared && roleRow.sendCount) {

			if (userRow.sendCount >= roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLimit'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLimit'), 403);
			}

			if (userRow.sendCount + receiveEmail.length > roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLack'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLack'), 403);
			}

		}

		if (c.env.admin !== userRow.email && !accountRow.shared) {
			//The user lacks permission to use this domain
			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, accountRow.email)) {
				throw new BizError(t('noDomainPermSend'),403)
			}

		}
		({ imageDataList, html } = await attService.toImageUrlHtml(c, content, accountRow.shared === 1));

		const domain = emailUtils.getDomain(accountRow.email);
		const resendToken = resendTokens[domain];
		const useCloudflareEmail = !!c.env.email;

		//Check for external recipients without a sending provider
		if (!useCloudflareEmail && !resendToken && !allInternal) {
			throw new BizError(t('noSendProvider'));
		}

		//Derive the sender name if none is provided
		if (!name) {
			name = emailUtils.getName(accountRow.email);
		}

		let emailRow = {
			messageId: null
		};
		let references = '';

		//If this is a reply
		if (sendType === 'reply') {

			emailRow = await this.selectById(c, emailId);

			if (!emailRow || (accountRow.shared ? emailRow.accountId !== accountRow.accountId : emailRow.userId !== userId)) {
				throw new BizError(t('notExistEmailReply'));
			}
			references = [emailRow.relation, emailRow.messageId].filter(Boolean).join(' ');

		}

		let sendResult = {};

		//For external recipients, prefer Cloudflare Email Service if configured; otherwise use Resend
		if (!allInternal) {

			if (useCloudflareEmail) {
				sendResult = await this.sendByCloudflareEmail(c, {
					name,
					accountEmail: accountRow.email,
					receiveEmail,
					subject,
					text,
					html,
					attachments: [...imageDataList, ...attachments],
					sendType,
					messageId: emailRow.messageId,
					references
				});
			} else {
				sendResult = await this.sendByResend(resendToken, {
					name,
					accountEmail: accountRow.email,
					receiveEmail,
					subject,
					text,
					html,
					attachments: [...imageDataList, ...attachments],
					sendType,
					messageId: emailRow.messageId,
					references
				});
			}

		}

		const { data, error } = sendResult;


		if (error) {
			throw new BizError(error.message);
		}

		imageDataList = imageDataList.map(item => ({...item, contentId: `<${item.contentId}>`}))

		//Replace image CID references with public URLs
		html = this.imgReplace(html, imageDataList, r2Domain);

		//Prepare data for saving to the database
		const emailData = {};
		emailData.sendEmail = accountRow.email;
		emailData.name = name;
		emailData.subject = subject;
		emailData.content = html;
		emailData.text = text;
		emailData.accountId = accountId;
		emailData.status = useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT;
		emailData.type = emailConst.type.SEND;
		emailData.userId = accountRow.shared ? 0 : userId;
		emailData.resendEmailId = data?.id;
		emailData.messageId = allInternal ? `<${crypto.randomUUID()}@${domain}>` :
			(useCloudflareEmail ? data?.id : data?.message_id) || '';

		const recipient = [];

		receiveEmail.forEach(item => {
			recipient.push({ address: item, name: '' });
		});

		emailData.recipient = JSON.stringify(recipient);

		if (sendType === 'reply') {
			emailData.inReplyTo = emailRow.messageId;
			emailData.relation = references;
		}

		//Increment the user send count when the role has a send limit
		if (!accountRow.shared && roleRow.sendCount && roleRow.sendType !== 'internal') {
			await userService.incrUserSendCount(c, receiveEmail.length, userId);
		}

		//Save to the database and return the result
		const emailResult = await orm(c).insert(email).values(emailData).returning().get();

		//Save embedded attachments
		if (imageDataList.length > 0) {
			if (imageDataList.length > 10) {
				throw new BizError(t('imageAttLimit'));
			}
			await attService.saveArticleAtt(c, imageDataList, emailData.userId, accountId, emailResult.emailId);
		}

		//Save regular attachments
		if (attachments?.length > 0) {
			if (attachments.length > 10) {
				throw new BizError(t('attLimit'));
			}
			await attService.saveSendAtt(c, attachments, emailData.userId, accountId, emailResult.emailId);
		}

		const attList = await attService.selectAllByEmailIds(c, [emailResult.emailId]);
		emailResult.attList = attList.filter(item => item.type === attConst.type.ATT);

		//Write directly to the database if all recipients are internal
		if (allInternal) {
			await this.HandleOnSiteEmail(c, receiveEmail, emailResult, attList);
		}

		const dateStr = dayjs().format('YYYY-MM-DD');
		let daySendTotal = await c.env.kv.get(kvConst.SEND_DAY_COUNT + dateStr);

		//Record the daily send count
		if (!daySendTotal) {
			await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(receiveEmail.length), { expirationTtl: 60 * 60 * 24 });
		} else  {
			daySendTotal = Number(daySendTotal) + receiveEmail.length
			await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(daySendTotal), { expirationTtl: 60 * 60 * 24 });
		}

		return [ emailResult ];
	},

	async sendByCloudflareEmail(c, params) {
		const sendForm = {
			from: { email: params.accountEmail, name: params.name },
			to: [...params.receiveEmail],
			subject: params.subject
		};

		if (params.text) {
			sendForm.text = params.text;
		}

		if (params.html) {
			sendForm.html = params.html;
		}

		const attachments = await this.toCloudflareAttachments(params.attachments);
		if (attachments.length > 0) {
			sendForm.attachments = attachments;
		}

		if (params.sendType === 'reply' && params.messageId) {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.references
			};
		}

		const result = await c.env.email.send(sendForm);

		return {
			data: {
				id: result.messageId
			}
		};
	},

	async sendByResend(resendToken, params) {
		const resend = new Resend(resendToken);

		const sendForm = {
			from: `${params.name} <${params.accountEmail}>`,
			to: [...params.receiveEmail],
			subject: params.subject,
			text: params.text,
			html: params.html,
			attachments: await this.toResendAttachments(params.attachments)
		};

		if (params.sendType === 'reply' && params.messageId) {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.references
			};
		}

		return await resend.emails.send(sendForm);
	},

	async toCloudflareAttachments(attachments) {
		const arrayBufferAttachments = await this.toArrayBufferAttachments(attachments);

		return arrayBufferAttachments.map(attachment => {
			const item = {
				content: attachment.content,
				filename: attachment.filename,
				type: attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream',
				disposition: attachment.contentId ? 'inline' : 'attachment'
			};

			if (attachment.contentId) {
				item.contentId = attachment.contentId.replace(/^<|>$/g, '');
			}

			return item;
		});
	},

	async toResendAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentBase64(attachment);
			if (!content) {
				continue;
			}

			result.push({
				...attachment,
				content,
				contentType: attachment.contentType || attachment.mimeType || attachment.type || 'application/octet-stream'
			});
		}

		return result;
	},

	async toArrayBufferAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentArrayBuffer(attachment);
			if (!content) {
				continue;
			}

			result.push({ ...attachment, content });
		}

		return result;
	},

	async toAttachmentBase64(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return content.replace(/\s+/g, '');
		}

		const arrayBuffer = await this.toAttachmentArrayBuffer(attachment);
		if (!arrayBuffer) {
			return null;
		}

		const bytes = new Uint8Array(arrayBuffer);
		let binary = '';

		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}

		return btoa(binary);
	},

	async toAttachmentArrayBuffer(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (content instanceof ArrayBuffer) {
			return content;
		}

		if (content instanceof Uint8Array) {
			return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return fileUtils.base64ToUint8Array(content.replace(/\s+/g, '')).buffer;
		}

		return content;
	},

	//Handle internal email delivery
	async HandleOnSiteEmail(c, receiveEmail, sendEmailData, attList) {

		const { noRecipient  } = await settingService.query(c);

		//Look up all recipient accounts
		let accountList = await orm(c).select().from(account).where(inArray(account.email, receiveEmail)).all();

		// For plus addresses without an exact match, look up the base address account
		const plusEmails = receiveEmail.filter(
			e => e.includes('+') && !accountList.some(a => a.email === e)
		);
		const baseAccounts = [];
		if (plusEmails.length > 0) {
			const baseEmails = [...new Set(
				plusEmails.map(e => emailUtils.getBaseEmail(e)).filter(Boolean)
			)];
			const existing = new Set(accountList.map(a => a.email));
			const needed = baseEmails.filter(e => !existing.has(e));
			if (needed.length > 0) {
				const rows = await orm(c).select().from(account)
					.where(inArray(account.email, needed)).all();
				baseAccounts.push(...rows);
			}
		}

		// Combine exact and base address matches for the permission query
		const allAccounts = [...accountList, ...baseAccounts].filter(row => !row.shared || row.isDel === isDel.NORMAL);

		//Look up recipient roles
		const userIds = allAccounts.filter(accountRow => !accountRow.shared).map(accountRow => accountRow.userId);
		let roleList = await roleService.selectByUserIds(c, userIds);

		//Prepare the records for saving to the database
		const emailDataList = [];

		for (const email of receiveEmail) {

			//Turn the sender email record into a received email record
			const emailValues = {...sendEmailData}
			emailValues.status = emailConst.status.RECEIVE;
			emailValues.type = emailConst.type.RECEIVE;
			emailValues.toEmail = email;
			emailValues.toName = emailUtils.getName(email);
			emailValues.emailId = null;

			let accountRow = allAccounts.find(accountRow => accountRow.email === email);

			// Fall back to the base address (without +tag) when there is no exact match
			if (!accountRow && email.includes('+')) {
				const baseEmail = emailUtils.getBaseEmail(email);
				accountRow = allAccounts.find(accountRow => accountRow.email === baseEmail);
			}

			//If the recipient exists, assign the email record to them
			if (accountRow) {

				//Set recipient details before saving
				emailValues.userId = accountRow.shared ? 0 : accountRow.userId;
				emailValues.accountId = accountRow.accountId;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.RECEIVE;

				const roleRow = roleList.find(roleRow => roleRow.userId === accountRow.userId);

				let { banEmail, availDomain } = roleRow || {};

				//Mark as bounced if the recipient lacks domain permission or blocks the sender
				if (email !== c.env.admin && !accountRow.shared) {

					if (!roleService.hasAvailDomainPerm(availDomain, email)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is not authorized to use this domain.`;
					} else if(roleService.isBanEmail(banEmail, sendEmailData.sendEmail)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is disabled from receiving emails.`;
					}

				}

				emailDataList.push(emailValues);

			} else {

				//Set email details when the recipient does not exist
				emailValues.userId = 0;
				emailValues.accountId = 0;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.NOONE;

				//Mark as bounced when accepting mail without a recipient is disabled
				const archived = [...accountList, ...baseAccounts].some(row => row.shared && row.isDel === isDel.DELETE &&
					(row.email === email || row.email === emailUtils.getBaseEmail(email)));
				if (archived || noRecipient === settingConst.noRecipient.CLOSE) {
					emailValues.status = emailConst.status.BOUNCED;
					emailValues.message = archived ? `Recipient disabled: <${email}>` : `Recipient not found: <${email}>`;
				}

				emailDataList.push(emailValues);

			}

		}

		//Save the email
		const receiveEmailList = emailDataList.filter(emailRow => emailRow.status === emailConst.status.RECEIVE || emailRow.status === emailConst.status.NOONE);

		for (const emailData of receiveEmailList) {

			const recipientAttachments = [];
			for (const attRow of attList) {
				const attValues = { ...attRow };
				attValues.key = await attService.copyForAccount(c, attRow, emailData.accountId, emailData.userId);
				emailData.content = emailData.content?.replaceAll(attRow.key, attValues.key);
				recipientAttachments.push(attValues);
			}
			const emailRow = await orm(c).insert(email).values(emailData).returning().get();

			//Set attachment details before saving
			for (const attValues of recipientAttachments) {
				attValues.emailId = emailRow.emailId;
				attValues.accountId = emailRow.accountId;
				attValues.userId = emailRow.userId;
				attValues.attId = null;
				await orm(c).insert(att).values(attValues).run();
			}

		}

		const bouncedEmail = emailDataList.find(emailRow => emailRow.status === emailConst.status.BOUNCED);


		let status = emailConst.status.DELIVERED;
		let message = ''
		//If any recipient email bounced, mark the sender email as bounced
		if (bouncedEmail) {
			const messageJson = { message: bouncedEmail.message };
			message = JSON.stringify(messageJson);
			status = emailConst.status.BOUNCED;
		}

		await orm(c).update(email).set({ status, message: message }).where(eq(email.emailId, sendEmailData.emailId)).run();

	},

	imgReplace(content, cidAttList, r2domain) {

		if (!content) {
			return ''
		}

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		const useAtts = []

		for (const img of images) {

			const src = img.getAttribute('src');
			if (src && src.startsWith('cid:') && cidAttList) {

				const cid = src.replace(/^cid:/, '');
				const attCidIndex = cidAttList.findIndex(cidAtt => cidAtt.contentId.replace(/^<|>$/g, '') === cid);

				if (attCidIndex > -1) {
					const cidAtt = cidAttList[attCidIndex];
					img.setAttribute('src', '{{domain}}' + cidAtt.key);
					useAtts.push(cidAtt)
				}

			}

			r2domain = domainUtils.toOssDomain(r2domain)

			if (src && src.startsWith(r2domain + '/')) {
				img.setAttribute('src', src.replace(r2domain + '/', '{{domain}}'));
			}

		}

		useAtts.forEach(att => {
			att.type = attConst.type.EMBED
		})

		return document.toString();
	},

	selectById(c, emailId) {
		return orm(c).select().from(email).where(
			and(eq(email.emailId, emailId),
				eq(email.isDel, isDel.NORMAL)))
			.get();
	},

	async latest(c, params, userId) {
		let { emailId, accountId, allReceive } = params;
		allReceive = Number(allReceive);

		const accountRow = await accountService.selectById(c, accountId);
		if (isNaN(allReceive)) allReceive = accountRow?.allReceive || 0;
		const shared = accountRow?.shared === 1;
		if (shared) {
			await sharedMailboxService.requireAccess(c, accountId, userId);
			allReceive = 0;
		}

		const list = await orm(c).select({ ...emailListColumns }).from(email)
			.innerJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.userId, shared ? 0 : userId),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL),
					allReceive ? undefined : eq(email.accountId, accountId),
					eq(email.type, emailConst.type.RECEIVE)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);
		for (const item of list) {
			item.listText = this.toListText(item);
		}
		return list;
	},

	async physicsDelete(c, params) {
		let { emailIds } = params;
		emailIds = emailIds.split(',').map(Number);
		await attService.removeByEmailIds(c, emailIds);
		await starService.removeByEmailIds(c, emailIds);
		await orm(c).delete(email).where(inArray(email.emailId, emailIds)).run();
	},

	async physicsDeleteUserIds(c, userIds) {
		await attService.removeByUserIds(c, userIds);
		await orm(c).delete(email).where(inArray(email.userId, userIds)).run();
	},

	updateEmailStatus(c, params) {
		const { status, resendEmailId, message, messageId } = params;
		return orm(c).update(email).set({
			status: status,
			message: message,
			...(messageId ? { messageId } : {})
		}).where(eq(email.resendEmailId, resendEmailId)).returning().get();
	},

	async selectUserEmailCountList(c, userIds, type, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: email.userId,
				count: count(email.emailId)
			})
			.from(email)
			.where(and(
				inArray(email.userId, userIds),
				eq(email.type, type),
				eq(email.isDel, del),
				ne(email.status, emailConst.status.SAVING),
			))
			.groupBy(email.userId);
		return result;
	},

	async allList(c, params) {

		let { emailId, size, name, subject, accountEmail, userEmail, type, timeSort, full } = params;

		size = Number(size);
		emailId = Number(emailId) || 0;
		timeSort = Number(timeSort);
		full = Number(full);

		if (type === undefined) {
			type = 'receive';
		}

		if (isNaN(size)) {
			size = 10;
		}

		if (size > 50) {
			size = 50;
		}

		if (isNaN(full)) {
			full = 1;
		}

		full = full === 1;

		const filters = this.allEmailListFilters({ emailId, name, subject, accountEmail, userEmail, type, timeSort });
		const countFilters = this.allEmailListFilters({ emailId, name, subject, accountEmail, userEmail, type, timeSort, withCursor: false });
		const sharedFilter = await this.allEmailSharedFilter(c);
		if (sharedFilter) {
			filters.push(sharedFilter);
			countFilters.push(sharedFilter);
		}
		const columns = full ? emailListColumns : emailBriefColumns;

		const query = orm(c).select({ ...columns, userEmail: user.email })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...filters));

		// No need to join user when count does not search by user
		const queryCount = userEmail
			? orm(c).select({ total: count() })
				.from(email)
				.leftJoin(user, eq(email.userId, user.userId))
				.where(and(...countFilters))
			: orm(c).select({ total: count() })
				.from(email)
				.where(and(...countFilters));

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = query.limit(size).all();
		const totalQuery = queryCount.get();
		const latestEmailQuery = orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId,
		}).from(email)
			.where(and(eq(email.type, emailConst.type.RECEIVE), sharedFilter))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		if (full) {
			await this.emailAddAtt(c, list);
		} else {
			this.applyListText(list);
		}

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: 0,
				userId: 0,
			}
		}

		return { list: list, total: totalRow.total, latestEmail };
	},

	async allEmailLatest(c, params) {

		const { emailId } = params;
		const sharedFilter = await this.allEmailSharedFilter(c);

		let list = await orm(c).select({ ...emailListColumns, userEmail: user.email }).from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.type, emailConst.type.RECEIVE),
					sharedFilter
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);
		for (const item of list) {
			item.listText = this.toListText(item);
		}
		return list;
	},

	async allEmailSharedFilter(c) {
		if (c.get('user').email === c.env.admin) return undefined;
		const rows = await sharedMailboxService.listForUser(c, c.get('user').userId);
		const accountIds = rows.map(row => row.accountId);
		return or(sql`NOT EXISTS (SELECT 1 FROM account a WHERE a.account_id = ${email.accountId} AND a.shared = 1)`,
			accountIds.length ? inArray(email.accountId, accountIds) : undefined);
	},

	async emailAddAtt(c, list) {

		const emailIds = list.map(item => item.emailId);

		if (emailIds.length > 0) {

			const attList = await attService.selectByEmailIds(c, emailIds);

			list.forEach(emailRow => {
				const atts = attList.filter(attRow => attRow.emailId === emailRow.emailId);
				emailRow.attList = atts;
			});
		}
	},

	async restoreByUserId(c, userId) {
		await orm(c).update(email).set({ isDel: isDel.NORMAL }).where(eq(email.userId, userId)).run();
	},

	async completeReceive(c, status, emailId) {
		return await orm(c).update(email).set({
			isDel: isDel.NORMAL,
			status: status
		}).where(eq(email.emailId, emailId)).returning().get();
	},

	async completeReceiveAll(c) {
		// Use EXISTS with the status=6 partial index and the account primary key; avoid a full scan from IN (SELECT account_id FROM account)
		await c.env.db.prepare(
			`UPDATE email
			 SET status = ${emailConst.status.RECEIVE}
			 WHERE status = ${emailConst.status.SAVING}
			   AND EXISTS (SELECT 1 FROM account WHERE account.account_id = email.account_id)`
		).run();
		await c.env.db.prepare(
			`UPDATE email
			 SET status = ${emailConst.status.NOONE}
			 WHERE status = ${emailConst.status.SAVING}`
		).run();
	},

	async autoClean(c) {
		const { autoCleanDays, autoCleanExclude } = await settingService.query(c);
		const days = Number(autoCleanDays);

		if (!days || days <= 0) {
			return;
		}

		const cutoff = dayjs().subtract(days, 'day').format('YYYY-MM-DD HH:mm:ss');
		const excludeEmails = String(autoCleanExclude || '')
			.split(/[,，]/)
			.map(item => item.trim())
			.filter(Boolean);

		let excludeUserIds = [];
		if (excludeEmails.length) {
			const rows = await orm(c)
				.select({ userId: user.userId })
				.from(user)
				.where(sql`lower(${user.email}) IN (${sql.join(excludeEmails.map(email => sql`${email.toLowerCase()}`), sql`, `)})`)
				.all();
			excludeUserIds = rows.map(row => row.userId);
		}

		const batchSize = 95;

		while (true) {
			const conditions = [lt(email.createTime, cutoff)];
			if (excludeUserIds.length) {
				conditions.push(notInArray(email.userId, excludeUserIds));
			}

			const rows = await orm(c)
				.select({ emailId: email.emailId })
				.from(email)
				.where(and(...conditions))
				.limit(batchSize)
				.all();

			if (!rows.length) {
				break;
			}

			const emailIds = rows.map(row => row.emailId);
			await this.physicsDelete(c, { emailIds: emailIds.join(',') });

			if (rows.length < batchSize) {
				break;
			}
		}
	},

	async batchDelete(c, params) {
		let { sendName, sendEmail, toEmail, subject, startTime, endTime, type  } = params

		let right = type === 'left' || type === 'include'
		let left = type === 'include'

		const conditions = []

		if (sendName) {
			conditions.push(like(email.name,`${left ? '%' : ''}${sendName}${right ? '%' : ''}`))
		}

		if (subject) {
			conditions.push(like(email.subject,`${left ? '%' : ''}${subject}${right ? '%' : ''}`))
		}

		if (sendEmail) {
			conditions.push(like(email.sendEmail,`${left ? '%' : ''}${sendEmail}${right ? '%' : ''}`))
		}

		if (toEmail) {
			conditions.push(like(email.toEmail,`${left ? '%' : ''}${toEmail}${right ? '%' : ''}`))
		}

		if (startTime && endTime) {
			conditions.push(gte(email.createTime,`${startTime}`))
			conditions.push(lte(email.createTime,`${endTime}`))
		}

		if (conditions.length === 0) {
			return;
		}

		const emailIdsRow = await orm(c).select({emailId: email.emailId}).from(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).all();

		const emailIds = emailIdsRow.map(row => row.emailId);

		if (emailIds.length === 0){
			return;
		}
		await this.requireSharedOperations(c, emailIds, c.get('user').userId);

		await attService.removeByEmailIds(c, emailIds);

		await orm(c).delete(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).run();
	},

	async physicsDeleteByAccountId(c, accountId) {
		await attService.removeByAccountId(c, accountId);
		await orm(c).delete(email).where(eq(email.accountId, accountId)).run();
	},

	async read(c, params, userId) {
		const { emailIds } = params;
		const ids = emailIds.map(Number);
		await this.requireEmailAccess(c, ids, userId);
		await orm(c).update(email).set({ unread: emailConst.unread.READ }).where(inArray(email.emailId, ids));
	}
};

export default emailService;
