<template>
  <div class="shared-page">
    <h2>{{ $t('sharedMailboxes') }}</h2>
    <div class="create-row">
      <el-input v-model="email" :placeholder="$t('sharedAddress')" />
      <el-input v-model="name" :placeholder="$t('username')" />
      <el-button type="primary" :loading="saving" @click="create">{{ $t('add') }}</el-button>
    </div>
    <el-table :data="mailboxes" @row-click="selectMailbox" highlight-current-row>
      <el-table-column prop="email" :label="$t('tabEmailAddress')" />
      <el-table-column prop="name" :label="$t('username')" />
      <el-table-column :label="$t('tabStatus')" width="120">
        <template #default="scope">{{ scope.row.isDel ? $t('deleted') : $t('active') }}</template>
      </el-table-column>
      <el-table-column :label="$t('action')" width="150">
        <template #default="scope">
          <el-button link type="primary" @click.stop="toggle(scope.row)">
            {{ scope.row.isDel ? $t('restore') : $t('delete') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-if="selected" class="members">
      <h3>{{ selected.email }} · {{ $t('sharedMembers') }}</h3>
      <div class="create-row">
        <el-input v-model="userEmail" :placeholder="$t('userAccount')" />
        <el-button type="primary" :loading="saving" :disabled="!!selected.isDel" @click="grant">{{ $t('grantAccess') }}</el-button>
      </div>
      <el-table :data="members">
        <el-table-column prop="email" :label="$t('tabEmailAddress')" />
        <el-table-column :label="$t('action')" width="150">
          <template #default="scope">
            <el-button link type="danger" @click="revoke(scope.row)">{{ $t('revokeAccess') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { sharedMailboxList, sharedMailboxCreate, sharedMailboxActive, sharedMailboxMembers, sharedMailboxGrant, sharedMailboxRevoke } from '@/request/shared-mailbox.js';

const { t } = useI18n();
const mailboxes = ref([]);
const members = ref([]);
const selected = ref(null);
const email = ref('');
const name = ref('');
const userEmail = ref('');
const saving = ref(false);

async function load() {
  mailboxes.value = await sharedMailboxList();
  if (selected.value) selected.value = mailboxes.value.find(item => item.accountId === selected.value.accountId) || null;
}

async function selectMailbox(row) {
  selected.value = row;
  members.value = await sharedMailboxMembers(row.accountId);
}

async function create() {
  if (saving.value || !email.value.trim()) return;
  saving.value = true;
  try {
    const row = await sharedMailboxCreate(email.value, name.value);
    email.value = '';
    name.value = '';
    await load();
    await selectMailbox(mailboxes.value.find(item => item.accountId === row.accountId));
    ElMessage.success(t('saveSuccessMsg'));
  } finally {
    saving.value = false;
  }
}

async function toggle(row) {
  if (!row.isDel) await ElMessageBox.confirm(t('delConfirm', { msg: row.email }));
  await sharedMailboxActive(row.accountId, !!row.isDel);
  await load();
}

async function grant() {
  if (saving.value || !userEmail.value.trim() || !selected.value) return;
  saving.value = true;
  try {
    await sharedMailboxGrant(selected.value.accountId, userEmail.value);
    userEmail.value = '';
    members.value = await sharedMailboxMembers(selected.value.accountId);
    ElMessage.success(t('saveSuccessMsg'));
  } finally {
    saving.value = false;
  }
}

async function revoke(row) {
  await sharedMailboxRevoke(selected.value.accountId, row.userId);
  members.value = await sharedMailboxMembers(selected.value.accountId);
}

onMounted(load);
</script>

<style scoped>
.shared-page { padding: 24px; overflow: auto; }
.create-row { display: flex; gap: 10px; margin: 16px 0; }
.members { margin-top: 30px; }
@media (max-width: 700px) { .create-row { flex-direction: column; } }
</style>
