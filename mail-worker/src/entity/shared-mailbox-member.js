import { sqliteTable, integer, primaryKey } from 'drizzle-orm/sqlite-core';

const sharedMailboxMember = sqliteTable('shared_mailbox_member', {
	accountId: integer('account_id').notNull(),
	userId: integer('user_id').notNull()
}, table => [primaryKey({ columns: [table.accountId, table.userId] })]);

export default sharedMailboxMember;
