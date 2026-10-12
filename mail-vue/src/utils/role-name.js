import en from '../i18n/en.js'
import zh from '../i18n/zh.js'

export function displayRoleName(roleId, name, t) {
  if (roleId === 1 && (name === en.standardUser || name === zh.standardUser)) {
    return t('standardUser')
  }
  return name
}

export function displayRoleDescription(roleId, description, t) {
  if (roleId === 1 && (description === en.standardUserDescription || description === zh.standardUserDescription)) {
    return t('standardUserDescription')
  }
  return description
}
