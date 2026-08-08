<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import { _ } from 'svelte-i18n';
  
  let { data } = $props<{ data: PageData }>();
  
  let settings = $derived({
    ...(data.settings || {}),
    loraPresets: data.settings?.loraPresets ?? [],
    quotaPerDay: data.settings?.quotaPerDay ?? { "gmgard-user": 5 },
  });
  let users = $derived(data.users);
  let userPage = $derived(data.userPage || 1);
  let userTotalPages = $derived(data.userTotalPages || 1);
  let userTotal = $derived(data.userTotal || 0);
  let userSearch = $derived(data.userSearch || '');
  let workflows = $state(data.workflows || []);
  let queueStatus: any = $state(null);
  let saving = $state(false);
  let loadingQueue = $state(false);
  let savingWorkflow = $state(false);
  
  // Workflow editor modal state - enhanced with preset mechanism
  let showWorkflowModal = $state(false);
  let editingWorkflowId: string | null = $state(null);
  let workflowName = $state('');
  let workflowDescription = $state('');
  let workflowTemplatePath = $state('');
  let workflowType: 'i2v' | 'fl2v' = $state('i2v');
  let workflowIsDefault = $state(false);
  let workflowCompatibleLoras = $state<string[]>([]);
  let workflowTags = $state<string[]>([]); // tags for auto matching
  let workflowAutoInclude = $state(true);
  let workflowPresetGroup = $state('');
  let workflowQuotaCost = $state(1);
  let workflowQuotaCostRules = $state<any[]>([]);
  let workflowTagInput = $state('');
  let workflowLoraFilter = $state('all'); // all | byGroup | byTag
  let workflowSelectedTagFilter = $state('all');
  let workflowSelectedGroupFilter = $state('all');

  // LoRA bulk ops
  let showLoraBulkModal = $state(false);
  let bulkSelectedLoraIds = $state<string[]>([]);
  let bulkTargetWorkflowIds = $state<string[]>([]);
  let bulkAction: 'add' | 'remove' | 'set' = $state('add');

  // Derived helpers for preset UI
  const allLoraTags = $derived.by(() => {
    const set = new Set<string>();
    (settings.loraPresets || []).forEach((p: any) => (p.tags || []).forEach((t: string) => set.add(t)));
    return Array.from(set).sort();
  });
  const allLoraGroups = $derived.by(() => {
    const set = new Set<string>();
    (settings.loraPresets || []).forEach((p: any) => { if (p.presetGroup) set.add(p.presetGroup); });
    return Array.from(set).sort();
  });
  const allWorkflowTags = $derived.by(() => {
    const set = new Set<string>();
    workflows.forEach((w: any) => (w.tags || []).forEach((t: string) => set.add(t)));
    return Array.from(set).sort();
  });
  
  // Toast notification system
  let toastMessage = $state('');
  let toastType: 'success' | 'error' | 'info' = $state('info');
  let showToast = $state(false);
  
  function showNotification(message: string, type: 'success' | 'error' | 'info' = 'info') {
    toastMessage = message;
    toastType = type;
    showToast = true;
    setTimeout(() => showToast = false, 3000);
  }

  // JWT token validation
  import { getTokenStatus } from '$lib/jwt';
  
  let tokenStatus = $derived(getTokenStatus(settings.sponsorApiToken));

  function sanitizeLoraPresets(presets: any[]) {
    if (!Array.isArray(presets)) return [];
    return presets
      .filter((p: any) => p && p.id)
      .map((p: any) => ({
        id: p.id,
        label: p.label || p.id,
        nodeId: p.nodeId || '61:dyn1',
        default: Number(p.default ?? 1),
        min: p.min !== undefined ? Number(p.min) : 0,
        max: p.max !== undefined ? Number(p.max) : 1.5,
        step: p.step !== undefined ? Number(p.step) : 0.05,
        chain: p.chain === 'low' ? 'low' : 'high',
        isConfigurable: typeof (p as any).isConfigurable === 'boolean' ? (p as any).isConfigurable : true,
        enabled: typeof (p as any).enabled === 'boolean' ? (p as any).enabled : true,
        defaultEnabled: typeof (p as any).defaultEnabled === 'boolean' ? (p as any).defaultEnabled : (typeof (p as any).enabled === 'boolean' ? (p as any).enabled : true),
        tags: Array.isArray(p.tags) ? p.tags.map((t: any) => String(t).toLowerCase()) : [],
        presetGroup: typeof p.presetGroup === 'string' ? p.presetGroup : 'Custom',
        autoAddToWorkflows: typeof p.autoAddToWorkflows === 'boolean' ? p.autoAddToWorkflows : false,
      }));
  }

  async function bulkUpdateWorkflows() {
    if (!bulkTargetWorkflowIds.length || !bulkSelectedLoraIds.length) {
      showNotification('Select at least one workflow and one LoRA', 'error');
      return;
    }
    savingWorkflow = true;
    try {
      const res = await fetch('/api/admin/workflows/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowIds: bulkTargetWorkflowIds,
          loraIds: bulkSelectedLoraIds,
          action: bulkAction
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.workflows) {
          const map = new Map(data.workflows.map((w: any) => [w.id, w]));
          workflows = workflows.map((w: any) => map.get(w.id) ? map.get(w.id) : w);
        }
        showNotification(`Bulk ${bulkAction} applied to ${bulkTargetWorkflowIds.length} workflows`, 'success');
        showLoraBulkModal = false;
      } else {
        const e = await res.json();
        showNotification(e.error || 'Bulk failed', 'error');
      }
    } catch (err) {
      showNotification(String(err), 'error');
    } finally { savingWorkflow = false; }
  }
  
  // Role editor modal state
  let showRoleModal = $state(false);
  let editingUser: { id: string; username: string; roles: string[] } | null = $state(null);
  let roleInput = $state('');
  // role -> ISO datetime (optional expiry for manual role grants); null = permanent
  let roleExpirations = $state<Record<string, string | null>>({});
  
  // Role config editor state
  let showRoleConfigModal = $state(false);
  let editingRoleIndex: number | null = $state(null);
  let editingRoleName = $state('');
  let editingRoleSponsorTier = $state('');
  let editingRoleDescription = $state('');
  let editingRoleQuota = $state('');
  let editingRoleAllowAdvancedFeatures = $state(false);
  
  // Sponsors viewer state
  let showSponsorsModal = $state(false);
  let sponsors = $state<any[]>([]);
  let sponsorsPage = $state(1);
  let sponsorsTotalPages = $state(1);
  let sponsorsTotal = $state(0);
  let loadingSponsors = $state(false);
  let hideExpired = $state(true);
  const SPONSORS_PAGE_SIZE = 50;
  let sponsorsFiltered = $derived(hideExpired ? sponsors.filter((s: any) => !s.db?.expiresAt || new Date(s.db.expiresAt) > new Date()) : sponsors);
  let sponsorsFilteredTotal = $derived(sponsorsFiltered.length);
  let sponsorsActiveTotal = $derived(sponsors.filter((s: any) => !s.db?.expiresAt || new Date(s.db.expiresAt) > new Date()).length);
  let sponsorsFilteredTotalPages = $derived(Math.max(1, Math.ceil(sponsorsFilteredTotal / SPONSORS_PAGE_SIZE)));
  $effect(() => { hideExpired; sponsorsPage = 1; });
  let sponsorsPaged = $derived(sponsorsFiltered.slice((sponsorsPage - 1) * SPONSORS_PAGE_SIZE, sponsorsPage * SPONSORS_PAGE_SIZE));
  let sponsorsSummary = $state({
    total: 0,
    withDiscrepancy: 0,
    missingInCrawler: 0,
    tierMismatch: 0,
    roleMismatch: 0,
    roleMappingMissing: 0,
    dbExpiredButInCrawler: 0,
  });
  let crawlerAvailable = $state(true);
  let crawlerError = $state<string | undefined>(undefined);
  let usersWithRoleButNoClaim = $state<{userId: string, username: string, roles: string[]}[]>([]);

  const discrepancyLabelMap: Record<string, string> = {
    missing_in_crawler: 'Missing in crawler',
    tier_mismatch: 'Tier mismatch',
    role_mismatch: 'Role mismatch',
    role_mapping_missing: 'No role mapping for tier',
    db_expired_but_in_crawler: 'DB expired but still in crawler',
  };
  
  let roleList = $derived(settings.roles ?? []);
  let getAvailableRoleNames = $derived(roleList.map((r: any) => r.name));
  
  function addRoleConfig() {
    const roles = settings.roles ?? [];
    const newRole = {
      name: `role-${roles.length + 1}`,
      sponsorTier: undefined,
      description: '',
      dailyQuota: undefined,
    };
    settings = {
      ...settings,
      roles: [...roles, newRole],
    };
  }

  function removeRoleConfig(index: number) {
    const roles = [...(settings.roles ?? [])];
    const removedRole = roles[index];
    roles.splice(index, 1);
    
    // Remove from quotaPerDay if it exists
    const quotaPerDay = { ...settings.quotaPerDay };
    delete quotaPerDay[removedRole.name];
    
    settings = {
      ...settings,
      roles,
      quotaPerDay,
    };
  }

  function editRoleConfig(index: number) {
    const role = settings.roles?.[index];
    if (!role) return;
    
    editingRoleIndex = index;
    editingRoleName = role.name;
    editingRoleSponsorTier = role.sponsorTier || '';
    editingRoleDescription = role.description || '';
    editingRoleQuota = settings.quotaPerDay?.[role.name]?.toString() || '10';
    editingRoleAllowAdvancedFeatures = role.allowAdvancedFeatures || false;
    showRoleConfigModal = true;
  }

  function saveRoleConfig() {
    if (editingRoleIndex === null) return;
    if (!editingRoleName.trim()) {
      alert('Role name is required');
      return;
    }
    
    const roles = [...(settings.roles ?? [])];
    const oldRoleName = roles[editingRoleIndex].name;
    
    roles[editingRoleIndex] = {
      name: editingRoleName.trim(),
      sponsorTier: editingRoleSponsorTier.trim() || undefined,
      description: editingRoleDescription.trim() || undefined,
      allowAdvancedFeatures: editingRoleAllowAdvancedFeatures,
    };
    
    // Update quotaPerDay
    const quotaPerDay = { ...settings.quotaPerDay };
    const quota = editingRoleQuota ? Number(editingRoleQuota) : 10;
    
    // If name changed, update quota mapping
    if (oldRoleName !== editingRoleName) {
      delete quotaPerDay[oldRoleName];
    }
    quotaPerDay[editingRoleName.trim()] = quota;
    
    settings = {
      ...settings,
      roles,
      quotaPerDay,
    };
    
    closeRoleConfigModal();
  }

  function closeRoleConfigModal() {
    showRoleConfigModal = false;
    editingRoleIndex = null;
    editingRoleName = '';
    editingRoleSponsorTier = '';
    editingRoleDescription = '';
    editingRoleQuota = '';
    editingRoleAllowAdvancedFeatures = false;
  }
  
  async function saveSettings() {
    saving = true;
    try {
      const payload = {
        ...settings,
        loraPresets: sanitizeLoraPresets(settings.loraPresets),
      };
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      if (response.ok) {
        showNotification($_('admin.settings.saved'), 'success');
        // Ensure loraPresets are sanitized after save (for dropdown)
        const newSettings = await response.json();
        settings = {
          ...newSettings,
          loraPresets: sanitizeLoraPresets(newSettings.loraPresets)
        };
      } else {
        const error = await response.json();
        showNotification($_('admin.settings.error', { values: { error: error.error || 'Failed to save settings' } }), 'error');
      }
    } catch (err) {
      showNotification($_('admin.settings.error', { values: { error: String(err) } }), 'error');
    } finally {
      saving = false;
    }
  }
  
  async function loadQueueStatus() {
    loadingQueue = true;
    try {
      const response = await fetch('/api/admin/queue-status');
      if (response.ok) {
        queueStatus = await response.json();
      }
    } catch (err) {
      console.error('Failed to load queue status:', err);
    } finally {
      loadingQueue = false;
    }
  }
  
  async function setUserPage(page: number) {
    const url = new URL(window.location.href);
    url.searchParams.set('userPage', page.toString());
    await goto(url.pathname + url.search, { noScroll: true, replaceState: false });
  }
  
  async function searchUsers() {
    const url = new URL(window.location.href);
    url.searchParams.set('userSearch', userSearch);
    url.searchParams.set('userPage', '1'); // Reset to first page when searching
    await goto(url.pathname + url.search, { noScroll: true, replaceState: false });
  }
  
  async function clearSearch() {
    const url = new URL(window.location.href);
    url.searchParams.delete('userSearch');
    url.searchParams.set('userPage', '1');
    await goto(url.pathname + url.search, { noScroll: true, replaceState: false });
  }
  
  async function unpublishVideo(videoId: string, username: string) {
    if (!confirm(`Unpublish video from ${username}?`)) return;
    
    try {
      const response = await fetch(`/api/admin/videos/${videoId}/unpublish`, {
        method: 'POST',
      });
      
      if (response.ok) {
        showNotification($_('admin.videos.videoUnpublished'), 'success');
        // Reload page to refresh data
        window.location.reload();
      } else {
        const error = await response.json();
        showNotification($_('admin.videos.unpublishError', { values: { error: error.error || 'Failed to unpublish video' } }), 'error');
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
    }
  }
  
  async function updateUserRole(userId: string, username: string, currentRoles: string[]) {
    const roles = currentRoles || [];
    editingUser = { id: userId, username, roles };
    roleInput = roles.join(', ');
    roleExpirations = {};
    // Load existing manual role expirations so the modal can show/edit them
    try {
      const res = await fetch(`/api/admin/users/${userId}/roles`);
      if (res.ok) {
        const data = await res.json();
        roleExpirations = data.expirations || {};
      }
    } catch (err) {
      console.error('Failed to load role expirations:', err);
    }
    showRoleModal = true;
  }
  
  async function saveUserRole() {
    if (!editingUser) return;
    
    const updatedRoles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    
    try {
      const response = await fetch(`/api/admin/users/${editingUser.id}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: updatedRoles, expirations: roleExpirations }),
      });
      
      if (response.ok) {
        showNotification($_('admin.users.roleUpdated'), 'success');
        // Update local data
        users = users.map((u: any) => u.id === editingUser!.id ? { ...u, roles: updatedRoles } : u);
        closeRoleModal();
      } else {
        const error = await response.json();
        showNotification($_('admin.users.roleError', { values: { error: error.error || 'Failed to update role' } }), 'error');
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
    }
  }
  
  function closeRoleModal() {
    showRoleModal = false;
    editingUser = null;
    roleInput = '';
    roleExpirations = {};
  }
  
  function toggleRole(role: string) {
    const roles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    const index = roles.indexOf(role);
    
    if (index > -1) {
      roles.splice(index, 1);
    } else {
      roles.push(role);
    }
    
    roleInput = roles.join(', ');
  }
  
  function isRoleSelected(role: string) {
    const roles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    return roles.includes(role);
  }

  // ---- Per-role expiration (manual claims reuse the claim expiry mechanism) ----
  function getRoleExpiryDatetime(role: string): string {
    const iso = roleExpirations[role];
    if (!iso) return '';
    // Convert ISO to local datetime-local input value
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function setRoleExpiryDatetime(role: string, value: string) {
    if (!value) {
      roleExpirations = { ...roleExpirations, [role]: null };
    } else {
      roleExpirations = { ...roleExpirations, [role]: new Date(value).toISOString() };
    }
  }
  function clearRoleExpiry(role: string) {
    roleExpirations = { ...roleExpirations, [role]: null };
  }

  function addLoraPreset() {
    const next = {
      id: 'new-lora.safetensors',
      label: 'New LoRA',
      nodeId: '61:dyn1',
      default: 1,
      min: 0,
      max: 1.5,
      step: 0.05,
      chain: 'high' as const,
      isConfigurable: true,
      enabled: true,
      tags: [],
      presetGroup: 'Custom',
      autoAddToWorkflows: false,
    };
    settings = {
      ...settings,
      loraPresets: [...(settings.loraPresets || []), next],
    };
  }

  function removeLoraPreset(index: number) {
    const list = [...(settings.loraPresets || [])];
    list.splice(index, 1);
    settings = { ...settings, loraPresets: list };
  }

  function updateLoraPreset(index: number, field: string, value: string | number | boolean | string[]) {
    const list = [...(settings.loraPresets || [])];
    if (!list[index]) return;
    const preset = { ...list[index] } as any;
    if (['default', 'min', 'max', 'step'].includes(field)) {
      preset[field] = Number(value);
    } else if (['enabled', 'autoAddToWorkflows', 'isConfigurable'].includes(field)) {
      preset[field] = Boolean(value);
    } else {
      preset[field] = value;
    }
    list[index] = preset;
    settings = { ...settings, loraPresets: list };
  }

  function addTagToLoraPreset(index: number, tag: string) {
    if (!tag.trim()) return;
    const list = [...(settings.loraPresets || [])];
    const preset = { ...list[index] } as any;
    const tags = new Set([...(preset.tags || []), tag.toLowerCase().trim()]);
    preset.tags = Array.from(tags);
    list[index] = preset;
    settings = { ...settings, loraPresets: list };
  }
  function removeTagFromLoraPreset(index: number, tag: string) {
    const list = [...(settings.loraPresets || [])];
    const preset = { ...list[index] } as any;
    preset.tags = (preset.tags || []).filter((t: string) => t !== tag);
    list[index] = preset;
    settings = { ...settings, loraPresets: list };
  }
  
  function openWorkflowModal(workflow?: any) {
    if (workflow) {
      editingWorkflowId = workflow.id;
      workflowName = workflow.name;
      workflowDescription = workflow.description || '';
      workflowTemplatePath = workflow.templatePath;
      workflowType = workflow.workflowType || 'i2v';
      workflowIsDefault = workflow.isDefault;
      workflowCompatibleLoras = workflow.compatibleLoraIds || [];
      workflowTags = workflow.tags || [];
      workflowAutoInclude = workflow.autoIncludeNewLoras ?? true;
      workflowPresetGroup = workflow.presetGroup || '';
      workflowQuotaCost = typeof workflow.quotaCost === 'number' && workflow.quotaCost >= 1 ? workflow.quotaCost : 1;
      workflowQuotaCostRules = (workflow.quotaCostRules || []).map((r: any) => ({ ...r, when: { ...(r.when || {}) } }));
    } else {
      editingWorkflowId = null;
      workflowName = '';
      workflowDescription = '';
      workflowTemplatePath = 'data/new_workflow.json.tmpl';
      workflowType = 'i2v';
      workflowIsDefault = false;
      workflowTags = [];
      workflowAutoInclude = true;
      workflowPresetGroup = '';
      workflowQuotaCost = 1;
      workflowQuotaCostRules = [];
      // New workflow starts empty — no forced base LoRAs (lightx2v only for wan22 base model, not distilled)
      workflowCompatibleLoras = (settings.loraPresets || []).filter((p: any) => p.autoAddToWorkflows).map((p: any) => p.id);
    }
    workflowTagInput = '';
    workflowLoraFilter = 'all';
    workflowSelectedTagFilter = 'all';
    workflowSelectedGroupFilter = 'all';
    showWorkflowModal = true;
  }
  
  function closeWorkflowModal() {
    showWorkflowModal = false;
    editingWorkflowId = null;
    workflowName = '';
    workflowDescription = '';
    workflowTemplatePath = '';
    workflowType = 'i2v';
    workflowIsDefault = false;
    workflowCompatibleLoras = [];
    workflowTags = [];
    workflowAutoInclude = true;
    workflowPresetGroup = '';
    workflowQuotaCost = 1;
    workflowQuotaCostRules = [];
    workflowTagInput = '';
  }

  function addWorkflowTag(tag: string) {
    if (!tag.trim()) return;
    const t = tag.toLowerCase().trim();
    if (!workflowTags.includes(t)) workflowTags = [...workflowTags, t];
    workflowTagInput = '';
  }
  function removeWorkflowTag(tag: string) {
    workflowTags = workflowTags.filter(t => t !== tag);
  }

  function suggestAndApplyLoras() {
    // Auto-suggest: PRIMARY by presetGroup (model family e.g. wan22 / dasiwa-v1 — fully configurable name), secondary by tags
    const allPresets = settings.loraPresets || [];
    const suggested = allPresets.filter((p: any) => {
      if (p.autoAddToWorkflows) return true;
      // Primary: same presetGroup (configurable free-form name)
      if (workflowPresetGroup && p.presetGroup) {
        if (p.presetGroup.toLowerCase() !== workflowPresetGroup.toLowerCase()) return false;
        if (workflowTags.length && Array.isArray(p.tags) && p.tags.length) {
          return p.tags.some((tg: string) => workflowTags.includes(tg.toLowerCase()));
        }
        return true;
      }
      if (workflowTags.length && Array.isArray(p.tags)) {
        return p.tags.some((tg: string) => workflowTags.includes(tg.toLowerCase()));
      }
      return false;
    }).map((p: any) => p.id);
    workflowCompatibleLoras = [...new Set([...workflowCompatibleLoras, ...suggested])];
    showNotification(suggested.length ? `Auto-selected ${suggested.length} LoRAs by group "${workflowPresetGroup || 'tags'}"` : 'No matching LoRAs for current group/tags', 'info');
  }

  function bulkSelectLorasByFilter() {
    const allPresets = settings.loraPresets || [];
    let filtered = allPresets as any[];
    if (workflowSelectedTagFilter !== 'all') {
      filtered = filtered.filter((p: any) => (p.tags || []).includes(workflowSelectedTagFilter));
    }
    if (workflowSelectedGroupFilter !== 'all') {
      filtered = filtered.filter((p: any) => p.presetGroup === workflowSelectedGroupFilter);
    }
    const ids = filtered.map((p: any) => p.id);
    if (ids.length) {
      workflowCompatibleLoras = [...new Set([...workflowCompatibleLoras, ...ids])];
    }
  }

  function clearAllLorasInModal() {
    workflowCompatibleLoras = [];
  }

  function selectAllLorasInModal() {
    workflowCompatibleLoras = (settings.loraPresets || []).map((p: any) => p.id);
  }
  
  function toggleLoraInModal(loraId: string) {
    if (workflowCompatibleLoras.includes(loraId)) {
      workflowCompatibleLoras = workflowCompatibleLoras.filter(id => id !== loraId);
    } else {
      workflowCompatibleLoras = [...workflowCompatibleLoras, loraId];
    }
  }

  // ---- Quota cost rules editor ----
  function addQuotaCostRule() {
    workflowQuotaCostRules = [
      ...workflowQuotaCostRules,
      {
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: '',
        multiplier: 2,
        when: {},
      },
    ];
  }
  function removeQuotaCostRule(index: number) {
    workflowQuotaCostRules = workflowQuotaCostRules.filter((_, i) => i !== index);
  }
  function updateQuotaCostRule(index: number, patch: any) {
    workflowQuotaCostRules = workflowQuotaCostRules.map((r, i) =>
      i === index ? { ...r, ...patch } : r
    );
  }
  function updateQuotaCostRuleWhen(index: number, patch: any) {
    workflowQuotaCostRules = workflowQuotaCostRules.map((r, i) =>
      i === index ? { ...r, when: { ...(r.when || {}), ...patch } } : r
    );
  }
  function toggleLoraInRule(ruleIndex: number, field: 'notUsingLoras' | 'usingLoras', loraId: string) {
    const list = (workflowQuotaCostRules[ruleIndex]?.when?.[field] as string[]) || [];
    const next = list.includes(loraId) ? list.filter(id => id !== loraId) : [...list, loraId];
    updateQuotaCostRuleWhen(ruleIndex, { [field]: next });
  }
  
  async function saveWorkflow() {
    if (!workflowName.trim() || !workflowTemplatePath.trim()) {
      showNotification('Workflow name and template path are required', 'error');
      return;
    }

    // Auto-purge ghost LoRAs: ids that no longer exist in loraPresets
    // (rename/delete leaves orphan compatibleLoraIds that break generation)
    const validIds = new Set((settings.loraPresets || []).map((p: any) => p.id));
    const purgedIds = workflowCompatibleLoras.filter((id: string) => !validIds.has(id));
    if (purgedIds.length) workflowCompatibleLoras = workflowCompatibleLoras.filter((id: string) => validIds.has(id));
    const cleanedRules = workflowQuotaCostRules.map((r: any) => {
      const w = r?.when || {};
      const notUsing = Array.isArray(w.notUsingLoras) ? w.notUsingLoras.filter((id: string) => validIds.has(id)) : w.notUsingLoras;
      const using = Array.isArray(w.usingLoras) ? w.usingLoras.filter((id: string) => validIds.has(id)) : w.usingLoras;
      if (notUsing?.length === w.notUsingLoras?.length && using?.length === w.usingLoras?.length) return r;
      return { ...r, when: { ...w, notUsingLoras: notUsing, usingLoras: using } };
    });
    if (JSON.stringify(cleanedRules) !== JSON.stringify(workflowQuotaCostRules)) workflowQuotaCostRules = cleanedRules;
    if (purgedIds.length) showNotification(`Auto-removed ${purgedIds.length} orphan LoRA(s): ${purgedIds.slice(0,3).join(', ')}`, 'info');

    savingWorkflow = true;
    try {
      const payload = {
        name: workflowName.trim(),
        description: workflowDescription.trim() || undefined,
        templatePath: workflowTemplatePath.trim(),
        workflowType: workflowType,
        isDefault: workflowIsDefault,
        compatibleLoraIds: workflowCompatibleLoras,
        tags: workflowTags,
        autoIncludeNewLoras: workflowAutoInclude,
        presetGroup: workflowPresetGroup || undefined,
        quotaCost: workflowQuotaCost,
        quotaCostRules: workflowQuotaCostRules,
      };

      if (editingWorkflowId) {
        // Update existing workflow
        const response = await fetch(`/api/admin/workflows/${editingWorkflowId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        
        if (response.ok) {
          const updated = await response.json();
          workflows = workflows.map(w => w.id === editingWorkflowId ? updated : w);
          showNotification('Workflow updated successfully', 'success');
          closeWorkflowModal();
        } else {
          const error = await response.json();
          showNotification(`Failed to update workflow: ${error.error || 'Unknown error'}`, 'error');
        }
      } else {
        // Create new workflow
        const response = await fetch('/api/admin/workflows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: workflowName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            ...payload
          }),
        });
        
        if (response.ok) {
          const created = await response.json();
          workflows = [...workflows, created];
          showNotification('Workflow created successfully', 'success');
          closeWorkflowModal();
        } else {
          const error = await response.json();
          showNotification(`Failed to create workflow: ${error.error || 'Unknown error'}`, 'error');
        }
      }
    } catch (err) {
      showNotification(`Error: ${String(err)}`, 'error');
    } finally {
      savingWorkflow = false;
    }
  }
  
  async function deleteWorkflow(workflowId: string, workflowName: string) {
    if (!confirm(`Are you sure you want to delete workflow "${workflowName}"?`)) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/workflows/${workflowId}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        workflows = workflows.filter(w => w.id !== workflowId);
        showNotification('Workflow deleted successfully', 'success');
      } else {
        const error = await response.json();
        showNotification(`Failed to delete workflow: ${error.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showNotification(`Error: ${String(err)}`, 'error');
    }
  }

  async function restoreWorkflow(workflowId: string, workflowName: string) {
    try {
      const response = await fetch(`/api/admin/workflows/${workflowId}/restore`, {
        method: 'POST',
      });
      
      if (response.ok) {
        const restored = await response.json();
        workflows = workflows.map(w => w.id === workflowId ? restored : w);
        showNotification(`Workflow "${workflowName}" restored successfully`, 'success');
      } else {
        const error = await response.json();
        showNotification(`Failed to restore workflow: ${error.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showNotification(`Error: ${String(err)}`, 'error');
    }
  }
  
  async function setDefaultWorkflow(workflowId: string) {
    try {
      const response = await fetch(`/api/admin/workflows/${workflowId}/default`, {
        method: 'POST',
      });
      
      if (response.ok) {
        const workflow = workflows.find(w => w.id === workflowId);
        const workflowType = workflow?.workflowType || 'i2v';
        // Update all workflows - unset default on others of the same type
        workflows = workflows.map(w => ({ 
          ...w, 
          isDefault: w.id === workflowId ? true : (w.workflowType === workflowType ? false : w.isDefault)
        }));
        showNotification(`Default ${workflowType.toUpperCase()} workflow updated`, 'success');
      } else {
        const error = await response.json();
        showNotification(`Failed to set default: ${error.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showNotification(`Error: ${String(err)}`, 'error');
    }
  }

  async function loadSponsors(page: number = 1) {
    loadingSponsors = true;
    try {
      const response = await fetch(`/api/admin/sponsors?page=${page}&limit=20`);
      if (response.ok) {
        const data = await response.json();
        const list = data.sponsors || [];
        const safePage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(list.length / SPONSORS_PAGE_SIZE)));

        sponsors = list;
        sponsorsSummary = data.summary || sponsorsSummary;
        crawlerAvailable = data.crawlerAvailable ?? true;
        crawlerError = data.crawlerError;
        usersWithRoleButNoClaim = data.usersWithRoleButNoClaim || [];
        sponsorsTotal = list.length;
        sponsorsPage = safePage;
      } else {
        showNotification('Failed to load sponsors', 'error');
      }
    } catch (err) {
      showNotification(`Error loading sponsors: ${String(err)}`, 'error');
    } finally {
      loadingSponsors = false;
    }
  }

  function openSponsorsModal() {
    showSponsorsModal = true;
    loadSponsors(1);
  }

  function closeSponsorsModal() {
    showSponsorsModal = false;
    sponsors = [];
    sponsorsPage = 1;
    sponsorsSummary = {
      total: 0,
      withDiscrepancy: 0,
      missingInCrawler: 0,
      tierMismatch: 0,
      roleMismatch: 0,
      roleMappingMissing: 0,
      dbExpiredButInCrawler: 0,
    };
    crawlerAvailable = true;
    crawlerError = undefined;
    usersWithRoleButNoClaim = [];
    hideExpired = true;
  }

  async function updateWorkflow(workflowId: string, compatibleLoraIds: string[]) {
    savingWorkflow = true;
    try {
      const response = await fetch(`/api/admin/workflows/${workflowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compatibleLoraIds }),
      });
      
      if (response.ok) {
        const updated = await response.json();
        workflows = workflows.map(w => w.id === workflowId ? updated : w);
        showNotification('Workflow updated successfully', 'success');
      } else {
        const error = await response.json();
        showNotification(`Failed to update workflow: ${error.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showNotification(`Error: ${String(err)}`, 'error');
    } finally {
      savingWorkflow = false;
    }
  }
  
  function toggleLoraForWorkflow(workflowId: string, loraId: string) {
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow) return;
    
    const currentIds = workflow.compatibleLoraIds || [];
    const newIds = currentIds.includes(loraId)
      ? currentIds.filter(id => id !== loraId)
      : [...currentIds, loraId];
    
    // Update local state immediately for better UX
    workflows = workflows.map(w => 
      w.id === workflowId ? { ...w, compatibleLoraIds: newIds } : w
    );
    
    // Save to server
    updateWorkflow(workflowId, newIds);
  }
  
  // Sync workflows when data changes
  $effect(() => {
    workflows = data.workflows || [];
  });
  
  // Load queue status on mount
  $effect(() => {
    if (typeof window !== 'undefined') {
      loadQueueStatus();
    }
  });
</script>

<div class="container mx-auto p-6 max-w-6xl">
  <h1 class="text-3xl font-bold mb-6">{$_('admin.title')}</h1>
  
  <!-- Toast notifications -->
  {#if showToast}
    <div class="toast toast-top toast-end z-[9999]">
      <div class="alert" class:alert-success={toastType === 'success'} class:alert-error={toastType === 'error'} class:alert-info={toastType === 'info'}>
        <span>{toastMessage}</span>
      </div>
    </div>
  {/if}

  <!-- Video Management -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">Video Management</h2>
      
      <div class="space-y-4">
        <p class="text-sm opacity-70">Review and manage all user videos</p>
        
        <a href="/admin/videos" class="btn btn-primary">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Manage All Videos
        </a>
      </div>
    </div>
  </div>
  
  <!-- System Settings -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">{$_('admin.settings.title')}</h2>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control">
          <label class="label cursor-pointer" for="registration-enabled">
            <span class="label-text text-lg">{$_('admin.settings.enableRegistration')}</span>
            <input id="registration-enabled" type="checkbox" bind:checked={settings.registrationEnabled} class="toggle toggle-primary" />
          </label>
        </div>
        <div class="form-control">
          <label class="label" for="registration-passcode">
            <span class="label-text">{$_('admin.settings.registrationPasscode')}</span>
            <span class="label-text-alt text-xs opacity-70">{$_('admin.settings.registrationPasscodeHelp')}</span>
          </label>
          <input id="registration-passcode" type="text" bind:value={settings.registrationPasscode} class="input input-bordered" placeholder={$_('admin.settings.registrationPasscodePlaceholder')} />
        </div>
      </div>

      <div class="divider">Role Configuration</div>
      
      <div class="space-y-4">
        <p class="text-sm opacity-70">Manage user roles and their sponsor tier mappings.</p>
        
        <div class="flex justify-end mb-4">
          <button class="btn btn-sm btn-outline" onclick={addRoleConfig}>+ Add Role</button>
        </div>
        
        {#if roleList && roleList.length > 0}
          <div class="overflow-x-auto">
            <table class="table table-zebra">
              <thead>
                <tr>
                  <th>Role Name</th>
                  <th>Sponsor Tier Mapping</th>
                  <th>Description</th>
                  <th>Daily Quota</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each roleList as role, idx}
                  <tr>
                    <td class="font-semibold">{role.name}</td>
                    <td>{role.sponsorTier || '-'}</td>
                    <td class="text-sm opacity-70">{role.description || '-'}</td>
                    <td>{settings.quotaPerDay?.[role.name] ?? 10}</td>
                    <td>
                      <button 
                        class="btn btn-xs btn-outline"
                        onclick={() => editRoleConfig(idx)}
                      >
                        Edit
                      </button>
                      <button 
                        class="btn btn-xs btn-outline btn-error ml-2"
                        onclick={() => removeRoleConfig(idx)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-base-content/70">No roles configured. Click "Add Role" to create one.</p>
        {/if}
      </div>
      
      <div class="divider">System Settings</div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control">
          <label class="label" for="free-user-queue-limit">
            <span class="label-text">Free User Queue Limit</span>
            <span class="label-text-alt text-xs opacity-70">Max concurrent jobs for free users</span>
          </label>
          <input id="free-user-queue-limit" type="number" bind:value={settings.freeUserQueueLimit} class="input input-bordered" min="1" />
        </div>
        
        <div class="form-control">
          <label class="label" for="paid-user-queue-limit">
            <span class="label-text">Paid User Queue Limit</span>
            <span class="label-text-alt text-xs opacity-70">Max concurrent jobs for paid users</span>
          </label>
          <input id="paid-user-queue-limit" type="number" bind:value={settings.paidUserQueueLimit} class="input input-bordered" min="1" />
        </div>
        
        <div class="form-control">
          <label class="label" for="max-queue">
            <span class="label-text">Max Queue Threshold</span>
            <span class="label-text-alt text-xs opacity-70">Max RunPod queue size before rejecting</span>
          </label>
          <input id="max-queue" type="number" bind:value={settings.maxQueueThreshold} class="input input-bordered" min="100" />
        </div>
        
        <div class="form-control">
          <label class="label cursor-pointer" for="local-queue-enabled">
            <span class="label-text">Enable Local Queue</span>
            <input 
              id="local-queue-enabled"
              type="checkbox" 
              checked={settings.localQueueThreshold > 0}
              onchange={(e) => settings.localQueueThreshold = e.target.checked ? 10 : 0}
              class="toggle toggle-primary"
            />
          </label>
          <label class="label">
            <span class="label-text-alt text-xs opacity-70">When disabled, all jobs go directly to RunPod</span>
          </label>
        </div>
        
        <div class="form-control">
          <label class="label" for="local-queue-migration-threshold">
            <span class="label-text">Local Queue Migration Threshold</span>
            <span class="label-text-alt text-xs opacity-70">Migrate to RunPod when local queue exceeds this</span>
          </label>
          <input id="local-queue-migration-threshold" type="number" bind:value={settings.localQueueMigrationThreshold} class="input input-bordered" min="1" />
        </div>
        
        <div class="form-control">
          <label class="label" for="free-user-wait-threshold">
            <span class="label-text">Free User Wait Threshold (minutes)</span>
            <span class="label-text-alt text-xs opacity-70">How long free users wait before RunPod migration</span>
          </label>
          <input id="free-user-wait-threshold" type="number" bind:value={settings.freeUserWaitThresholdMinutes} class="input input-bordered" min="1" />
        </div>
      </div>
      
      <p class="text-xs opacity-60 mt-3">Smart queue management: All jobs enter local queue first. Paid users and free users who waited 30+ minutes are migrated to RunPod when local queue is full.</p>
      
      <div class="divider">Sponsor API Configuration</div>
      
      <div class="flex justify-between items-center mb-4">
        <p class="text-sm opacity-70">Configure sponsor API and view all registered sponsors</p>
        <button class="btn btn-sm btn-outline" onclick={openSponsorsModal}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          View Sponsors
        </button>
      </div>
      
      <div class="grid grid-cols-1 gap-4">
        <div class="form-control">
          <label class="label" for="sponsor-api-url">
            <span class="label-text">Sponsor API URL</span>
            <span class="label-text-alt text-xs opacity-70">GmCrawler endpoint (e.g., http://localhost:3999)</span>
          </label>
          <input id="sponsor-api-url" type="text" bind:value={settings.sponsorApiUrl} class="input input-bordered" placeholder="http://localhost:3999" />
        </div>
        
        <div class="form-control">
          <label class="label" for="sponsor-api-token">
            <span class="label-text">Sponsor API Token</span>
            <span class="label-text-alt text-xs opacity-70">Bearer token for authentication</span>
          </label>
          <input id="sponsor-api-token" type="password" bind:value={settings.sponsorApiToken} class="input input-bordered" placeholder="Enter auth token" />
          
          {#if settings.sponsorApiToken && tokenStatus.message}
            <div class="alert alert-sm mt-2" 
                 class:alert-error={tokenStatus.severity === 'error'} 
                 class:alert-warning={tokenStatus.severity === 'warning'}
                 class:alert-info={tokenStatus.severity === 'info'}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-5 h-5">
                {#if tokenStatus.severity === 'error'}
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                {:else if tokenStatus.severity === 'warning'}
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                {:else}
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                {/if}
              </svg>
              <span class="text-sm">{tokenStatus.message}</span>
            </div>
          {/if}
        </div>
        
        <div class="form-control">
          <label class="label" for="device-id">
            <span class="label-text">Device ID</span>
            <span class="label-text-alt text-xs opacity-70">Unique identifier for device (sent as query param)</span>
          </label>
          <input id="device-id" type="text" bind:value={settings.deviceId} class="input input-bordered" placeholder="123456" />
        </div>
      </div>
      
      <p class="text-xs opacity-60 mt-3">Used for sponsor claim validation and daily revalidation. Environment variables will be used as fallback if not set.</p>
      
      <div class="card-actions justify-end mt-4">
        <button class="btn btn-primary" onclick={saveSettings} disabled={saving}>
          {saving ? $_('admin.settings.saving') : $_('admin.settings.save')}
        </button>
      </div>
    </div>
  </div>

  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <div class="flex items-center justify-between mb-4">
        <h2 class="card-title text-2xl">Workflows</h2>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-outline" onclick={() => { bulkSelectedLoraIds = []; bulkTargetWorkflowIds = workflows.map((w:any)=>w.id); bulkAction='add'; showLoraBulkModal=true; }}>Bulk Assign</button>
          <button class="btn btn-primary btn-sm" onclick={() => openWorkflowModal()}>+ Add</button>
        </div>
      </div>

      {#if workflows && workflows.length > 0}
        <div class="grid grid-cols-1 gap-4">
          {#each workflows as workflow}
            <div class="card bg-base-100 shadow border border-base-300">
              <div class="card-body p-4">
                <div class="flex items-start justify-between gap-4">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <h3 class="text-lg font-bold">{workflow.name}</h3>
                      <span class="badge badge-sm" class:badge-info={workflow.workflowType === 'i2v'} class:badge-secondary={workflow.workflowType === 'fl2v'}>
                        {workflow.workflowType?.toUpperCase()}
                      </span>
                      {#if workflow.isDefault}<span class="badge badge-primary badge-sm">Default</span>{/if}
                      {#if (workflow as any).autoIncludeNewLoras}<span class="badge badge-ghost badge-sm" title="Auto includes new matching LoRAs">auto+</span>{/if}
                      <span class="badge badge-warning badge-sm" title="Credits consumed per video">{(workflow as any).quotaCost ?? 1} credit{(workflow as any).quotaCost > 1 ? 's' : ''}/video</span>
                      {#if workflow.isDeleted}<span class="badge badge-error badge-sm">Deleted</span>{/if}
                    </div>
                    {#if workflow.description}<p class="text-sm opacity-70 mt-1">{workflow.description}</p>{/if}
                    <p class="text-xs opacity-50 mt-1 font-mono truncate">{workflow.templatePath}</p>
                    <div class="flex gap-1.5 flex-wrap mt-2">
                      {#each (workflow as any).tags as t}<span class="badge badge-sm badge-outline">{t}</span>{/each}
                      {#if !(workflow as any).tags?.length}<span class="text-xs opacity-40">no tags</span>{/if}
                    </div>
                  </div>
                  <div class="flex flex-col sm:flex-row gap-2 shrink-0">
                    {#if !workflow.isDefault && !workflow.isDeleted}
                      <button class="btn btn-xs btn-outline" onclick={() => setDefaultWorkflow(workflow.id)}>Set Default {workflow.workflowType?.toUpperCase()}</button>
                    {/if}
                    {#if !workflow.isDeleted}
                      <button class="btn btn-xs btn-outline" onclick={() => openWorkflowModal(workflow)}>Edit</button>
                    {/if}
                    {#if workflow.isDeleted}
                      <button class="btn btn-xs btn-outline btn-success" onclick={() => restoreWorkflow(workflow.id, workflow.name)}>Restore</button>
                    {:else}
                      <button class="btn btn-xs btn-outline btn-error" onclick={() => deleteWorkflow(workflow.id, workflow.name)} disabled={workflow.isDefault}>Delete</button>
                    {/if}
                  </div>
                </div>

                <div class="mt-3">
                  <div class="flex items-center gap-2 text-sm">
                    <span class="opacity-70">LoRAs:</span>
                    <span class="badge badge-sm badge-primary">{workflow.compatibleLoraIds?.length || 0} assigned</span>
                    <button class="btn btn-xs btn-ghost" onclick={() => openWorkflowModal(workflow)}>manage</button>
                  </div>
                  {#if workflow.compatibleLoraIds?.length}
                    <div class="flex flex-wrap gap-1 mt-2">
                      {#each workflow.compatibleLoraIds.slice(0, 8) as lid}
                        {@const p = (settings.loraPresets || []).find((x:any)=>x.id===lid)}
                        <span class="badge badge-xs" class:badge-ghost={!p} title={lid}>{p?.label || lid.slice(0,18)}</span>
                      {/each}
                      {#if workflow.compatibleLoraIds.length > 8}<span class="text-xs opacity-60">+{workflow.compatibleLoraIds.length-8} more</span>{/if}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-base-content/70">No workflows found.</p>
      {/if}
    </div>
  </div>

  <!-- LoRA Presets - OPTIMIZED WITH GROUPS, TAGS, AUTO MECHANISM -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 class="card-title text-2xl">LoRA Presets
          <span class="badge badge-sm badge-info ml-2">{settings.loraPresets?.length || 0}</span>
        </h2>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-outline" onclick={addLoraPreset}>+ Add LoRA</button>
        </div>
      </div>
      <p class="text-xs opacity-50 mb-3">Group = model family (wan22 / dasiwa-...). Tags = style, optional.</p>

      {#if settings.loraPresets && settings.loraPresets.length > 0}
        <!-- Grouped view -->
        {#each Array.from(new Set((settings.loraPresets as any[]).map((p:any)=>p.presetGroup || 'Custom'))) as groupName}
          {@const groupPresets = (settings.loraPresets as any[]).map((p, idx) => ({ p, idx })).filter(({p}: any)=> (p.presetGroup||'Custom')===groupName)}
          <div class="mb-6">
            <div class="flex items-center gap-2 mb-2">
              <h3 class="font-semibold">{groupName}</h3>
              <span class="badge badge-sm badge-ghost">{groupPresets.length}</span>
              <button class="btn btn-xs btn-ghost" onclick={() => { bulkSelectedLoraIds = groupPresets.map(({p}:any)=>p.id); bulkTargetWorkflowIds = workflows.map((w:any)=>w.id); bulkAction='add'; showLoraBulkModal=true; }}>Add this group to workflows…</button>
            </div>
            <div class="overflow-x-auto">
              <table class="table table-zebra table-sm">
                <thead>
                  <tr>
                    <th>ID / Label</th>
                    <th>Chain / Group</th>
                    <th>Tags</th>
                    <th>Default</th>
                    <th>Auto-add</th>
                    <th>Default ON</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each groupPresets as { p: preset, idx: i } (preset.id + i)}
                    <tr>
                      <td style="min-width: 240px;">
                        <div class="flex items-center gap-1">
                          <div class="flex-1">
                            <input type="text" class="input input-bordered input-xs w-full mb-1" value={preset.id} oninput={(e) => updateLoraPreset(i, 'id', e.currentTarget.value)} placeholder="file.safetensors" />
                            <input type="text" class="input input-bordered input-xs w-full" value={preset.label} oninput={(e) => updateLoraPreset(i, 'label', e.currentTarget.value)} placeholder="Display name" />
                          </div>
                          {#if (preset as any).isConfigurable === false}
                            <span class="badge badge-xs badge-warning rotate-0 shrink-0" title="Required for base model — prevents broken output if disabled (e.g. lightx2v)">req</span>
                          {/if}
                        </div>
                        {#if (preset as any).isConfigurable === false}<div class="text-[9px] opacity-60 mt-1">Required — can't be disabled. <button class="link text-[9px]" onclick={() => updateLoraPreset(i, 'isConfigurable', true)}>Make optional</button></div>{/if}
                      </td>
                      <td>
                        <select class="select select-bordered select-xs" value={preset.chain} onchange={(e) => updateLoraPreset(i, 'chain', e.currentTarget.value)}>
                          <option value="high">High</option>
                          <option value="low">Low</option>
                        </select>
                        <div class="mt-1">
                          <input list="preset-groups-list" class="input input-bordered input-xs w-full" value={preset.presetGroup || 'Custom'} oninput={(e) => updateLoraPreset(i, 'presetGroup', e.currentTarget.value)} placeholder="wan22 / dasiwa-old / any name" />
                          <datalist id="preset-groups-list">
                            {#each allLoraGroups as g}<option value={g}></option>{/each}
                            {#each workflows.map((w:any)=>w.presetGroup).filter(Boolean) as g}<option value={g}></option>{/each}
                          </datalist>
                        </div>
                      </td>
                      <td style="min-width: 160px;">
                        <div class="flex flex-wrap gap-1 mb-1">
                          {#each (preset.tags || []) as t}
                            <span class="badge badge-xs badge-outline gap-1">{t}<button class="ml-1" onclick={() => removeTagFromLoraPreset(i, t)}>✕</button></span>
                          {/each}
                        </div>
                        <div class="join join-horizontal mt-1">
                          <input type="text" placeholder="tag" class="input input-bordered input-xs join-item w-20" onkeydown={(e) => { if(e.key==='Enter'){ const val=(e.target as HTMLInputElement).value; if(val){ addTagToLoraPreset(i, val); (e.target as HTMLInputElement).value=''; } } }} />
                        </div>
                      </td>
                      <td>
                        <input type="number" class="input input-bordered input-xs w-16" value={preset.default} min="0" step="0.01" oninput={(e) => updateLoraPreset(i, 'default', Number(e.currentTarget.value))} />
                        <div class="flex gap-1 mt-1">
                          <input title="min" type="number" class="input input-bordered input-xs w-12" value={preset.min ?? 0} step="0.01" oninput={(e) => updateLoraPreset(i, 'min', Number(e.currentTarget.value))} />
                          <input title="max" type="number" class="input input-bordered input-xs w-12" value={preset.max ?? 1.5} step="0.01" oninput={(e) => updateLoraPreset(i, 'max', Number(e.currentTarget.value))} />
                        </div>
                      </td>
                      <td class="text-center">
                        <input type="checkbox" class="toggle toggle-primary toggle-xs" checked={!!preset.autoAddToWorkflows} onchange={(e) => updateLoraPreset(i, 'autoAddToWorkflows', e.currentTarget.checked)} />
                      </td>
                      <td class="text-center">
                        {#if (preset as any).isConfigurable === false}
                          <span class="badge badge-xs badge-warning" title="Required — always on">ON</span>
                        {:else}
                          <input type="checkbox" class="toggle toggle-primary toggle-xs" checked={((preset as any).defaultEnabled ?? (preset as any).enabled) !== false} onchange={(e) => { updateLoraPreset(i, 'defaultEnabled', e.currentTarget.checked); updateLoraPreset(i, 'enabled', e.currentTarget.checked); }} />
                        {/if}
                      </td>
                      <td>
                        <div class="flex gap-1">
                          {#if (preset as any).isConfigurable !== false}
                            <button class="btn btn-[10px] btn-ghost h-6 min-h-0 px-1 text-[10px] opacity-40 hover:opacity-100" title="Make required (e.g. lightx2v on base model)" onclick={() => updateLoraPreset(i, 'isConfigurable', false)}>req</button>
                          {/if}
                          <button class="btn btn-xs btn-error btn-outline" onclick={() => removeLoraPreset(i)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/each}
      {:else}
        <p class="text-base-content/70">No LoRAs yet.</p>
      {/if}

      <div class="card-actions justify-end mt-4 gap-2">
        <button class="btn btn-primary" onclick={saveSettings} disabled={saving}>
          {#if saving}<span class="loading loading-spinner loading-sm"></span>{/if}
          Save LoRA Presets & Trigger Auto-Compat
        </button>
      </div>
      <p class="text-xs opacity-60 mt-2">Saving detects newly added LoRAs and auto-assigns them to workflows where <code>autoIncludeNewLoras=true</code> or tags overlap or LoRA has <code>autoAddToWorkflows</code>.</p>
    </div>
  </div>
  
  <!-- RunPod Queue Status -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">{$_('admin.queue.title')}</h2>
      
      {#if loadingQueue}
        <div class="flex justify-center">
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      {:else if queueStatus}
        <!-- Local Queue Status -->
        {#if queueStatus.localQueue}
          <div class="mb-6">
            <h3 class="text-lg font-semibold mb-3">Local Queue Status</h3>
            
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">In Queue</div>
                <div class="stat-value text-warning">{queueStatus.localQueue.inQueue || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Processing</div>
                <div class="stat-value text-info">{queueStatus.localQueue.processing || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Completed</div>
                <div class="stat-value text-success">{queueStatus.localQueue.completed || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Failed</div>
                <div class="stat-value text-error">{queueStatus.localQueue.failed || 0}</div>
              </div>
            </div>
            
            <div class="mt-4">
              <div class="alert" class:alert-success={queueStatus.localQueue.enabled} class:alert-warning={!queueStatus.localQueue.enabled}>
                <span>
                  {queueStatus.localQueue.enabled ? '✓ Local queue enabled' : '⚠ Local queue disabled - all jobs route to RunPod'}
                  {#if queueStatus.localQueue.enabled}
                    <br /><small>Migration threshold: {settings.localQueueMigrationThreshold || 5} jobs</small>
                  {/if}
                </span>
              </div>
            </div>
          </div>
        {/if}
        
        <div class="mb-6">
          <h3 class="text-lg font-semibold mb-3">RunPod Job Statistics</h3>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">In Queue</div>
              <div class="stat-value text-warning">{queueStatus.stats?.inQueue || 0}</div>
            </div>
            
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">Processing</div>
              <div class="stat-value text-info">{queueStatus.stats?.inProgress || 0}</div>
            </div>
            
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">Completed</div>
              <div class="stat-value text-success">{queueStatus.stats?.completed || 0}</div>
            </div>
            
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">Failed</div>
              <div class="stat-value text-error">{queueStatus.stats?.failed || 0}</div>
            </div>
          </div>
        </div>

        {#if queueStatus.workers}
          <div class="mb-6">
            <h3 class="text-lg font-semibold mb-3">Worker Status</h3>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Ready</div>
                <div class="stat-value text-success text-2xl">{queueStatus.workers.ready || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Idle</div>
                <div class="stat-value text-info text-2xl">{queueStatus.workers.idle || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Running</div>
                <div class="stat-value text-primary text-2xl">{queueStatus.workers.running || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Initializing</div>
                <div class="stat-value text-warning text-2xl">{queueStatus.workers.initializing || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Throttled</div>
                <div class="stat-value text-warning text-2xl">{queueStatus.workers.throttled || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Unhealthy</div>
                <div class="stat-value text-error text-2xl">{queueStatus.workers.unhealthy || 0}</div>
              </div>
            </div>
          </div>
        {/if}
        
        <div class="mt-4">
          <div class="alert" class:alert-success={queueStatus.available} class:alert-warning={!queueStatus.available}>
            <span>
              Status: {queueStatus.available ? '✓ Available' : '⚠ Unavailable'}
              {#if queueStatus.reason}
                <br /><small>{queueStatus.reason}</small>
              {/if}
            </span>
          </div>
        </div>
      {:else}
        <p class="text-base-content/70">RunPod status not available</p>
      {/if}
      
      <div class="card-actions justify-end mt-4">
        <button class="btn btn-outline" onclick={loadQueueStatus} disabled={loadingQueue}>
          {$_('admin.queue.refresh')}
        </button>
      </div>
    </div>
  </div>

  
  <!-- User Management -->
  <div class="card bg-base-200 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">{$_('admin.users.title')}</h2>
      
      <!-- Search Bar -->
      <div class="form-control mb-4">
        <div class="join w-full max-w-md">
          <input 
            type="text" 
            placeholder={$_('admin.users.search')} 
            class="input input-bordered join-item flex-1"
            bind:value={userSearch}
            onkeydown={(e) => e.key === 'Enter' && searchUsers()}
          />
          <button class="btn join-item" onclick={searchUsers}>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {$_('admin.users.searchButton')}
          </button>
          {#if data.userSearch}
            <button class="btn join-item btn-ghost" onclick={clearSearch}>
              {$_('admin.users.clearSearch')}
            </button>
          {/if}
        </div>
      </div>
      
      <div class="overflow-x-auto">
        <table class="table table-zebra">
          <thead>
            <tr>
              <th>{$_('admin.users.table.username')}</th>
              <th>{$_('admin.users.table.email')}</th>
              <th>{$_('admin.users.table.roles')}</th>
              <th>{$_('admin.users.table.videos')}</th>
              <th>{$_('admin.users.table.createdAt')}</th>
              <th>{$_('admin.users.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each users as user}
              <tr>
                <td class="font-semibold">{user.username}</td>
                <td>{user.email || '-'}</td>
                <td>
                  <div class="flex gap-1 flex-wrap">
                    {#each (user.roles || []) as role}
                      <span class="badge badge-sm" class:badge-primary={role === 'admin'}>
                        {role}
                      </span>
                    {/each}
                  </div>
                </td>
                <td>{user.videoCount}</td>
                <td class="text-sm">{new Date(user.created_at).toLocaleDateString()}</td>
                <td>
                  <button 
                    class="btn btn-xs btn-outline"
                    onclick={() => updateUserRole(user.id, user.username, user.roles)}
                  >
                    {$_('admin.users.editRoles')}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      
      <div class="flex justify-between items-center mt-4">
        <div class="text-sm text-base-content/70">
          {$_('admin.users.total', { values: { count: userTotal } })}
        </div>
        
        {#if userTotalPages > 1}
          <div class="join">
            <button 
              class="join-item btn btn-sm" 
              disabled={userPage === 1}
              onclick={() => setUserPage(userPage - 1)}
            >
              «
            </button>
            {#each Array.from({ length: userTotalPages }, (_, i) => i + 1) as pageNum}
              {#if pageNum === 1 || pageNum === userTotalPages || Math.abs(pageNum - userPage) <= 2}
                <button 
                  class="join-item btn btn-sm" 
                  class:btn-active={pageNum === userPage}
                  onclick={() => setUserPage(pageNum)}
                >
                  {pageNum}
                </button>
              {:else if pageNum === userPage - 3 || pageNum === userPage + 3}
                <button class="join-item btn btn-sm btn-disabled">...</button>
              {/if}
            {/each}
            <button 
              class="join-item btn btn-sm" 
              disabled={userPage === userTotalPages}
              onclick={() => setUserPage(userPage + 1)}
            >
              »
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<!-- Role Config Editor Modal -->
<!-- Sponsors Viewer Modal -->
{#if showSponsorsModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-7xl">
      <h3 class="font-bold text-lg mb-2">Sponsors Cross-Reference ({sponsors.length} total)</h3>
      <p class="text-sm opacity-70 mb-4">Compares crawler sponsors with DB sponsor claims and highlights mismatches.</p>
      
      {#if !crawlerAvailable}
        <div class="alert alert-warning mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
          <div>
            <span class="text-sm">Crawler unavailable - showing DB data only without cross-reference checks.</span>
            {#if crawlerError}
              <br /><span class="text-xs opacity-75">{crawlerError}</span>
            {/if}
          </div>
        </div>
      {/if}
      {#if loadingSponsors}
        <div class="flex justify-center py-8">
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      {:else if sponsors.length > 0}
        <div class="flex flex-wrap items-center gap-2 mb-4">
          <span class="badge badge-outline">Discrepancies: {sponsorsSummary.withDiscrepancy}</span>
          {#if sponsorsSummary.missingInCrawler > 0}
            <span class="badge badge-warning">Missing in crawler: {sponsorsSummary.missingInCrawler}</span>
          {/if}
          {#if sponsorsSummary.tierMismatch > 0}
            <span class="badge badge-error">Tier mismatch: {sponsorsSummary.tierMismatch}</span>
          {/if}
          {#if sponsorsSummary.roleMismatch > 0}
            <span class="badge badge-error">Role mismatch: {sponsorsSummary.roleMismatch}</span>
          {/if}
          {#if sponsorsSummary.roleMappingMissing > 0}
            <span class="badge badge-warning">Missing role mapping: {sponsorsSummary.roleMappingMissing}</span>
          {/if}
          {#if sponsorsSummary.dbExpiredButInCrawler > 0}
            <span class="badge badge-error">DB expired in crawler: {sponsorsSummary.dbExpiredButInCrawler}</span>
          {/if}
          <label class="ml-auto flex items-center gap-2 cursor-pointer select-none text-sm">
            <input type="checkbox" class="checkbox checkbox-sm" bind:checked={hideExpired} />
            Hide expired
          </label>
        </div>

        <div class="overflow-x-auto">
          <table class="table table-zebra">
            <thead>
              <tr>
                <th>Sponsor Username</th>
                <th>Site Username</th>
                <th>Crawler Tier</th>
                <th>DB Tier</th>
                <th>DB Role</th>
                <th>DB Expires</th>
                <th>Discrepancies</th>
              </tr>
            </thead>
            <tbody>
              {#each sponsorsPaged as sponsor}
                <tr class:bg-warning={sponsor.hasDiscrepancy}>
                  <td class="font-semibold">{sponsor.username}</td>
                  <td class="text-sm">{sponsor.dbUsername ?? '-'}</td>
                  <td>
                    {#if sponsor.crawler}
                      <span class="badge badge-primary">{sponsor.crawler.tier || '-'}</span>
                    {:else}
                      <span class="badge badge-ghost">-</span>
                    {/if}
                  </td>
                  <td>
                    {#if sponsor.db}
                      <span class="badge badge-secondary">{sponsor.db.tier || '-'}</span>
                    {:else}
                      <span class="badge badge-ghost">-</span>
                    {/if}
                  </td>
                  <td class="text-sm">{sponsor.db?.appliedRole || '-'}</td>
                  <td class="text-sm">
                    {#if sponsor.db?.expiresAt}
                      {new Date(sponsor.db.expiresAt).toLocaleDateString()}
                    {:else}
                      -
                    {/if}
                  </td>
                  <td>
                    {#if sponsor.discrepancies?.length > 0}
                      <div class="flex flex-wrap gap-1">
                        {#each sponsor.discrepancies as discrepancy}
                          <span class="badge badge-error badge-sm">{discrepancyLabelMap[discrepancy] || discrepancy}</span>
                        {/each}
                        {#if sponsor.expectedRole}
                          <span class="text-xs text-base-content/60">expected: {sponsor.expectedRole}</span>
                        {/if}
                      </div>
                    {:else}
                      <span class="badge badge-success badge-sm">In sync</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        
        {#if sponsorsFilteredTotalPages > 1}
          <div class="flex justify-center mt-4">
            <div class="join">
              <button 
                class="join-item btn btn-sm" 
                disabled={sponsorsPage === 1}
                onclick={() => { sponsorsPage = sponsorsPage - 1; }}
              >
                «
              </button>
              {#each Array.from({ length: sponsorsFilteredTotalPages }, (_, i) => i + 1) as pageNum}
                {#if pageNum === 1 || pageNum === sponsorsFilteredTotalPages || Math.abs(pageNum - sponsorsPage) <= 2}
                  <button 
                    class="join-item btn btn-sm" 
                    class:btn-active={pageNum === sponsorsPage}
                    onclick={() => { sponsorsPage = pageNum; }}
                  >
                    {pageNum}
                  </button>
                {:else if pageNum === sponsorsPage - 3 || pageNum === sponsorsPage + 3}
                  <button class="join-item btn btn-sm btn-disabled">...</button>
                {/if}
              {/each}
              <button 
                class="join-item btn btn-sm" 
                disabled={sponsorsPage === sponsorsFilteredTotalPages}
                onclick={() => { sponsorsPage = sponsorsPage + 1; }}
              >
                »
              </button>
            </div>
          </div>
        {/if}
        
        <div class="text-sm text-base-content/70 mt-4 text-center">
          Active: {sponsorsActiveTotal}, total: {sponsors.length}
        </div>
      {:else}
        <div class="alert alert-info">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span>No sponsors found</span>
        </div>
      {/if}

      {#if usersWithRoleButNoClaim.length > 0}
        <div class="alert alert-warning mt-4">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <div>
            <span class="text-sm font-semibold">{usersWithRoleButNoClaim.length} user{usersWithRoleButNoClaim.length !== 1 ? 's have' : ' has'} a sponsor role but no active claim record:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              {#each usersWithRoleButNoClaim as u}
                <span class="badge badge-outline badge-sm">{u.username} ({u.roles.join(', ')})</span>
              {/each}
            </div>
          </div>
        </div>
      {/if}
      
      <div class="modal-action">
        <button class="btn" onclick={closeSponsorsModal}>Close</button>
      </div>
    </div>
    <button class="modal-backdrop" type="button" onclick={closeSponsorsModal} aria-label="Close modal"></button>
  </div>
{/if}

<!-- Role Config Editor Modal -->
{#if showRoleConfigModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">
        {editingRoleIndex !== null && settings.roles?.[editingRoleIndex] 
          ? `Edit Role: ${settings.roles[editingRoleIndex].name}` 
          : 'Add New Role'}
      </h3>
      
      <div class="form-control mb-4">
        <label class="label" for="role-name">
          <span class="label-text">Role Name</span>
        </label>
        <input 
          id="role-name"
          type="text" 
          bind:value={editingRoleName}
          placeholder="e.g., sponsor-tier"
          class="input input-bordered w-full"
        />
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="sponsor-tier">
          <span class="label-text">Sponsor Tier (from GmCrawler)</span>
          <span class="label-text-alt">Leave empty if not sponsor-based</span>
        </label>
        <input 
          id="sponsor-tier"
          type="text" 
          bind:value={editingRoleSponsorTier}
          placeholder="e.g., premium, vip"
          class="input input-bordered w-full"
        />
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="role-description">
          <span class="label-text">Description</span>
        </label>
        <input 
          id="role-description"
          type="text" 
          bind:value={editingRoleDescription}
          placeholder="User-friendly description"
          class="input input-bordered w-full"
        />
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="daily-quota">
          <span class="label-text">Daily Quota</span>
        </label>
        <input 
          id="daily-quota"
          type="number" 
          bind:value={editingRoleQuota}
          placeholder="10"
          class="input input-bordered w-full"
          min="0"
        />
      </div>
      
      <div class="form-control mb-4">
        <label class="label cursor-pointer">
          <span class="label-text">Allow Advanced Features</span>
          <input 
            type="checkbox" 
            bind:checked={editingRoleAllowAdvancedFeatures}
            class="toggle toggle-primary"
          />
        </label>
        <label class="label">
          <span class="label-text-alt">Enable 720p resolution and other premium features</span>
        </label>
      </div>
      
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={closeRoleConfigModal}>Cancel</button>
        <button class="btn btn-primary" onclick={saveRoleConfig}>Apply</button>
      </div>
    </div>
    <button class="modal-backdrop" type="button" onclick={closeRoleConfigModal} aria-label="Close modal"></button>
  </div>
{/if}

<!-- Role Editor Modal -->
{#if showRoleModal && editingUser}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <h3 class="font-bold text-lg mb-4">{$_('admin.users.roleModal.title', { values: { username: editingUser.username } })}</h3>
      
      <div class="mb-4">
        <p class="text-sm text-base-content/70 mb-2">Select roles:</p>
        <div class="flex flex-wrap gap-2 mb-4">
          {#each getAvailableRoleNames as roleName}
            <button 
              class="btn btn-sm"
              class:btn-primary={isRoleSelected(roleName)}
              class:btn-outline={!isRoleSelected(roleName)}
              onclick={() => toggleRole(roleName)}
            >
              {roleName}
            </button>
          {/each}
        </div>

        <!-- Per-role expiration (optional) -->
        <div class="space-y-2 mt-2">
          {#each getAvailableRoleNames.filter((r: string) => isRoleSelected(r)) as selRole}
            <div class="flex items-center gap-2 border border-base-300 rounded-lg p-2">
              <span class="badge badge-primary badge-sm shrink-0">{selRole}</span>
              <span class="text-xs opacity-60 shrink-0">Expires:</span>
              <input
                type="datetime-local"
                class="input input-bordered input-sm flex-1"
                value={getRoleExpiryDatetime(selRole)}
                onchange={(e) => setRoleExpiryDatetime(selRole, e.currentTarget.value)}
              />
              <button class="btn btn-xs btn-ghost" onclick={() => clearRoleExpiry(selRole)} title="Clear expiry (permanent)">✕</button>
            </div>
          {/each}
          {#if getAvailableRoleNames.filter((r: string) => isRoleSelected(r)).length === 0}
            <p class="text-xs opacity-50">Select roles above to set optional expiration dates.</p>
          {/if}
        </div>
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="role-input">
          <span class="label-text">Roles (comma-separated)</span>
        </label>
        <input 
          id="role-input"
          type="text" 
          bind:value={roleInput}
          placeholder="admin, premium, free"
          class="input input-bordered w-full"
        />
        <p class="label-text-alt text-base-content/60">
          Available: {getAvailableRoleNames.join(', ')}
        </p>
      </div>
      
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={closeRoleModal}>{$_('common.cancel')}</button>
        <button class="btn btn-primary" onclick={saveUserRole}>{$_('admin.users.roleModal.save')}</button>
      </div>
    </div>
    <button class="modal-backdrop" type="button" onclick={closeRoleModal} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && closeRoleModal()} aria-label="Close modal"></button>
  </div>
{/if}

<!-- Workflow Editor Modal -->
{#if showWorkflowModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-5xl">
      <h3 class="font-bold text-lg mb-4">{editingWorkflowId ? 'Edit Workflow' : 'Add New Workflow'}</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="form-control">
          <span class="label-text text-sm">Name</span>
          <input type="text" bind:value={workflowName} placeholder="WAN 2.2, Dasiwa ..." class="input input-bordered input-sm w-full" />
        </label>
        <label class="form-control">
          <span class="label-text text-sm">Template Path</span>
          <input type="text" bind:value={workflowTemplatePath} placeholder="data/..." class="input input-bordered input-sm w-full font-mono" />
        </label>
      </div>

      <label class="form-control mt-3">
        <span class="label-text text-sm">Description</span>
        <input type="text" bind:value={workflowDescription} placeholder="Brief description (shown in review page)" class="input input-bordered input-sm w-full" />
      </label>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <label class="form-control">
          <span class="label-text text-sm">Type</span>
          <select bind:value={workflowType} class="select select-bordered select-sm w-full">
            <option value="i2v">I2V</option>
            <option value="fl2v">FL2V</option>
          </select>
        </label>
        <label class="form-control cursor-pointer flex-row items-center gap-2 mt-5">
          <input type="checkbox" bind:checked={workflowIsDefault} class="checkbox checkbox-sm" />
          <span class="label-text text-sm">Default {workflowType.toUpperCase()}</span>
        </label>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <label class="form-control">
          <span class="label-text text-sm">Group</span>
          <input list="workflow-groups-list" type="text" bind:value={workflowPresetGroup} placeholder="wan22" class="input input-bordered input-sm w-full" />
          <datalist id="workflow-groups-list">
            {#each Array.from(new Set([...allLoraGroups, ...workflows.map((w:any)=>w.presetGroup).filter(Boolean)])) as g}<option value={g}></option>{/each}
          </datalist>
        </label>
        <label class="form-control">
          <span class="label-text text-sm">Quota Cost (credits/video)</span>
          <input type="number" min={1} step={1} bind:value={workflowQuotaCost} class="input input-bordered input-sm w-full" />
        </label>
      </div>

      <!-- Quota cost rules -->
      <div class="mt-4">
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm font-semibold">Quota Cost Rules</span>
          <button class="btn btn-xs btn-outline" onclick={addQuotaCostRule}>+ Add rule</button>
        </div>
        <p class="text-xs opacity-50 mb-2">Multipliers stack on the base cost. e.g. "2x if duration ≥ 8s" or "2x if NOT using a speed-up LoRA".</p>
        {#if workflowQuotaCostRules.length === 0}
          <p class="text-xs opacity-40">No rules — cost is always {workflowQuotaCost} credit{workflowQuotaCost > 1 ? 's' : ''}/video.</p>
        {:else}
          <div class="space-y-3">
            {#each workflowQuotaCostRules as rule, ri (rule.id)}
              <div class="border border-base-300 rounded-lg p-3 space-y-2">
                <div class="flex items-center gap-2">
                  <input type="number" min={1} step={1} bind:value={rule.multiplier} class="input input-bordered input-xs w-20" title="Multiplier" />
                  <span class="text-xs">×</span>
                  <input type="text" placeholder="Label (optional)" bind:value={rule.label} class="input input-bordered input-xs flex-1" />
                  <button class="btn btn-xs btn-error btn-ghost" onclick={() => removeQuotaCostRule(ri)}>✕</button>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <label class="flex items-center gap-2">
                    <span class="opacity-60 shrink-0">Duration ≥</span>
                    <select class="select select-bordered select-xs" value={rule.when.minDuration ?? ''}
                      onchange={(e) => updateQuotaCostRuleWhen(ri, { minDuration: e.currentTarget.value === '' ? undefined : +e.currentTarget.value })}>
                      <option value="">(any)</option>
                      <option value="8">8s</option>
                      <option value="10">10s</option>
                    </select>
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="opacity-60 shrink-0">Resolution</span>
                    <select class="select select-bordered select-xs" value={rule.when.exactResolution ?? ''}
                      onchange={(e) => updateQuotaCostRuleWhen(ri, { exactResolution: e.currentTarget.value === '' ? undefined : e.currentTarget.value })}>
                      <option value="">(any)</option>
                      <option value="480p">480p</option>
                      <option value="720p">720p</option>
                    </select>
                  </label>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <div>
                    <div class="opacity-60 mb-1">Applies when NONE of these LoRAs used:</div>
                    <div class="flex flex-wrap gap-1">
                      {#each (settings.loraPresets || []) as lora}
                        <button class="badge badge-xs badge-ghost cursor-pointer" class:badge-primary={(rule.when.notUsingLoras || []).includes(lora.id)}
                          onclick={() => toggleLoraInRule(ri, 'notUsingLoras', lora.id)}>{lora.label}</button>
                      {/each}
                    </div>
                  </div>
                  <div>
                    <div class="opacity-60 mb-1">Applies when ANY of these LoRAs used:</div>
                    <div class="flex flex-wrap gap-1">
                      {#each (settings.loraPresets || []) as lora}
                        <button class="badge badge-xs badge-ghost cursor-pointer" class:badge-secondary={(rule.when.usingLoras || []).includes(lora.id)}
                          onclick={() => toggleLoraInRule(ri, 'usingLoras', lora.id)}>{lora.label}</button>
                      {/each}
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="text-sm">Tags</span>
            <span class="text-xs opacity-40">optional</span>
          </div>
          <div class="flex flex-wrap gap-1 mb-2 min-h-5">
            {#each workflowTags as t}
              <span class="badge badge-sm badge-primary gap-1">{t} <button onclick={() => removeWorkflowTag(t)}>✕</button></span>
            {/each}
          </div>
          <div class="join w-full">
            <input type="text" class="input input-bordered input-sm join-item flex-1" placeholder="Add tag" bind:value={workflowTagInput} onkeydown={(e) => { if(e.key==='Enter'){ addWorkflowTag(workflowTagInput); } }} />
            <button class="btn btn-sm join-item" onclick={() => addWorkflowTag(workflowTagInput)}>Add</button>
          </div>
        </div>
        <div class="flex flex-col gap-2 justify-end">
          <label class="cursor-pointer flex items-center gap-2">
            <input type="checkbox" bind:checked={workflowAutoInclude} class="checkbox checkbox-sm" />
            <span class="text-sm">Auto-include new matching LoRAs</span>
          </label>
          <button class="btn btn-sm btn-outline w-fit" onclick={suggestAndApplyLoras}>✨ Suggest matching LoRAs</button>
        </div>
      </div>

      <div class="divider my-3 text-xs">LoRAs — {workflowCompatibleLoras.length} selected</div>

      <div class="flex flex-wrap gap-2 mb-2 items-center">
        <select class="select select-bordered select-xs" bind:value={workflowSelectedGroupFilter}>
          <option value="all">All groups</option>
          {#each allLoraGroups as g}<option value={g}>{g}</option>{/each}
        </select>
        <select class="select select-bordered select-xs" bind:value={workflowSelectedTagFilter}>
          <option value="all">All tags</option>
          {#each allLoraTags as t}<option value={t}>{t}</option>{/each}
        </select>
        <button class="btn btn-xs" onclick={bulkSelectLorasByFilter}>Add filtered</button>
        <span class="opacity-20">|</span>
        <button class="btn btn-xs btn-ghost" onclick={selectAllLorasInModal}>All</button>
        <button class="btn btn-xs btn-ghost" onclick={clearAllLorasInModal}>None</button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-[320px] overflow-y-auto p-2 border border-base-200 rounded-lg">
        {#each (settings.loraPresets || []) as lora (lora.id)}
          {@const hiddenByTag = workflowSelectedTagFilter !== 'all' && !(lora.tags||[]).includes(workflowSelectedTagFilter)}
          {@const hiddenByGroup = workflowSelectedGroupFilter !== 'all' && lora.presetGroup !== workflowSelectedGroupFilter}
          {#if !hiddenByTag && !hiddenByGroup}
            <label class="flex items-center gap-2 p-2 rounded hover:bg-base-200 cursor-pointer border border-transparent" class:!border-primary={workflowCompatibleLoras.includes(lora.id)} class:bg-base-200={workflowCompatibleLoras.includes(lora.id)}>
              <input type="checkbox" class="checkbox checkbox-primary checkbox-xs" checked={workflowCompatibleLoras.includes(lora.id)} onchange={() => toggleLoraInModal(lora.id)} />
              <div class="flex-1 min-w-0">
                <span class="text-sm truncate block" title={lora.id}>{lora.label}</span>
                <span class="text-[10px] opacity-50">{lora.presetGroup || '—'} · {lora.chain}</span>
              </div>
            </label>
          {/if}
        {/each}
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={closeWorkflowModal} disabled={savingWorkflow}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={saveWorkflow} disabled={savingWorkflow}>
          {savingWorkflow ? 'Saving...' : (editingWorkflowId ? 'Update' : 'Create')}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" type="button" onclick={closeWorkflowModal} aria-label="Close modal"></button>
  </div>
{/if}

<!-- Bulk LoRA Assignment Modal -->
{#if showLoraBulkModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <h3 class="font-bold text-lg mb-4">Bulk Assign LoRAs to Workflows</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h4 class="font-semibold text-sm mb-2">Select LoRAs ({bulkSelectedLoraIds.length})</h4>
          <div class="border border-base-300 rounded-lg max-h-80 overflow-y-auto p-2 space-y-1">
            {#each (settings.loraPresets || []) as p}
              <label class="flex items-center gap-2 p-1 hover:bg-base-200 rounded cursor-pointer">
                <input type="checkbox" class="checkbox checkbox-xs" checked={bulkSelectedLoraIds.includes(p.id)} onchange={(e)=>{ bulkSelectedLoraIds = e.currentTarget.checked ? [...bulkSelectedLoraIds, p.id] : bulkSelectedLoraIds.filter(x=>x!==p.id); }} />
                <span class="text-xs truncate">{p.label}</span>
                <span class="badge badge-[10px] badge-ghost ml-auto">{p.presetGroup}</span>
              </label>
            {/each}
          </div>
          <div class="flex gap-1 mt-2">
            {#each allLoraGroups.slice(0,4) as g}
              <button class="btn btn-xs btn-ghost" onclick={() => { bulkSelectedLoraIds = (settings.loraPresets||[]).filter((x:any)=>x.presetGroup===g).map((x:any)=>x.id); }}>Select {g}</button>
            {/each}
          </div>
        </div>
        <div>
          <h4 class="font-semibold text-sm mb-2">Target Workflows ({bulkTargetWorkflowIds.length})</h4>
          <div class="border border-base-300 rounded-lg max-h-80 overflow-y-auto p-2 space-y-1">
            {#each workflows as w}
              <label class="flex items-center gap-2 p-1 hover:bg-base-200 rounded cursor-pointer">
                <input type="checkbox" class="checkbox checkbox-xs" checked={bulkTargetWorkflowIds.includes(w.id)} onchange={(e)=>{ bulkTargetWorkflowIds = e.currentTarget.checked ? [...bulkTargetWorkflowIds, w.id] : bulkTargetWorkflowIds.filter(x=>x!==w.id); }} />
                <span class="text-xs truncate">{w.name}</span>
                <span class="badge badge-[10px] badge-ghost">{w.workflowType}</span>
              </label>
            {/each}
          </div>
          <div class="form-control mt-3">
            <label class="label"><span class="label-text text-xs">Action</span></label>
            <select class="select select-bordered select-sm" bind:value={bulkAction}>
              <option value="add">Add to workflows</option>
              <option value="remove">Remove from workflows</option>
              <option value="set">Set exactly (replace)</option>
            </select>
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => showLoraBulkModal=false}>Cancel</button>
        <button class="btn btn-primary" onclick={bulkUpdateWorkflows} disabled={savingWorkflow}>Apply to {bulkTargetWorkflowIds.length} workflows</button>
      </div>
    </div>
    <button class="modal-backdrop" type="button" onclick={() => showLoraBulkModal=false} aria-label="Close"></button>
  </div>
{/if}

<style>
  .stat {
    padding: 1rem;
  }
</style>
