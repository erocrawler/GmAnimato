<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import { _ } from 'svelte-i18n';
  
  let { data } = $props<{ data: PageData }>();
  
  let settings = $derived({
    ...(data.settings || {}),
    loraPresets: data.settings?.loraPresets ?? [],
    quotaPerDay: data.settings?.quotaPerDay ?? { "free-tier": 10, "gmgard-user": 50, "paid-tier": 100, "premium-tier": 100 },
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
  
  // Workflow editor modal state
  let showWorkflowModal = $state(false);
  let editingWorkflowId: string | null = $state(null);
  let workflowName = $state('');
  let workflowDescription = $state('');
  let workflowTemplatePath = $state('');
  let workflowIsDefault = $state(false);
  let workflowCompatibleLoras = $state<string[]>([]);
  
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
      .filter((p) => p && p.id && p.nodeId)
      .map((p) => ({
        id: p.id,
        label: p.label || p.id,
        nodeId: p.nodeId,
        default: Number(p.default ?? 1),
        min: p.min !== undefined ? Number(p.min) : 0,
        max: p.max !== undefined ? Number(p.max) : 1.5,
        step: p.step !== undefined ? Number(p.step) : 0.05,
        chain: p.chain === 'low' ? 'low' : 'high', // default to 'high' if missing or invalid
        isConfigurable: p.isConfigurable !== false, // default to true
        enabled: p.isConfigurable === false ? true : (p.enabled !== false), // default true for configurable, always true for base
      }));
  }
  
  // Role editor modal state
  let showRoleModal = $state(false);
  let editingUser: { id: string; username: string; roles: string[] } | null = $state(null);
  let roleInput = $state('');
  
  // Role config editor state
  let showRoleConfigModal = $state(false);
  let editingRoleIndex: number | null = $state(null);
  let editingRoleName = $state('');
  let editingRoleSponsorTier = $state('');
  let editingRoleDescription = $state('');
  let editingRoleQuota = $state('');
  
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
    showRoleModal = true;
  }
  
  async function saveUserRole() {
    if (!editingUser) return;
    
    const updatedRoles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    
    try {
      const response = await fetch(`/api/admin/users/${editingUser.id}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: updatedRoles }),
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

  function updateLoraPreset(index: number, field: string, value: string | number | boolean) {
    const list = [...(settings.loraPresets || [])];
    if (!list[index]) return;
    const preset = { ...list[index] } as any;
    if (['default', 'min', 'max', 'step'].includes(field)) {
      preset[field] = Number(value);
    } else if (field === 'enabled') {
      preset[field] = Boolean(value);
    } else {
      preset[field] = value;
    }
    list[index] = preset;
    settings = { ...settings, loraPresets: list };
  }
  
  function openWorkflowModal(workflow?: any) {
    if (workflow) {
      editingWorkflowId = workflow.id;
      workflowName = workflow.name;
      workflowDescription = workflow.description || '';
      workflowTemplatePath = workflow.templatePath;
      workflowIsDefault = workflow.isDefault;
      workflowCompatibleLoras = workflow.compatibleLoraIds || [];
    } else {
      editingWorkflowId = null;
      workflowName = '';
      workflowDescription = '';
      workflowTemplatePath = 'data/new_workflow.json.tmpl';
      workflowIsDefault = false;
      workflowCompatibleLoras = [];
    }
    showWorkflowModal = true;
  }
  
  function closeWorkflowModal() {
    showWorkflowModal = false;
    editingWorkflowId = null;
    workflowName = '';
    workflowDescription = '';
    workflowTemplatePath = '';
    workflowIsDefault = false;
    workflowCompatibleLoras = [];
  }
  
  function toggleLoraInModal(loraId: string) {
    if (workflowCompatibleLoras.includes(loraId)) {
      workflowCompatibleLoras = workflowCompatibleLoras.filter(id => id !== loraId);
    } else {
      workflowCompatibleLoras = [...workflowCompatibleLoras, loraId];
    }
  }
  
  async function saveWorkflow() {
    if (!workflowName.trim() || !workflowTemplatePath.trim()) {
      showNotification('Workflow name and template path are required', 'error');
      return;
    }
    
    savingWorkflow = true;
    try {
      if (editingWorkflowId) {
        // Update existing workflow
        const response = await fetch(`/api/admin/workflows/${editingWorkflowId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: workflowName.trim(),
            description: workflowDescription.trim() || undefined,
            templatePath: workflowTemplatePath.trim(),
            isDefault: workflowIsDefault,
            compatibleLoraIds: workflowCompatibleLoras,
          }),
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
            name: workflowName.trim(),
            description: workflowDescription.trim() || undefined,
            templatePath: workflowTemplatePath.trim(),
            isDefault: workflowIsDefault,
            compatibleLoraIds: workflowCompatibleLoras,
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
    if (!confirm(`Are you sure you want to delete workflow "${workflowName}"? This action cannot be undone.`)) {
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
  
  async function setDefaultWorkflow(workflowId: string) {
    try {
      const response = await fetch(`/api/admin/workflows/${workflowId}/default`, {
        method: 'POST',
      });
      
      if (response.ok) {
        // Update all workflows - unset default on others
        workflows = workflows.map(w => ({ ...w, isDefault: w.id === workflowId }));
        showNotification('Default workflow updated', 'success');
      } else {
        const error = await response.json();
        showNotification(`Failed to set default: ${error.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showNotification(`Error: ${String(err)}`, 'error');
    }
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
    <div class="toast toast-top toast-end">
      <div class="alert" class:alert-success={toastType === 'success'} class:alert-error={toastType === 'error'} class:alert-info={toastType === 'info'}>
        <span>{toastMessage}</span>
      </div>
    </div>
  {/if}
  
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
          <label class="label" for="max-concurrent">
            <span class="label-text">Max Concurrent Jobs</span>
          </label>
          <input id="max-concurrent" type="number" bind:value={settings.maxConcurrentJobs} class="input input-bordered" min="1" />
        </div>
        
        <div class="form-control">
          <label class="label" for="max-queue">
            <span class="label-text">Max Queue Threshold</span>
          </label>
          <input id="max-queue" type="number" bind:value={settings.maxQueueThreshold} class="input input-bordered" min="100" />
        </div>
        
        <div class="form-control">
          <label class="label" for="local-queue-threshold">
            <span class="label-text">Local Queue Threshold</span>
            <span class="label-text-alt text-xs opacity-70">(0 = disabled, >0 = enabled)</span>
          </label>
          <input id="local-queue-threshold" type="number" bind:value={settings.localQueueThreshold} class="input input-bordered" min="0" />
        </div>
      </div>
      
      <p class="text-xs opacity-60 mt-3">Jobs are routed to local workers when queue is below this threshold</p>
      
      <div class="divider">Sponsor API Configuration</div>
      
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
      </div>
      
      <p class="text-xs opacity-60 mt-3">Used for sponsor claim validation and daily revalidation. Environment variables will be used as fallback if not set.</p>
      
      <div class="card-actions justify-end mt-4">
        <button class="btn btn-primary" onclick={saveSettings} disabled={saving}>
          {saving ? $_('admin.settings.saving') : $_('admin.settings.save')}
        </button>
      </div>
    </div>
  </div>

  <!-- Workflow Management -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <div class="flex items-center justify-between mb-2">
        <h2 class="card-title text-2xl">Workflow Management</h2>
        <button class="btn btn-primary btn-sm" onclick={() => openWorkflowModal()}>+ Add Workflow</button>
      </div>
      <p class="text-sm opacity-70 mb-4">Configure workflows and their compatible LoRAs. Users will only see compatible LoRAs when they select a workflow.</p>

      {#if workflows && workflows.length > 0}
        <div class="space-y-6">
          {#each workflows as workflow}
            <div class="card bg-base-100 shadow">
              <div class="card-body">
                <div class="flex items-start justify-between mb-4">
                  <div>
                    <h3 class="text-lg font-bold">{workflow.name}</h3>
                    {#if workflow.description}
                      <p class="text-sm opacity-70">{workflow.description}</p>
                    {/if}
                    <p class="text-xs opacity-60 mt-1">Template: {workflow.templatePath}</p>
                    {#if workflow.isDefault}
                      <span class="badge badge-primary badge-sm mt-2">Default</span>
                    {/if}
                  </div>
                  <div class="flex gap-2">
                    {#if !workflow.isDefault}
                      <button 
                        class="btn btn-xs btn-outline"
                        onclick={() => setDefaultWorkflow(workflow.id)}
                      >
                        Set Default
                      </button>
                    {/if}
                    <button 
                      class="btn btn-xs btn-outline"
                      onclick={() => openWorkflowModal(workflow)}
                    >
                      Edit
                    </button>
                    <button 
                      class="btn btn-xs btn-outline btn-error"
                      onclick={() => deleteWorkflow(workflow.id, workflow.name)}
                      disabled={workflow.isDefault}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                
                <div class="mt-2">
                  <span class="text-sm opacity-70">Compatible LoRAs: </span>
                  <span class="font-semibold">{workflow.compatibleLoraIds?.length || 0}</span>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-base-content/70">No workflows found. Run database migrations to create workflows.</p>
      {/if}
    </div>
  </div>

  <!-- LoRA Presets -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <div class="flex items-center justify-between mb-2">
        <h2 class="card-title text-2xl">{$_('admin.settings.loraPresets')}</h2>
        <button class="btn btn-sm btn-outline" onclick={addLoraPreset}>{$_('admin.settings.addPreset')}</button>
      </div>
      <p class="text-sm opacity-70 mb-4">Manage available LoRAs and their default weights used in generation.</p>

      {#if settings.loraPresets && settings.loraPresets.length > 0}
        <div class="mb-4 text-sm text-base-content/70">
          <strong>Note:</strong> Base LoRAs (Light X2V) are always required and cannot be removed. Dynamic LoRAs are chained automatically per group.
        </div>
        <div class="overflow-x-auto">
          <table class="table table-zebra whitespace-normal">
            <thead>
              <tr>
                <th style="min-width: 220px;">ID / Filename</th>
                <th style="min-width: 200px;">Label</th>
                <th style="min-width: 120px;">Chain</th>
                <th style="width: 40px;">Default</th>
                <th style="width: 40px;">Min</th>
                <th style="width: 40px;">Max</th>
                <th style="width: 40px;">Step</th>
                <th style="width: 80px;">Configurable</th>
              </tr>
            </thead>
            <tbody>
              {#each settings.loraPresets as preset, i}
                <tr class:opacity-60={!preset.isConfigurable}>
                  <td style="max-width: 260px; word-break: break-all; white-space: normal;">
                    {#if preset.isConfigurable}
                      <input
                        type="text"
                        class="input input-bordered w-full"
                        value={preset.id}
                        oninput={(e) => updateLoraPreset(i, 'id', e.currentTarget.value)}
                        placeholder="lora-file.safetensors"
                        style="word-break: break-all; white-space: normal;"
                      />
                    {:else}
                      <span class="font-mono text-sm break-all" style="word-break: break-all; white-space: normal;">{preset.id}</span>
                      <span class="badge badge-sm badge-ghost ml-2">base</span>
                    {/if}
                  </td>
                  <td>
                    {#if preset.isConfigurable}
                      <input
                        type="text"
                        class="input input-bordered w-full"
                        value={preset.label}
                        oninput={(e) => updateLoraPreset(i, 'label', e.currentTarget.value)}
                        placeholder="Display name"
                      />
                    {:else}
                      {preset.label}
                    {/if}
                  </td>
                  <td>
                    {#if preset.isConfigurable}
                      <select
                        class="select select-bordered select-sm w-full max-w-[140px]"
                        value={preset.chain}
                        onchange={(e) => updateLoraPreset(i, 'chain', e.currentTarget.value)}
                      >
                        <option value="high">High</option>
                        <option value="low">Low</option>
                      </select>
                    {:else}
                      <span class="text-sm capitalize">{preset.chain}</span>
                    {/if}
                  </td>
                  <td>
                    {#if preset.isConfigurable}
                      <input
                        type="number"
                        class="input input-bordered w-16"
                        value={preset.default}
                        min="0"
                        step="0.01"
                        oninput={(e) => updateLoraPreset(i, 'default', Number(e.currentTarget.value))}
                      />
                    {:else}
                      {preset.default}
                    {/if}
                  </td>
                  <td>
                    {#if preset.isConfigurable}
                      <input
                        type="number"
                        class="input input-bordered w-12"
                        value={preset.min ?? 0}
                        step="0.01"
                        oninput={(e) => updateLoraPreset(i, 'min', Number(e.currentTarget.value))}
                      />
                    {:else}
                      {preset.min ?? 0}
                    {/if}
                  </td>
                  <td>
                    {#if preset.isConfigurable}
                      <input
                        type="number"
                        class="input input-bordered w-12"
                        value={preset.max ?? 1.5}
                        step="0.01"
                        oninput={(e) => updateLoraPreset(i, 'max', Number(e.currentTarget.value))}
                      />
                    {:else}
                      {preset.max ?? 1.5}
                    {/if}
                  </td>
                  <td>
                    {#if preset.isConfigurable}
                      <input
                        type="number"
                        class="input input-bordered w-12"
                        value={preset.step ?? 0.05}
                        step="0.01"
                        min="0.001"
                        oninput={(e) => updateLoraPreset(i, 'step', Number(e.currentTarget.value))}
                      />
                    {:else}
                      {preset.step ?? 0.05}
                    {/if}
                  </td>
                <td class="align-middle text-center">
                  <label class="flex items-center gap-2 justify-center">
                    <input type="checkbox" class="toggle toggle-primary toggle-xs" checked={preset.isConfigurable !== false} onchange={(e) => updateLoraPreset(i, 'isConfigurable', e.currentTarget.checked ? true : false)} />
                  </label>
                </td>
                </tr>
                {#if preset.isConfigurable}
                  <tr class:opacity-60={!preset.isConfigurable}>
                    <td colspan="6">
                      <label class="flex items-center gap-2 mt-1">
                        <input type="checkbox" class="toggle toggle-primary toggle-xs" checked={preset.enabled !== false} onchange={(e) => updateLoraPreset(i, 'enabled', e.currentTarget.checked ? true : false)} />
                        <span class="text-xs select-none">Enabled by default</span>
                      </label>
                    </td>
                  <td colspan="2">
                    <button class="btn btn-xs btn-outline btn-error ml-2" onclick={() => removeLoraPreset(i)}>Remove</button>
                  </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="text-base-content/70">No LoRAs configured yet. Click "Add LoRA" to create one.</p>
      {/if}
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
          <div class="mb-4">
            <h3 class="text-lg font-semibold mb-3">Local Queue Status</h3>
            
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title text-xs">In Queue</div>
                <div class="stat-value text-lg text-warning">{queueStatus.localQueue.inQueue || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title text-xs">Processing</div>
                <div class="stat-value text-lg text-info">{queueStatus.localQueue.processing || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title text-xs">Completed</div>
                <div class="stat-value text-lg text-success">{queueStatus.localQueue.completed || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title text-xs">Failed</div>
                <div class="stat-value text-lg text-error">{queueStatus.localQueue.failed || 0}</div>
              </div>
            </div>
          </div>
          <div class="mb-4">
            <div class="alert" class:alert-success={queueStatus.localQueue.enabled} class:alert-warning={!queueStatus.localQueue.enabled}>
              <span>
                Status: {queueStatus.localQueue.enabled ? '✓ Enabled' : '⚠ Disabled'}
                <br /><small>Threshold: {queueStatus.localQueue.threshold}</small>
              </span>
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
                      <span class="badge badge-sm" class:badge-primary={role === 'admin'} class:badge-success={role === 'paid-tier'}>
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
          placeholder="e.g., premium-tier, sponsor-tier"
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
      
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={closeRoleConfigModal}>Cancel</button>
        <button class="btn btn-primary" onclick={saveRoleConfig}>Save</button>
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
    <div class="modal-box max-w-4xl">
      <h3 class="font-bold text-lg mb-4">
        {editingWorkflowId ? 'Edit Workflow' : 'Add New Workflow'}
      </h3>
      
      <div class="form-control mb-4">
        <label class="label" for="workflow-name">
          <span class="label-text">Workflow Name</span>
        </label>
        <input 
          id="workflow-name"
          type="text" 
          bind:value={workflowName}
          placeholder="e.g., WAN 2.2, Dasiwa 1.0"
          class="input input-bordered w-full"
        />
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="workflow-description">
          <span class="label-text">Description</span>
        </label>
        <textarea 
          id="workflow-description"
          bind:value={workflowDescription}
          placeholder="Brief description of this workflow"
          class="textarea textarea-bordered w-full"
          rows="2"
        ></textarea>
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="workflow-template">
          <span class="label-text">Template Path</span>
          <span class="label-text-alt">Relative to project root</span>
        </label>
        <input 
          id="workflow-template"
          type="text" 
          bind:value={workflowTemplatePath}
          placeholder="data/workflow_template.json.tmpl"
          class="input input-bordered w-full font-mono text-sm"
        />
      </div>
      
      <div class="form-control mb-4">
        <label class="label cursor-pointer justify-start gap-3" for="workflow-default">
          <input 
            id="workflow-default"
            type="checkbox" 
            bind:checked={workflowIsDefault}
            class="checkbox checkbox-primary"
          />
          <div>
            <span class="label-text font-semibold">Set as Default Workflow</span>
            <p class="text-xs opacity-70">New videos will use this workflow if not specified</p>
          </div>
        </label>
      </div>
      
      <div class="divider">Compatible LoRAs</div>
      
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-96 overflow-y-auto p-2 border border-base-300 rounded-lg">
        {#each (settings.loraPresets || []) as lora}
          <label class="flex items-center gap-2 p-2 rounded hover:bg-base-200 cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-primary checkbox-sm"
              checked={workflowCompatibleLoras.includes(lora.id)}
              onchange={() => toggleLoraInModal(lora.id)}
            />
            <div class="flex-1 min-w-0">
              <span class="text-sm truncate block">{lora.label}</span>
              <span class="badge badge-xs badge-ghost">{lora.chain}</span>
            </div>
          </label>
        {/each}
      </div>
      
      <div class="text-xs opacity-60 mt-2">
        Selected: {workflowCompatibleLoras.length} LoRAs
      </div>
      
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={closeWorkflowModal} disabled={savingWorkflow}>Cancel</button>
        <button class="btn btn-primary" onclick={saveWorkflow} disabled={savingWorkflow}>
          {savingWorkflow ? 'Saving...' : (editingWorkflowId ? 'Update' : 'Create')}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" type="button" onclick={closeWorkflowModal} aria-label="Close modal"></button>
  </div>
{/if}

<style>
  .stat {
    padding: 1rem;
  }
</style>
