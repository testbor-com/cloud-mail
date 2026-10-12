import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.get('/allEmail/list', async (c) => {
	const data = await emailService.allList(c, c.req.query());
	return c.json(result.ok(data));
})

app.get('/allEmail/thread', async (c) => {
	const data = await emailService.thread(c, c.req.query(), userContext.getUserId(c), true);
	return c.json(result.ok(data));
})

app.delete('/allEmail/delete', async (c) => {
	const ids = String(c.req.query('emailIds') || '').split(',').map(Number);
	await emailService.requireSharedOperations(c, ids, userContext.getUserId(c));
	const list = await emailService.physicsDelete(c, c.req.query());
	return c.json(result.ok(list));
})

app.delete('/allEmail/batchDelete', async (c) => {
	await emailService.batchDelete(c, c.req.query());
	return c.json(result.ok());
})

app.get('/allEmail/latest', async (c) => {
	const list = await emailService.allEmailLatest(c, c.req.query());
	return c.json(result.ok(list));
})
