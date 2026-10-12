import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import r2Service from './r2-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { attConst, isDel } from '../const/entity-const';
import { parseHTML } from 'linkedom';
import { v4 as uuidv4 } from 'uuid';
import domainUtils from '../utils/domain-uitls';
import settingService from "./setting-service";
import email from '../entity/email';
import account from '../entity/account';
import sharedMailboxService from './shared-mailbox-service';
import BizError from '../error/biz-error';

const sharedPrefix = 'shared/attachments/';

async function sharedCryptoKey(c) {
	const row = await c.env.db.prepare('SELECT secret FROM shared_mailbox_key WHERE id = 1').first();
	const bytes = new Uint8Array(row.secret.match(/.{2}/g).map(value => parseInt(value, 16)));
	return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptShared(c, content) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sharedCryptoKey(c), content));
	const data = new Uint8Array(iv.length + encrypted.length);
	data.set(iv);
	data.set(encrypted, iv.length);
	return data;
}

async function decryptShared(c, content) {
	const data = new Uint8Array(content);
	return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, await sharedCryptoKey(c), data.slice(12));
}

const attService = {

	async addAtt(c, attachments, shared = false) {

		for (let attachment of attachments) {

			let metadate = {
				contentType: attachment.mimeType,
			}

			if (!attachment.contentId) {
				metadate.contentDisposition = `attachment;filename=${attachment.filename}`
			} else {
				metadate.contentDisposition = `inline;filename=${attachment.filename}`
				metadate.cacheControl = `max-age=259200`
			}

			await r2Service.putObj(c, attachment.key, shared ? await encryptShared(c, attachment.content) : attachment.content, metadate);

		}

		await orm(c).insert(att).values(attachments).run();
	},

	async list(c, params, userId) {
		const { emailId } = params;
		const emailRow = await orm(c).select({
			userId: email.userId, accountId: email.accountId, isDel: email.isDel, shared: account.shared
		}).from(email).leftJoin(account, eq(account.accountId, email.accountId))
			.where(eq(email.emailId, Number(emailId))).get();
		if (!emailRow || emailRow.isDel !== isDel.NORMAL || (emailRow.shared === 1 ?
			!await sharedMailboxService.hasAccess(c, emailRow.accountId, userId) : emailRow.userId !== userId)) {
			throw new BizError('Message access denied', 403);
		}

		return orm(c).select().from(att).where(
			and(
				eq(att.emailId, emailId),
				eq(att.userId, emailRow.userId),
				eq(att.type, attConst.type.ATT),
				isNull(att.contentId)
			)
		).all();
	},

	async toImageUrlHtml(c, content, shared = false) {

		const { r2Domain } = await settingService.query(c);

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		let imageDataList = [];

		for (const img of images) {

			//Convert base64 images in the email body to CID attachments
			const src = img.getAttribute('src');
			if (src && src.startsWith('data:image')) {
				const file = fileUtils.base64ToFile(src);
				const buff = await file.arrayBuffer();
				const cid = uuidv4().replace(/-/g, '');
				const key = shared ? sharedPrefix + crypto.randomUUID() + fileUtils.getExtFileName(file.name) :
					constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(file.name);

				img.setAttribute('src', 'cid:' + cid);

				const attData = {};
				attData.key = key;
				attData.filename = file.name;
				attData.mimeType = file.type;
				attData.size = file.size;
				attData.buff = buff;
				attData.content = fileUtils.base64ToDataStr(src);
				attData.contentId = cid;

				imageDataList.push(attData);
			}

			//Convert hosted images in the email body to CID attachments
			if (src && (src.startsWith(domainUtils.toOssDomain(r2Domain)) || src.startsWith('attachments/'))) {

				const cid = uuidv4().replace(/-/g, '')
				img.setAttribute('src', 'cid:' + cid);

				const attData = {};

				if (src.startsWith(domainUtils.toOssDomain(r2Domain))) {
					attData.key = src.replace(domainUtils.toOssDomain(r2Domain) + '/','');
				}

				if (src.startsWith('attachments/')) {
					attData.key = src;
				}

				attData.contentId = cid;
				attData.type = attConst.type.EMBED;
				imageDataList.push(attData);

			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = (style ? style.trim().replace(/;$/, '') + '; ' : '') + 'max-width: 100%;';
				img.setAttribute('style', newStyle);
			}
		}

		//Look up existing embedded image URL information
		const keys = [...new Set(imageDataList.filter(item => !item.content).map(item => item.key))];
		const dbImageList  = await this.selectOneByKeys(c, keys);

		//Apply it to the current attachment
		await Promise.all(imageDataList.map(async image => {
			if (image.content) {
				return;
			}

			const dbImage = dbImageList.find(dbImage => image.key === dbImage.key);
			if (!dbImage) {
				return;
			}
			image.size = dbImage.size;
			image.filename = dbImage.filename;
			image.mimeType = dbImage.mimeType;
			image.contentType = dbImage.mimeType;

			if (image.key.startsWith(sharedPrefix)) {
				image.content = await (await this.getSharedFile(c, image.key, c.get('user').userId)).arrayBuffer();
			} else {
				const obj = await r2Service.getObj(c, image.key);
				if (!obj) return;
				image.content = obj instanceof ArrayBuffer ? obj : await obj.arrayBuffer();
			}
			if (shared || image.key.startsWith(sharedPrefix)) {
				image.key = (shared ? sharedPrefix : constant.ATTACHMENT_PREFIX) + crypto.randomUUID() + fileUtils.getExtFileName(image.filename);
				image.buff = image.content;
			}
		}))

		imageDataList = imageDataList.filter(image => image.content);

		return { imageDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, userId, accountId, emailId) {

		const attDataList = [];

		for (let att of attList) {
			att.buff = fileUtils.base64ToUint8Array(att.content);
			att.key = userId === 0 ? sharedPrefix + crypto.randomUUID() + fileUtils.getExtFileName(att.filename) :
				constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(att.buff) + fileUtils.getExtFileName(att.filename);
			const attData = { userId, accountId, emailId };
			attData.key = att.key;
			attData.size = att.buff.length;
			attData.filename = att.filename;
			attData.mimeType = att.type;
			attData.type = attConst.type.ATT;
			attDataList.push(attData);
		}

		await orm(c).insert(att).values(attDataList).run();

		for (let att of attList) {
			await r2Service.putObj(c, att.key, userId === 0 ? await encryptShared(c, att.buff) : att.buff, {
				contentType: att.type,
				contentDisposition: `attachment;filename=${att.filename}`
			});
		}

	},

	async saveArticleAtt(c, attDataList, userId, accountId, emailId) {

		for (let attData of attDataList) {
			attData.userId = userId;
			attData.emailId = emailId;
			attData.accountId = accountId;
			attData.type = attConst.type.EMBED;
			if (!attData.buff) {
				continue;
			}
			await r2Service.putObj(c, attData.key, userId === 0 ? await encryptShared(c, attData.buff) : attData.buff, {
				contentType: attData.mimeType,
				cacheControl: `max-age=259200`,
				contentDisposition: `inline;filename=${attData.filename}`
			});
			delete attData.buff;
		}

		await orm(c).insert(att).values(attDataList).run();

	},

	async removeByUserIds(c, userIds) {
		await this.removeAttByField(c, 'user_id', userIds);
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	selectByEmailIds(c, emailIds) {
		return orm(c).select().from(att).where(
			and(
				inArray(att.emailId, emailIds),
				eq(att.type, attConst.type.ATT)
			))
			.all();
	},

	selectAllByEmailIds(c, emailIds) {
		return orm(c).select().from(att).where(inArray(att.emailId, emailIds)).all();
	},

	async copyForAccount(c, attachment, accountId, userId) {
		const sourceShared = attachment.key.startsWith(sharedPrefix);
		const targetShared = accountId > 0 && userId === 0;
		if (sourceShared === targetShared) return attachment.key;
		const obj = await r2Service.getObj(c, attachment.key);
		if (!obj) throw new BizError('Attachment not found', 404);
		const stored = await obj.arrayBuffer();
		const content = sourceShared ? await decryptShared(c, stored) : stored;
		const key = (targetShared ? sharedPrefix : constant.ATTACHMENT_PREFIX) + crypto.randomUUID() + fileUtils.getExtFileName(attachment.filename);
		await r2Service.putObj(c, key, targetShared ? await encryptShared(c, content) : content, {
			contentType: attachment.mimeType,
			contentDisposition: `${attachment.type === attConst.type.EMBED ? 'inline' : 'attachment'};filename=${attachment.filename}`
		});
		return key;
	},

	async getSharedFile(c, key, userId) {
		if (!key?.startsWith(sharedPrefix)) throw new BizError('Attachment not found', 404);
		const rows = await orm(c).select({ attachment: att }).from(att)
			.innerJoin(email, eq(email.emailId, att.emailId))
			.where(and(eq(att.key, key), eq(email.isDel, isDel.NORMAL))).all();
		let allowed = null;
		for (const { attachment: row } of rows) {
			if (await sharedMailboxService.hasAccess(c, row.accountId, userId)) {
				allowed = row;
				break;
			}
		}
		if (!allowed) throw new BizError('Attachment access denied', 403);
		const obj = await r2Service.getObj(c, key);
		if (!obj) throw new BizError('Attachment not found', 404);
		const content = await decryptShared(c, await obj.arrayBuffer());
		return new Response(content, { headers: {
			'X-Shared-Attachment': '1',
			'Access-Control-Expose-Headers': 'X-Shared-Attachment',
			'Content-Type': allowed.mimeType || 'application/octet-stream',
			'Content-Disposition': `${allowed.type === attConst.type.EMBED ? 'inline' : 'attachment'}; filename="${String(allowed.filename || 'attachment').replace(/[\r\n"]/g, '')}"`,
			'Cache-Control': 'private, no-store'
		} });
	},

	async removeAttByField(c, fieldName, fieldValues) {

		const sqlList = [];

		fieldValues.forEach(value => {

			sqlList.push(

				c.env.db.prepare(
					`SELECT a.key, a.att_id
						FROM attachments a
							   JOIN (SELECT key
									 FROM attachments
									 GROUP BY key
									 HAVING COUNT (*) = 1) t
									ON a.key = t.key
						WHERE a.${fieldName} = ?;`
					).bind(value)
			)

			sqlList.push(c.env.db.prepare(`DELETE FROM attachments WHERE ${fieldName} = ?`).bind(value))

		});

		const attListResult = await c.env.db.batch(sqlList);

		const delKeyList = attListResult.flatMap(r => r.results ? r.results.map(row => row.key) : []);

		if (delKeyList.length > 0) {
			try {
				await this.batchDelete(c, delKeyList);
			} catch (e) {
				console.error('Failed to delete attachment file: ', e);
			}
		}

	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c, batch);
		}

	},

	async removeByAccountId(c, accountId) {
		await this.removeAttByField(c, "account_id", [accountId])
	},

	selectOneByKeys(c, keys) {
		if (!keys || keys.length === 0) {
			return []
		}
		return orm(c).select().from(att).where(inArray(att.key, keys)).orderBy(desc(att.attId)).groupBy(att.key).all();
	}
};

export default attService;
