import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import sharedMailboxService from '../service/shared-mailbox-service';
import attService from '../service/att-service';

app.get('/sharedMailbox/list', async c => c.json(result.ok(await sharedMailboxService.list(c))));
app.get('/sharedMailbox/mine', async c => c.json(result.ok(await sharedMailboxService.listForUser(c, userContext.getUserId(c)))));
app.post('/sharedMailbox/create', async c => c.json(result.ok(await sharedMailboxService.create(c, await c.req.json()))));
app.put('/sharedMailbox/active', async c => {
	const { accountId, active } = await c.req.json();
	await sharedMailboxService.setActive(c, accountId, active === true);
	return c.json(result.ok());
});
app.get('/sharedMailbox/members', async c => c.json(result.ok(await sharedMailboxService.members(c, c.req.query('accountId')))));
app.post('/sharedMailbox/grant', async c => {
	const { accountId, userEmail } = await c.req.json();
	await sharedMailboxService.grant(c, accountId, userEmail);
	return c.json(result.ok());
});
app.delete('/sharedMailbox/revoke', async c => {
	const { accountId, userId } = c.req.query();
	await sharedMailboxService.revoke(c, accountId, userId);
	return c.json(result.ok());
});
app.get('/sharedMailbox/file', async c => attService.getSharedFile(c, c.req.query('key'), userContext.getUserId(c)));
