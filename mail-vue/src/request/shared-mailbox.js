import http from '@/axios/index.js';

export const sharedMailboxList = () => http.get('/sharedMailbox/list');
export const sharedMailboxMine = () => http.get('/sharedMailbox/mine');
export const sharedMailboxCreate = (email, name) => http.post('/sharedMailbox/create', { email, name });
export const sharedMailboxActive = (accountId, active) => http.put('/sharedMailbox/active', { accountId, active });
export const sharedMailboxMembers = accountId => http.get('/sharedMailbox/members', { params: { accountId } });
export const sharedMailboxGrant = (accountId, userEmail) => http.post('/sharedMailbox/grant', { accountId, userEmail });
export const sharedMailboxRevoke = (accountId, userId) => http.delete('/sharedMailbox/revoke', { params: { accountId, userId } });

export async function sharedMailboxFile(key) {
  const response = await fetch(`${import.meta.env.VITE_BASE_URL}/sharedMailbox/file?key=${encodeURIComponent(key)}`, {
    headers: { Authorization: localStorage.getItem('token') || '' }
  });
  if (response.headers.get('X-Shared-Attachment') !== '1') {
    const error = await response.json();
    throw new Error(error.message || 'Attachment unavailable');
  }
  return response.blob();
}
