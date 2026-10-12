<template>
  <div class="shared-page">
    <header class="page-header">
      <h2>{{ $t('sharedMailboxes') }}</h2>
      <p>{{ $t('sharedMailboxIntro') }}</p>
    </header>

    <section class="section" aria-labelledby="create-shared-mailbox">
      <h3 id="create-shared-mailbox">{{ $t('createSharedMailbox') }}</h3>
      <p class="hint">{{ allowedDomains ? $t('sharedMailboxDomainsHint', { domains: allowedDomains }) : $t('sharedMailboxDomainHint') }}</p>
      <div class="form-row">
        <div class="field">
          <label for="shared-address">{{ $t('sharedAddress') }}</label>
          <el-input id="shared-address" v-model="email" autocomplete="off" @keyup.enter="create" />
        </div>
        <div class="field">
          <label for="shared-name">{{ $t('sharedDisplayName') }}</label>
          <el-input id="shared-name" v-model="name" autocomplete="off" @keyup.enter="create" />
        </div>
        <el-button type="primary" :loading="saving" :disabled="!email.trim()" @click="create">{{ $t('createSharedMailbox') }}</el-button>
      </div>
    </section>

    <section class="section" aria-labelledby="shared-mailbox-list">
      <h3 id="shared-mailbox-list">{{ $t('sharedMailboxList') }}</h3>
      <div v-if="loadError" class="inline-state" role="alert">
        {{ $t('sharedMailboxLoadError') }}
        <el-button link type="primary" @click="load">{{ $t('retry') }}</el-button>
      </div>
      <template v-else>
        <el-table v-if="loading || mailboxes.length" v-loading="loading" class="desktop-table" :data="mailboxes" @row-click="selectMailbox" highlight-current-row>
          <el-table-column prop="email" :label="$t('sharedAddress')" min-width="220" />
          <el-table-column prop="name" :label="$t('sharedName')" min-width="140" />
          <el-table-column :label="$t('tabStatus')" width="120">
            <template #default="scope">{{ scope.row.isDel ? $t('sharedArchived') : $t('active') }}</template>
          </el-table-column>
          <el-table-column :label="$t('action')" min-width="230">
            <template #default="scope">
              <el-button link type="primary" :aria-label="t('manageSharedAccessFor', { email: scope.row.email })" @click.stop="selectMailbox(scope.row)">
                {{ $t('manageSharedAccess') }}
              </el-button>
              <el-button link :type="scope.row.isDel ? 'primary' : 'warning'" @click.stop="toggle(scope.row)">
                {{ scope.row.isDel ? $t('restore') : $t('archiveSharedMailbox') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <ul v-if="loading || mailboxes.length" v-loading="loading" class="mobile-list">
          <li v-for="row in mailboxes" :key="row.accountId" class="mobile-item">
            <div class="mobile-item-heading">
              <strong>{{ row.email }}</strong>
              <el-tag :type="row.isDel ? 'info' : 'success'">{{ row.isDel ? $t('sharedArchived') : $t('active') }}</el-tag>
            </div>
            <div v-if="row.name" class="hint">{{ row.name }}</div>
            <div class="item-actions">
              <el-button link type="primary" :aria-label="t('manageSharedAccessFor', { email: row.email })" @click="selectMailbox(row)">
                {{ $t('manageSharedAccess') }}
              </el-button>
              <el-button link :type="row.isDel ? 'primary' : 'warning'" @click="toggle(row)">
                {{ row.isDel ? $t('restore') : $t('archiveSharedMailbox') }}
              </el-button>
            </div>
          </li>
        </ul>
        <el-empty v-if="!loading && !mailboxes.length" :description="$t('noSharedMailboxes')" />
      </template>
    </section>

    <section v-if="selected" class="section" aria-labelledby="shared-mailbox-access">
      <div class="section-heading">
        <h3 id="shared-mailbox-access">{{ $t('sharedAccessFor', { email: selected.email }) }}</h3>
        <el-tag :type="selected.isDel ? 'info' : 'success'">{{ selected.isDel ? $t('sharedArchived') : $t('active') }}</el-tag>
      </div>
      <p class="hint">{{ selected.isDel ? $t('archivedSharedMailboxHint') : $t('sharedAccessHint') }}</p>
      <div class="form-row member-form">
        <div class="field">
          <label for="shared-user-email">{{ $t('userAccount') }}</label>
          <el-input id="shared-user-email" v-model="userEmail" autocomplete="off" :disabled="!!selected.isDel" @keyup.enter="grant" />
        </div>
        <el-button type="primary" :loading="saving" :disabled="!!selected.isDel || !userEmail.trim()" @click="grant">{{ $t('grantAccess') }}</el-button>
      </div>
      <div v-if="membersError" class="inline-state" role="alert">
        {{ $t('sharedMembersLoadError') }}
        <el-button link type="primary" @click="selectMailbox(selected)">{{ $t('retry') }}</el-button>
      </div>
      <template v-else>
        <el-table v-if="membersLoading || members.length" v-loading="membersLoading" class="desktop-table" :data="members">
          <el-table-column prop="email" :label="$t('userAccount')" min-width="220" />
          <el-table-column :label="$t('action')" width="150">
            <template #default="scope">
              <el-button link type="danger" :aria-label="t('revokeSharedAccessFor', { email: scope.row.email })" @click="revoke(scope.row)">
                {{ $t('revokeAccess') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <ul v-if="membersLoading || members.length" v-loading="membersLoading" class="mobile-list">
          <li v-for="row in members" :key="row.userId" class="mobile-item member-item">
            <span>{{ row.email }}</span>
            <el-button link type="danger" :aria-label="t('revokeSharedAccessFor', { email: row.email })" @click="revoke(row)">
              {{ $t('revokeAccess') }}
            </el-button>
          </li>
        </ul>
        <el-empty v-if="!membersLoading && !members.length" :description="$t('noSharedMembers')" />
      </template>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useSettingStore } from '@/store/setting.js';
import { sharedMailboxList, sharedMailboxCreate, sharedMailboxActive, sharedMailboxMembers, sharedMailboxGrant, sharedMailboxRevoke } from '@/request/shared-mailbox.js';

const { t } = useI18n();
const settingStore = useSettingStore();
const allowedDomains = computed(() => settingStore.domainList.join(', '));
const mailboxes = ref([]);
const members = ref([]);
const selected = ref(null);
const email = ref('');
const name = ref('');
const userEmail = ref('');
const saving = ref(false);
const loading = ref(true);
const loadError = ref(false);
const membersLoading = ref(false);
const membersError = ref(false);
let memberRequest = 0;

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    mailboxes.value = await sharedMailboxList();
    const row = mailboxes.value.find(item => item.accountId === selected.value?.accountId) || mailboxes.value[0];
    if (row) await selectMailbox(row);
    else {
      memberRequest++;
      selected.value = null;
      members.value = [];
    }
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function selectMailbox(row) {
  const request = ++memberRequest;
  selected.value = row;
  membersLoading.value = true;
  membersError.value = false;
  try {
    const list = await sharedMailboxMembers(row.accountId);
    if (request === memberRequest) members.value = list;
  } catch {
    if (request === memberRequest) membersError.value = true;
  } finally {
    if (request === memberRequest) membersLoading.value = false;
  }
}

async function create() {
  if (saving.value || !email.value.trim()) return;
  saving.value = true;
  try {
    const row = await sharedMailboxCreate(email.value.trim(), name.value.trim());
    email.value = '';
    name.value = '';
    selected.value = row;
    await load();
    ElMessage.success(t('sharedMailboxCreated', { email: row.email }));
  } finally {
    saving.value = false;
  }
}

async function toggle(row) {
  const restoring = !!row.isDel;
  if (!restoring) {
    try {
      await ElMessageBox.confirm(t('archiveSharedMailboxConfirm', { email: row.email }), t('archiveSharedMailbox'), {
        confirmButtonText: t('archiveSharedMailbox'), cancelButtonText: t('cancel'), type: 'warning'
      });
    } catch {
      return;
    }
  }
  await sharedMailboxActive(row.accountId, restoring);
  await load();
  ElMessage.success(t(restoring ? 'sharedMailboxRestored' : 'sharedMailboxArchived', { email: row.email }));
}

async function grant() {
  if (saving.value || !userEmail.value.trim() || !selected.value) return;
  saving.value = true;
  try {
    const address = userEmail.value.trim();
    await sharedMailboxGrant(selected.value.accountId, address);
    userEmail.value = '';
    await selectMailbox(selected.value);
    ElMessage.success(t('sharedAccessGranted', { email: address }));
  } finally {
    saving.value = false;
  }
}

async function revoke(row) {
  try {
    await ElMessageBox.confirm(t('revokeSharedAccessConfirm', { email: row.email, mailbox: selected.value.email }), t('revokeAccess'), {
      confirmButtonText: t('revokeAccess'), cancelButtonText: t('cancel'), type: 'warning'
    });
  } catch {
    return;
  }
  await sharedMailboxRevoke(selected.value.accountId, row.userId);
  await selectMailbox(selected.value);
  ElMessage.success(t('sharedAccessRevoked', { email: row.email }));
}

onMounted(load);
</script>

<style scoped>
.shared-page { padding: 24px; overflow: auto; }
.page-header { margin-bottom: 28px; }
.page-header h2 { margin: 0 0 8px; }
.page-header p, .hint { color: var(--el-text-color-regular); line-height: 1.5; }
.page-header p { margin: 0; max-width: 70ch; }
.section { margin-bottom: 32px; }
.section h3 { margin: 0 0 12px; }
.section .hint { margin: 0 0 16px; }
.section-heading { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.form-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.field { display: flex; flex: 1 1 220px; flex-direction: column; gap: 8px; min-width: 0; }
.field label { font-weight: 500; }
.form-row > .el-button { margin: 0; }
.member-form { margin-bottom: 20px; max-width: 650px; }
.inline-state { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 16px 0; }
.mobile-list { display: none; }
@media (max-width: 700px) {
  .shared-page { padding: 16px; }
  .form-row { align-items: stretch; flex-direction: column; }
  .field { flex: none; width: 100%; }
  .form-row > .el-button { width: 100%; }
  .desktop-table { display: none; }
  .mobile-list { display: block; min-height: 40px; margin: 0; padding: 0; list-style: none; }
  .mobile-item { padding: 14px 0; border-bottom: 1px solid var(--el-border-color-light); }
  .mobile-item-heading, .member-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .mobile-item-heading strong, .member-item span { overflow-wrap: anywhere; }
  .mobile-item .hint { margin: 4px 0 0; }
  .item-actions { display: flex; gap: 16px; margin-top: 8px; }
  .item-actions .el-button { margin: 0; }
}
</style>
